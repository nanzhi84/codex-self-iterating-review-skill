#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_ROUNDS = 6;
const MAX_ALLOWED_ROUNDS = 12;
const DEFAULT_MODE = "auto";
const DEFAULT_STOP_CONDITION = "current-clean";
const DEFAULT_FOCUS = ["correctness", "regression", "security"];
const DEFAULT_CODEX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TEST_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CHILD_REASONING_EFFORT = "medium";
const DEFAULT_SEARCH = true;
const DISCOVERED_TEST_COMMAND_LIMIT = 4;
const AUTO_SLICE_MAX_FILES = 18;
const AUTO_SLICE_MAX_CHANGED_LINES = 900;
const DIFF_CONTEXT_CHAR_LIMIT = 60_000;
const BINARY_FILE_CHANGED_LINE_FALLBACK = 50;
const CHILD_FORCE_KILL_GRACE_MS = 5_000;
const WINDOWS_REVIEW_SANDBOX = "workspace-write";
const DEFAULT_REVIEW_SANDBOX = "read-only";
const LOG_PREFIX = "[self-iterating-review]";
const OUTPUT_TAIL_LIMIT = 4000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const RUNS_ROOT = path.join(CODEX_HOME, "tmp", "self-iterating-review");
const REVIEW_SCHEMA_PATH = path.join(SCRIPT_DIR, "review-output.schema.json");
const FIX_SCHEMA_PATH = path.join(SCRIPT_DIR, "fix-output.schema.json");
const CODEX_INVOCATION = resolveCodexInvocation();
const CODEX_EXEC_CAPABILITIES = detectCodexExecCapabilities();
let windowsTestShell = null;
let searchFlagWarningPrinted = false;

async function main() {
  const context = {
    runState: null,
  };

  try {
    const finalReport = await runLoop(context);
    process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  } catch (error) {
    const failureReport = buildFailureReport(error, context.runState);
    process.stdout.write(`${JSON.stringify(failureReport, null, 2)}\n`);
    process.exitCode = 1;
  }
}

async function runLoop(context) {
  const config = parseArgs(process.argv.slice(2));
  ensureFileExists(REVIEW_SCHEMA_PATH, "Missing review schema");
  ensureFileExists(FIX_SCHEMA_PATH, "Missing fix schema");

  const repoRoot = getGitRepoRoot(config.repoPath);
  config.paths = normalizeScopePaths(config.paths, repoRoot);
  const repoName = path.basename(repoRoot);
  const initialStatus = getGitStatus(repoRoot);
  const resolvedBase = resolveScopeBaseRef(repoRoot, config.scope);
  config.requestedMode = config.mode;
  config.mode = resolveExecutionMode(config.mode, {
    repoRoot,
    initialStatus,
  });

  if (config.mode === "worktree" && initialStatus.trim() !== "") {
    fail("`--mode worktree` requires a clean repository because uncommitted changes are not copied into the detached worktree.");
  }

  config.testPlan = resolveTestPlan(config, repoRoot);

  const runId = buildRunId(repoName);
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const testPlanPath = path.join(runDir, "test-plan.json");
  writeJson(testPlanPath, config.testPlan);

  const target = config.planOnly
    ? { cwd: repoRoot, worktreePath: null }
    : prepareTargetWorkspace({
        config,
        repoRoot,
        runDir,
      });

  validateTestCommandsForTargetWorkspace(config.tests, {
    mode: config.mode,
    repoRoot,
    targetCwd: target.cwd,
  });

  const reviewSlices = buildReviewSlices({
    config,
    repoRoot,
    resolvedBase,
    allowAutoSlicing: initialStatus.trim() === "" && config.paths.length === 0,
  });

  const runState = {
    runId,
    repoName,
    repoRoot,
    targetCwd: target.cwd,
    worktreePath: target.worktreePath,
    runDir,
    config,
    baselineTests: [],
    rounds: [],
    slices: [],
    allFindingsByFingerprint: new Map(),
    finalActiveFindings: [],
    worktreeCommit: null,
    finalStatus: "unknown",
    stopReason: "unknown",
    resolvedBaseRef: resolvedBase?.resolvedRef ?? null,
    slicePlan: reviewSlices.map(serializeSlicePlan),
    globalRoundCounter: 0,
    artifactPaths: {
      runDir,
      reviewSchema: REVIEW_SCHEMA_PATH,
      fixSchema: FIX_SCHEMA_PATH,
      testPlan: testPlanPath,
    },
  };

  context.runState = runState;

  log(`Run directory: ${runDir}`);
  log(`Target workspace: ${runState.targetCwd}`);
  if (runState.resolvedBaseRef) {
    log(`Resolved branch base: ${runState.resolvedBaseRef}`);
  }
  if (reviewSlices.length > 1) {
    log(`Auto-sliced review into ${reviewSlices.length} scope(s).`);
  }
  if (config.tests.length > 0) {
    log(`Using ${config.tests.length} test command(s) from ${config.testPlan.source}.`);
  } else {
    log("No test commands were provided or discovered; continuing with review-only verification.");
  }

  if (config.planOnly) {
    return buildPlanOnlyReport(runState);
  }

  if (config.tests.length > 0) {
    log("Running baseline tests before the review loop.");
    runState.baselineTests = runTests(
      config.tests,
      runState.targetCwd,
      path.join(runDir, "baseline-tests"),
      config.testTimeoutMs,
    );
  }

  for (const slice of reviewSlices) {
    const sliceResult = await runSliceLoop({
      config,
      runState,
      slice,
    });
    runState.slices.push(sliceResult);
  }

  runState.finalActiveFindings = deduplicateFindings(
    runState.slices.flatMap((slice) => slice.finalActiveFindings),
  );
  runState.stopReason =
    runState.finalActiveFindings.length === 0
      ? "clean"
      : runState.finalActiveFindings.some((finding) => finding.requiresBusinessConfirmation)
        ? "blocked-by-business-questions"
      : "completed-with-findings";
  runState.finalStatus = deriveFinalStatus(
    runState.stopReason,
    runState.finalActiveFindings,
  );
  finalizeFindingLedger(runState.allFindingsByFingerprint, runState.finalActiveFindings);
  runState.worktreeCommit = createWorktreeCommitIfNeeded(runState);

  log(`Finished with status '${runState.finalStatus}'.`);
  return buildFinalReport(runState);
}

function parseArgs(argv) {
  const config = {
    scope: "",
    repoPath: process.cwd(),
    mode: DEFAULT_MODE,
    maxRounds: DEFAULT_MAX_ROUNDS,
    stopCondition: DEFAULT_STOP_CONDITION,
    tests: [],
    paths: [],
    focus: [...DEFAULT_FOCUS],
    extraInstructions: [],
    model: "",
    allowNoTests: false,
    planOnly: false,
    search: DEFAULT_SEARCH,
    codexTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
    testPlan: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--scope":
        config.scope = readRequiredValue(argv, ++index, "--scope");
        break;
      case "--repo":
        config.repoPath = path.resolve(readRequiredValue(argv, ++index, "--repo"));
        break;
      case "--mode":
        config.mode = readRequiredValue(argv, ++index, "--mode");
        break;
      case "--max-rounds":
        config.maxRounds = Number.parseInt(readRequiredValue(argv, ++index, "--max-rounds"), 10);
        break;
      case "--stop-condition":
        config.stopCondition = readRequiredValue(argv, ++index, "--stop-condition");
        break;
      case "--test":
        config.tests.push(readRequiredValue(argv, ++index, "--test"));
        break;
      case "--path":
        config.paths.push(readRequiredValue(argv, ++index, "--path"));
        break;
      case "--focus":
        config.focus.push(readRequiredValue(argv, ++index, "--focus"));
        break;
      case "--extra-instruction":
        config.extraInstructions.push(readRequiredValue(argv, ++index, "--extra-instruction"));
        break;
      case "--model":
        config.model = readRequiredValue(argv, ++index, "--model");
        break;
      case "--codex-timeout-ms":
        config.codexTimeoutMs = Number.parseInt(readRequiredValue(argv, ++index, "--codex-timeout-ms"), 10);
        break;
      case "--test-timeout-ms":
        config.testTimeoutMs = Number.parseInt(readRequiredValue(argv, ++index, "--test-timeout-ms"), 10);
        break;
      case "--allow-no-tests":
        config.allowNoTests = true;
        break;
      case "--plan-only":
        config.planOnly = true;
        break;
      case "--search":
        config.search = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  validateConfig(config);
  config.focus = normalizeDistinctStrings(config.focus);
  config.paths = normalizeDistinctStrings(config.paths.map((item) => path.normalize(item)));
  config.tests = normalizeDistinctStrings(config.tests);
  config.extraInstructions = normalizeDistinctStrings(config.extraInstructions);
  return config;
}

function validateConfig(config) {
  if (!config.scope.trim()) {
    fail("Missing required `--scope`.");
  }

  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > MAX_ALLOWED_ROUNDS) {
    fail(`\`--max-rounds\` must be an integer between 1 and ${MAX_ALLOWED_ROUNDS}.`);
  }

  if (!["auto", "in-place", "worktree"].includes(config.mode)) {
    fail("`--mode` must be `auto`, `in-place`, or `worktree`.");
  }

  if (!["current-clean", "no-new-p1p2"].includes(config.stopCondition)) {
    fail("`--stop-condition` must be either `current-clean` or `no-new-p1p2`.");
  }

  if (!Number.isInteger(config.codexTimeoutMs) || config.codexTimeoutMs < 10000) {
    fail("`--codex-timeout-ms` must be an integer greater than or equal to 10000.");
  }

  if (!Number.isInteger(config.testTimeoutMs) || config.testTimeoutMs < 10000) {
    fail("`--test-timeout-ms` must be an integer greater than or equal to 10000.");
  }
}

function printHelp() {
  const lines = [
    "Usage:",
    "  node review_loop.mjs --scope <text> --test <command> [options]",
    "",
    "Required:",
    "  --scope <text>              Review boundary in one concrete sentence",
    "  --test <command>            Repeatable test command; auto-discovered when omitted",
    "",
    "Options:",
    "  --repo <path>               Repository path (default: current directory)",
    "  --mode <auto|in-place|worktree>  Execution mode (default: auto)",
    "  --max-rounds <n>            Maximum review rounds (default: 6)",
    "  --stop-condition <value>    current-clean or no-new-p1p2",
    "  --path <path>               Hard path boundary, repeatable",
    "  --focus <text>              Extra review focus, repeatable",
    "  --extra-instruction <text>  Extra instruction for review and fix prompts",
    "  --model <name>              Optional model override for codex exec",
    `  --codex-timeout-ms <ms>     Per-run timeout for codex exec (default: ${DEFAULT_CODEX_TIMEOUT_MS})`,
    `  --test-timeout-ms <ms>      Per-command test timeout (default: ${DEFAULT_TEST_TIMEOUT_MS})`,
    "  --search                    Request live web search in codex exec when supported (default: requested)",
    "  --allow-no-tests            Skip automatic test discovery",
    "  --plan-only                 Print the resolved base + auto-slice plan without launching Codex",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveTestPlan(config, repoRoot) {
  if (config.tests.length > 0) {
    return {
      source: "explicit",
      confidence: "high",
      commands: config.tests,
      notes: ["Using test commands provided with --test."],
    };
  }

  if (config.allowNoTests) {
    return {
      source: "disabled",
      confidence: "none",
      commands: [],
      notes: ["--allow-no-tests was set, so automatic test discovery was skipped."],
    };
  }

  const discoveredPlan = discoverTestCommands(repoRoot);
  config.tests = normalizeDistinctStrings(discoveredPlan.commands).slice(0, DISCOVERED_TEST_COMMAND_LIMIT);

  return {
    ...discoveredPlan,
    commands: config.tests,
  };
}

function discoverTestCommands(repoRoot) {
  const candidates = [];
  const notes = [];
  const seenCommands = new Set();

  function addCandidate(command, confidence, reason) {
    const normalizedCommand = normalizeWhitespace(command);
    if (!normalizedCommand || seenCommands.has(normalizedCommand)) {
      return;
    }

    seenCommands.add(normalizedCommand);
    candidates.push({
      command: normalizedCommand,
      confidence,
      reason,
    });
  }

  discoverNodeTestCommands(repoRoot, addCandidate, notes);
  discoverPythonTestCommands(repoRoot, addCandidate, notes);
  discoverGoTestCommands(repoRoot, addCandidate, notes);
  discoverRustTestCommands(repoRoot, addCandidate, notes);
  discoverDotnetTestCommands(repoRoot, addCandidate, notes);
  discoverMakeTestCommands(repoRoot, addCandidate, notes);

  const commands = candidates.map((candidate) => candidate.command);
  const confidence = candidates.some((candidate) => candidate.confidence === "high")
    ? "high"
    : candidates.length > 0
      ? "medium"
      : "none";

  if (commands.length === 0) {
    notes.push("No common test command was discovered from repository metadata.");
  }

  return {
    source: "auto-discovered",
    confidence,
    commands,
    candidates,
    notes,
  };
}

function discoverNodeTestCommands(repoRoot, addCandidate, notes) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = readJsonFile(packageJsonPath);
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const packageManager = detectPackageManager(repoRoot);
  const scriptNames = ["test", "lint", "typecheck", "check"];

  for (const scriptName of scriptNames) {
    if (!isUsefulPackageScript(scripts[scriptName])) {
      continue;
    }

    addCandidate(
      buildPackageScriptCommand(packageManager, scriptName),
      scriptName === "test" ? "high" : "medium",
      `package.json script "${scriptName}"`,
    );
  }

  if (Object.keys(scripts).length === 0) {
    notes.push("package.json exists but does not define scripts.");
  }
}

function discoverPythonTestCommands(repoRoot, addCandidate) {
  const hasPytestConfig =
    fs.existsSync(path.join(repoRoot, "pytest.ini")) ||
    fs.existsSync(path.join(repoRoot, "tox.ini")) ||
    fs.existsSync(path.join(repoRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(repoRoot, "setup.cfg"));

  if (hasPytestConfig) {
    addCandidate("python -m pytest", "high", "Python test configuration");
  }
}

function discoverGoTestCommands(repoRoot, addCandidate) {
  if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
    addCandidate("go test ./...", "high", "go.mod");
  }
}

function discoverRustTestCommands(repoRoot, addCandidate) {
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
    addCandidate("cargo test", "high", "Cargo.toml");
  }
}

function discoverDotnetTestCommands(repoRoot, addCandidate) {
  const rootFiles = listRootFiles(repoRoot);
  if (rootFiles.some((fileName) => fileName.endsWith(".sln") || fileName.endsWith(".csproj"))) {
    addCandidate("dotnet test", "high", ".NET project file");
  }
}

function discoverMakeTestCommands(repoRoot, addCandidate) {
  const makefilePath = path.join(repoRoot, "Makefile");
  if (fs.existsSync(makefilePath) && /^test\s*:/m.test(readTextFile(makefilePath))) {
    addCandidate("make test", "medium", "Makefile test target");
  }

  const justfilePath = path.join(repoRoot, "justfile");
  if (fs.existsSync(justfilePath) && /^test\s*:/m.test(readTextFile(justfilePath))) {
    addCandidate("just test", "medium", "justfile test recipe");
  }
}

function detectPackageManager(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml")) || fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }

  if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }

  if (fs.existsSync(path.join(repoRoot, "bun.lockb")) || fs.existsSync(path.join(repoRoot, "bun.lock"))) {
    return "bun";
  }

  return "npm";
}

function buildPackageScriptCommand(packageManager, scriptName) {
  if (scriptName === "test") {
    if (packageManager === "bun") {
      return "bun run test";
    }

    return `${packageManager} test`;
  }

  return `${packageManager} run ${scriptName}`;
}

function isUsefulPackageScript(script) {
  if (typeof script !== "string" || !script.trim()) {
    return false;
  }

  const normalizedScript = script.toLowerCase();
  return !(
    normalizedScript.includes("no test specified") ||
    normalizedScript.includes("echo") && normalizedScript.includes("exit 1")
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listRootFiles(repoRoot) {
  try {
    return fs.readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function prepareTargetWorkspace({ config, repoRoot, runDir }) {
  if (config.mode === "in-place") {
    return { cwd: repoRoot, worktreePath: null };
  }

  const worktreePath = path.join(CODEX_HOME, "worktrees", "self-iterating-review", `${path.basename(repoRoot)}-${Date.now()}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const result = runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repoRoot });
  if (result.status !== 0) {
    fail(`Failed to create detached worktree.\n${formatCommandFailure(result)}`);
  }
  fs.writeFileSync(path.join(runDir, "worktree-path.txt"), `${worktreePath}\n`, "utf8");
  return { cwd: worktreePath, worktreePath };
}

function resolveExecutionMode(mode, { repoRoot, initialStatus }) {
  if (mode !== "auto") {
    return mode;
  }

  if (isLinkedWorktree(repoRoot) || initialStatus.trim() !== "") {
    return "in-place";
  }

  return "worktree";
}

function isLinkedWorktree(repoRoot) {
  const gitDirResult = runProcess("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd: repoRoot,
  });
  if (gitDirResult.status !== 0) {
    fail(`Failed to read Git directory for ${repoRoot}.\n${formatCommandFailure(gitDirResult)}`);
  }

  const commonDirResult = runProcess("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot,
  });
  if (commonDirResult.status !== 0) {
    fail(`Failed to read Git common directory for ${repoRoot}.\n${formatCommandFailure(commonDirResult)}`);
  }

  return normalizeComparablePath(gitDirResult.stdout) !== normalizeComparablePath(commonDirResult.stdout);
}

async function runSliceLoop({ config, runState, slice }) {
  const sliceDir = path.join(runState.runDir, slice.id);
  fs.mkdirSync(sliceDir, { recursive: true });

  let stopReason = null;
  let finalActiveFindings = [];
  let previousFailedTests = runState.baselineTests.filter((test) => test.status !== "passed");
  const rounds = [];

  for (let roundNumber = 1; roundNumber <= config.maxRounds; roundNumber += 1) {
    const globalRoundNumber = runState.globalRoundCounter + 1;
    runState.globalRoundCounter = globalRoundNumber;

    const roundDir = path.join(
      sliceDir,
      `round-${String(roundNumber).padStart(2, "0")}`,
    );
    fs.mkdirSync(roundDir, { recursive: true });

    log(
      `Slice ${slice.label}: review round ${roundNumber} starting.`,
    );
    const reviewResult = await runReviewRound({
      config,
      slice,
      roundNumber,
      globalRoundNumber,
      roundDir,
      targetCwd: runState.targetCwd,
      previousFailedTests,
    });

    const currentFindings = reviewResult.findings;
    const activeFindings = currentFindings.filter(
      (finding) => !finding.requiresBusinessConfirmation,
    );
    const blockedFindings = currentFindings.filter(
      (finding) => finding.requiresBusinessConfirmation,
    );
    updateFindingLedger(
      runState.allFindingsByFingerprint,
      currentFindings,
      globalRoundNumber,
    );

    const roundRecord = {
      sliceId: slice.id,
      sliceLabel: slice.label,
      round: roundNumber,
      globalRound: globalRoundNumber,
      review: reviewResult,
      activeFindings,
      blockedFindings,
      newFindings: activeFindings.filter(
        (finding) => finding.firstSeenRound === globalRoundNumber,
      ),
      fix: null,
      tests: [],
    };

    rounds.push(roundRecord);
    runState.rounds.push(roundRecord);
    finalActiveFindings = currentFindings;

    if (activeFindings.length === 0 && blockedFindings.length === 0 && previousFailedTests.length === 0) {
      stopReason = "clean";
      break;
    }

    if (activeFindings.length === 0 && blockedFindings.length === 0 && previousFailedTests.length > 0) {
      if (roundNumber === config.maxRounds) {
        stopReason = "max-rounds";
        break;
      }

      log(`Slice ${slice.label}: re-running previously failed tests before stopping.`);
      roundRecord.tests = runTests(
        config.tests,
        runState.targetCwd,
        path.join(roundDir, "tests"),
        config.testTimeoutMs,
      );
      previousFailedTests = roundRecord.tests.filter((test) => test.status !== "passed");
      if (previousFailedTests.length === 0) {
        stopReason = "clean";
        break;
      }
      continue;
    }

    if (activeFindings.length === 0 && blockedFindings.length > 0) {
      stopReason = "blocked-by-business-questions";
      break;
    }

    if (
      config.stopCondition === "no-new-p1p2" &&
      roundRecord.newFindings.length === 0
    ) {
      stopReason = "no-new-p1p2";
      break;
    }

    if (roundNumber === config.maxRounds) {
      stopReason = "max-rounds";
      break;
    }

    log(
      `Slice ${slice.label}: fixing ${activeFindings.length} active finding(s).`,
    );
    roundRecord.fix = await runFixRound({
      config,
      slice,
      roundNumber,
      globalRoundNumber,
      roundDir,
      targetCwd: runState.targetCwd,
      activeFindings,
      baselineTests: runState.baselineTests,
      previousFailedTests,
    });

    if (config.tests.length > 0) {
      log(`Slice ${slice.label}: running post-fix tests.`);
      roundRecord.tests = runTests(
        config.tests,
        runState.targetCwd,
        path.join(roundDir, "tests"),
        config.testTimeoutMs,
      );
      previousFailedTests = roundRecord.tests.filter((test) => test.status !== "passed");
    }
  }

  return {
    id: slice.id,
    label: slice.label,
    scope: slice.scope,
    paths: slice.paths,
    baseRef: slice.baseRef,
    diff: slice.diff,
    stopReason: stopReason || "max-rounds",
    finalActiveFindings,
    rounds,
  };
}

async function runReviewRound({
  config,
  slice,
  roundNumber,
  globalRoundNumber,
  roundDir,
  targetCwd,
  previousFailedTests,
}) {
  const outputPath = path.join(roundDir, "review-output.json");
  const initialWorkspaceSnapshot = getGitWorkspaceSnapshot(targetCwd);
  const prompt = buildReviewPrompt({
    config,
    slice,
    roundNumber,
    globalRoundNumber,
    previousFailedTests,
  });
  const parsed = await runReviewCodexStructured({
    cwd: targetCwd,
    schemaPath: REVIEW_SCHEMA_PATH,
    outputPath,
    prompt,
    model: config.model,
    search: config.search,
    timeoutMs: config.codexTimeoutMs,
    phase: "review",
    roundNumber,
  });
  assertReviewDidNotModifyWorkspace(targetCwd, initialWorkspaceSnapshot, {
    outputPath,
    roundNumber,
  });

  const findings = deduplicateFindings(
    (parsed.findings || []).map((finding) => normalizeFinding(finding, targetCwd)),
  );

  const businessQuestions = [
    ...normalizeBusinessQuestions(parsed.business_questions || [], targetCwd),
    ...buildFindingBusinessQuestions(findings),
  ];

  return {
    outputPath,
    roundSummary: parsed.round_summary || "",
    findings,
    businessQuestions: deduplicateBusinessQuestions(businessQuestions),
  };
}

async function runFixRound({
  config,
  slice,
  roundNumber,
  globalRoundNumber,
  roundDir,
  targetCwd,
  activeFindings,
  baselineTests,
  previousFailedTests,
}) {
  const outputPath = path.join(roundDir, "fix-output.json");
  const prompt = buildFixPrompt({
    config,
    slice,
    roundNumber,
    globalRoundNumber,
    activeFindings,
    baselineTests,
    previousFailedTests,
  });

  return runCodexStructured({
    cwd: targetCwd,
    sandbox: "workspace-write",
    schemaPath: FIX_SCHEMA_PATH,
    outputPath,
    prompt,
    model: config.model,
    search: config.search,
    timeoutMs: config.codexTimeoutMs,
    phase: "fix",
    roundNumber,
  });
}

async function runCodexStructured({
  cwd,
  sandbox,
  schemaPath,
  outputPath,
  prompt,
  model,
  search,
  timeoutMs,
  phase,
  roundNumber,
}) {
  const stdoutPath = outputPath.replace(/\.json$/i, ".stdout.log");
  const stderrPath = outputPath.replace(/\.json$/i, ".stderr.log");
  const searchFlagPosition = search ? CODEX_EXEC_CAPABILITIES.searchFlagPosition : null;

  if (search && !searchFlagPosition) {
    warnSearchFlagUnsupported();
  }

  const args = [
    ...CODEX_INVOCATION.baseArgs,
    ...(searchFlagPosition === "global" ? ["--search"] : []),
    "exec",
    ...(searchFlagPosition === "exec" ? ["--search"] : []),
    "-",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    "shell_environment_policy.use_profile=false",
    "-c",
    "mcp_servers={}",
    "-c",
    `model_reasoning_effort="${DEFAULT_CHILD_REASONING_EFFORT}"`,
    "-c",
    "plugins={}",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.shell_snapshot=false",
    "--sandbox",
    sandbox,
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    "-C",
    cwd,
  ];

  if (model) {
    args.push("--model", model);
  }

  const result = await runProcessAsync(CODEX_INVOCATION.command, args, {
    cwd,
    input: prompt,
    timeout: timeoutMs,
  });

  fs.writeFileSync(stdoutPath, result.stdout || "", "utf8");
  fs.writeFileSync(stderrPath, result.stderr || "", "utf8");

  if (result.timedOut) {
    fail(`codex exec timed out during ${phase} round ${roundNumber}.`, {
      errorType: "child_exec_timed_out",
      phase,
      round: roundNumber,
      exitCode: result.status,
      signal: result.signal ?? null,
      stdoutPath,
      stderrPath,
      cwd,
      sandbox,
      timeoutMs,
      timeoutReason: result.timeoutReason ?? null,
      commandFailure: formatCommandFailure(result),
    });
  }

  if (result.status !== 0) {
    fail(`codex exec failed during ${phase} round ${roundNumber}.`, {
      errorType: "child_exec_failed",
      phase,
      round: roundNumber,
      exitCode: result.status,
      signal: result.signal ?? null,
      stdoutPath,
      stderrPath,
      cwd,
      sandbox,
      commandFailure: formatCommandFailure(result),
    });
  }

  if (!fs.existsSync(outputPath)) {
    fail(`codex exec finished without writing structured output during ${phase} round ${roundNumber}.`, {
      errorType: "missing_structured_output",
      phase,
      round: roundNumber,
      stdoutPath,
      stderrPath,
      cwd,
      sandbox,
    });
  }

  const raw = fs.readFileSync(outputPath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Failed to parse structured Codex output at ${outputPath}: ${error.message}`, {
      errorType: "invalid_structured_output",
      phase,
      round: roundNumber,
      stdoutPath,
      stderrPath,
      outputPath,
      rawOutput: truncate(raw),
    });
  }
}

async function runReviewCodexStructured(options) {
  const sandbox = getReviewSandbox();

  try {
    return await runCodexStructured({
      ...options,
      sandbox,
    });
  } catch (error) {
    if (!shouldRetryReviewWithWorkspaceWrite(error, sandbox)) {
      throw error;
    }

    log("Read-only review sandbox failed on Windows; retrying with workspace-write and enforcing a post-review dirty check.");
    return runCodexStructured({
      ...options,
      sandbox: WINDOWS_REVIEW_SANDBOX,
    });
  }
}

function buildReviewPrompt({
  config,
  slice,
  roundNumber,
  globalRoundNumber,
  previousFailedTests,
}) {
  const pathLines = slice.paths.length === 0
    ? ["- No hard path filter. Use the scope sentence as the boundary."]
    : slice.paths.map((item) => `- ${item}`);

  const focusLines = config.focus.map((item) => `- ${item}`);
  const extraInstructionLines = config.extraInstructions.map((item) => `- ${item}`);
  const diffContextLines = buildSliceDiffPromptLines(slice);
  const failedTestLines = buildFailedTestPromptLines(previousFailedTests);

  return [
    `You are running review round ${roundNumber} inside a self-iterating review loop.`,
    `Global review iteration: ${globalRoundNumber}.`,
    "",
    "Goal:",
    "Report concrete P1, P2, P3, or P4 defects that currently exist inside the scoped code.",
    "",
    "Scope:",
    slice.scope,
    "",
    "Hard path boundaries:",
    ...pathLines,
    ...(diffContextLines.length > 0
      ? ["", "Scoped branch diff context:", ...diffContextLines]
      : []),
    "",
    "Primary review focus:",
    ...focusLines,
    "",
    "Severity rubric:",
    "- P1: severe incorrectness, data loss or corruption, security or privilege breakage, release-blocking defects.",
    "- P2: concrete regressions, boundary-condition bugs, missing validation, or other high-confidence functional defects.",
    "- P3: lower-impact concrete bugs, clear validation gaps, deterministic UI/API inconsistencies, or test coverage gaps with a specific risk.",
    "- P4: small but concrete correctness or quality issues that can be fixed without changing product behavior.",
    "",
    "Previously failed tests:",
    ...failedTestLines,
    "",
    "Rules:",
    "- You may inspect repository context outside the scope, but only report findings whose root cause is inside the scope.",
    "- Report only current issues that are still present in this checkout.",
    "- Treat previously failed tests as high-priority evidence. If the root cause is in scope, report a finding for it.",
    "- Prefer high-confidence findings. Skip speculation.",
    "- Do not run the full project test suite during the review round. Prefer static inspection and minimal targeted commands.",
    "- If a finding depends on unclear product policy or business semantics, set `requires_business_confirmation` to true and write the exact question in `business_question`.",
    "- If a finding is technically clear and does not need business input, set `requires_business_confirmation` to false and `business_question` to null.",
    "- Add every business-semantics question to `business_questions` with the related finding title in `blocked_findings`.",
    "- Deduplicate findings within this run.",
    "- Keep titles short and stable.",
    "- `fingerprint_basis` must be a terse and stable phrase describing the bug mechanism.",
    "- Return JSON that matches the provided schema exactly.",
    ...(buildWindowsShellRuleLines()),
    ...(extraInstructionLines.length > 0
      ? ["", "Extra instructions:", ...extraInstructionLines]
      : []),
  ].join("\n");
}

function buildFixPrompt({
  config,
  slice,
  roundNumber,
  globalRoundNumber,
  activeFindings,
  baselineTests,
  previousFailedTests,
}) {
  const findingsPayload = activeFindings.map((finding) => ({
    severity: finding.severity,
    title: finding.title,
    file: finding.file,
    line_start: finding.lineStart,
    line_end: finding.lineEnd,
    why: finding.why,
    repro_or_evidence: finding.reproOrEvidence,
    fix_strategy: finding.fixStrategy,
    fingerprint_basis: finding.fingerprintBasis,
  }));

  const baselineLines = baselineTests.length === 0
    ? ["- No baseline tests were provided."]
    : baselineTests.map((result) => `- ${result.command}: ${result.status}`);

  const pathLines = slice.paths.length === 0
    ? ["- No hard path filter. Respect the scope sentence."]
    : slice.paths.map((item) => `- ${item}`);

  const extraInstructionLines = config.extraInstructions.map((item) => `- ${item}`);
  const diffContextLines = buildSliceDiffPromptLines(slice);
  const failedTestLines = buildFailedTestPromptLines(previousFailedTests);

  return [
    `You are fixing the output of review round ${roundNumber} in a self-iterating review loop.`,
    `Global review iteration: ${globalRoundNumber}.`,
    "",
    "Goal:",
    "Apply the smallest safe code changes that eliminate the listed active findings.",
    "",
    "Scope:",
    slice.scope,
    "",
    "Hard path boundaries:",
    ...pathLines,
    ...(diffContextLines.length > 0
      ? ["", "Scoped branch diff context:", ...diffContextLines]
      : []),
    "",
    "Baseline test state:",
    ...baselineLines,
    "",
    "Previously failed tests to prioritize:",
    ...failedTestLines,
    "",
    "Active findings:",
    JSON.stringify(findingsPayload, null, 2),
    "",
    "Rules:",
    "- Fix root causes, not symptoms.",
    "- Prioritize fixes for previously failed tests when they are connected to the active findings.",
    "- Keep edits inside the scoped code unless a tiny supporting change outside the scope is required to make the fix correct.",
    "- Do not create documentation files.",
    "- Do not rewrite unrelated code.",
    "- Do not invent business rules. If a listed finding turns out to require product-policy confirmation, leave it unchanged and explain that in `notes`.",
    "- If a finding is invalid or blocked, leave the code unchanged and explain it in `notes`.",
    "- Return JSON that matches the provided schema exactly.",
    ...(buildWindowsShellRuleLines()),
    ...(extraInstructionLines.length > 0
      ? ["", "Extra instructions:", ...extraInstructionLines]
      : []),
  ].join("\n");
}

function buildFailedTestPromptLines(failedTests) {
  if (!failedTests || failedTests.length === 0) {
    return ["- None."];
  }

  return failedTests.map((test) => (
    `- ${test.command}: ${test.status}; stdout log: ${test.stdoutPath || "n/a"}; stderr log: ${test.stderrPath || "n/a"}; stdout tail: ${truncate(test.stdoutTail || "")}; stderr tail: ${truncate(test.stderrTail || "")}`
  ));
}

function runTests(commands, cwd, outputDir, timeoutMs) {
  fs.mkdirSync(outputDir, { recursive: true });

  return commands.map((command, index) => {
    const startedAt = Date.now();
    const result = runShellCommand(command, cwd, timeoutMs);
    const durationMs = Date.now() - startedAt;
    const testId = `test-${String(index + 1).padStart(2, "0")}`;
    const stdoutPath = path.join(outputDir, `${testId}.stdout.log`);
    const stderrPath = path.join(outputDir, `${testId}.stderr.log`);
    const timedOut = result.error?.code === "ETIMEDOUT";
    const passed = !timedOut && (result.status ?? 1) === 0;

    fs.writeFileSync(stdoutPath, result.stdout || "", "utf8");
    fs.writeFileSync(stderrPath, result.stderr || "", "utf8");

    const record = {
      command,
      exitCode: result.status,
      signal: result.signal ?? null,
      status: timedOut ? "timed-out" : passed ? "passed" : "failed",
      timedOut,
      timeoutMs,
      durationMs,
      stdoutPath,
      stderrPath,
      stdoutTail: truncate(result.stdout || ""),
      stderrTail: truncate(result.stderr || ""),
    };

    const filePath = path.join(outputDir, `${testId}.json`);
    writeJson(filePath, record);
    return record;
  });
}

function updateFindingLedger(ledger, activeFindings, roundNumber) {
  for (const finding of activeFindings) {
    if (!ledger.has(finding.fingerprint)) {
      ledger.set(finding.fingerprint, {
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        title: finding.title,
        file: finding.file,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        why: finding.why,
        reproOrEvidence: finding.reproOrEvidence,
        fixStrategy: finding.fixStrategy,
        fingerprintBasis: finding.fingerprintBasis,
        requiresBusinessConfirmation: finding.requiresBusinessConfirmation,
        businessQuestion: finding.businessQuestion,
        firstSeenRound: roundNumber,
        lastSeenRound: roundNumber,
        appearances: [roundNumber],
        status: "open",
      });
      finding.firstSeenRound = roundNumber;
      continue;
    }

    const entry = ledger.get(finding.fingerprint);
    entry.lastSeenRound = roundNumber;
    entry.appearances.push(roundNumber);
    entry.status = "open";
    finding.firstSeenRound = entry.firstSeenRound;
  }
}

function finalizeFindingLedger(ledger, finalActiveFindings) {
  const finalFingerprints = new Set(finalActiveFindings.map((finding) => finding.fingerprint));

  for (const entry of ledger.values()) {
    if (!finalFingerprints.has(entry.fingerprint)) {
      entry.status = "fixed";
    }
  }
}

function buildFinalReport(runState) {
  const finalActiveFingerprints = new Set(runState.finalActiveFindings.map((finding) => finding.fingerprint));
  const allFindings = Array.from(runState.allFindingsByFingerprint.values()).sort(compareFindingEntries);

  return {
    status: "completed",
    run_id: runState.runId,
    repo_name: runState.repoName,
    repo_root: runState.repoRoot,
    target_cwd: runState.targetCwd,
    worktree_path: runState.worktreePath,
    skill_dir: SKILL_DIR,
    resolved_base_ref: runState.resolvedBaseRef,
    config: {
      scope: runState.config.scope,
      requested_mode: runState.config.requestedMode,
      mode: runState.config.mode,
      max_rounds: runState.config.maxRounds,
      stop_condition: runState.config.stopCondition,
      tests: runState.config.tests,
      test_plan: runState.config.testPlan,
      test_timeout_ms: runState.config.testTimeoutMs,
      paths: runState.config.paths,
      focus: runState.config.focus,
      extra_instructions: runState.config.extraInstructions,
      model: runState.config.model || null,
      search: runState.config.search,
      allow_no_tests: runState.config.allowNoTests,
      plan_only: runState.config.planOnly,
    },
    stop_reason: runState.stopReason,
    final_status: runState.finalStatus,
    rounds_executed: runState.rounds.length,
    baseline_tests: runState.baselineTests,
    slice_plan: runState.slicePlan,
    slices: runState.slices.map((slice) => ({
      id: slice.id,
      label: slice.label,
      scope: slice.scope,
      base_ref: slice.baseRef,
      paths: slice.paths,
      stop_reason: slice.stopReason,
      final_active_findings: slice.finalActiveFindings.map(serializeFindingForReport),
      rounds: slice.rounds.map((round) => ({
        round: round.round,
        global_round: round.globalRound,
        review_summary: round.review.roundSummary,
        active_findings: round.activeFindings.map(serializeFindingForReport),
        blocked_findings: round.blockedFindings.map(serializeFindingForReport),
        business_questions: round.review.businessQuestions.map(serializeBusinessQuestionForReport),
        new_findings: round.newFindings.map(serializeFindingForReport),
        fix: round.fix,
        tests: round.tests,
      })),
    })),
    rounds: runState.rounds.map((round) => ({
      slice_id: round.sliceId,
      slice_label: round.sliceLabel,
      round: round.round,
      global_round: round.globalRound,
      review_summary: round.review.roundSummary,
      active_findings: round.activeFindings.map(serializeFindingForReport),
      blocked_findings: round.blockedFindings.map(serializeFindingForReport),
      business_questions: round.review.businessQuestions.map(serializeBusinessQuestionForReport),
      new_findings: round.newFindings.map(serializeFindingForReport),
      fix: round.fix,
      tests: round.tests,
    })),
    remaining_findings: runState.finalActiveFindings.map(serializeFindingForReport),
    business_questions: runState.rounds.flatMap((round) => (
      round.review.businessQuestions.map(serializeBusinessQuestionForReport)
    )),
    worktree_commit: runState.worktreeCommit,
    ledger: allFindings.map((entry) => ({
      ...entry,
      currently_active: finalActiveFingerprints.has(entry.fingerprint),
    })),
    artifact_paths: runState.artifactPaths,
  };
}

function deriveFinalStatus(stopReason, finalActiveFindings) {
  if (stopReason === "clean" && finalActiveFindings.length === 0) {
    return "clean";
  }

  if (stopReason === "completed-with-findings") {
    return "slices-completed";
  }

  if (stopReason === "blocked-by-business-questions") {
    return "needs-business-confirmation";
  }

  if (stopReason === "no-new-p1p2") {
    return "stopped-with-persistent-findings";
  }

  if (stopReason === "max-rounds") {
    return finalActiveFindings.length === 0 ? "clean-at-limit" : "max-rounds-hit";
  }

  return "stopped";
}

function normalizeFinding(finding, repoRoot) {
  const normalizedFile = normalizeFilePath(finding.file, repoRoot);
  const normalizedFinding = {
    severity: String(finding.severity || "").toUpperCase(),
    title: normalizeWhitespace(finding.title || ""),
    confidence: String(finding.confidence || "").toLowerCase(),
    file: normalizedFile,
    lineStart: normalizePositiveInteger(finding.line_start),
    lineEnd: normalizePositiveInteger(finding.line_end),
    why: normalizeWhitespace(finding.why || ""),
    reproOrEvidence: normalizeWhitespace(finding.repro_or_evidence || ""),
    fixStrategy: normalizeWhitespace(finding.fix_strategy || ""),
    fingerprintBasis: normalizeWhitespace(finding.fingerprint_basis || ""),
    requiresBusinessConfirmation: Boolean(finding.requires_business_confirmation),
    businessQuestion: finding.business_question
      ? normalizeWhitespace(finding.business_question)
      : null,
  };

  normalizedFinding.fingerprint = buildFindingFingerprint(normalizedFinding);
  normalizedFinding.firstSeenRound = null;
  return normalizedFinding;
}

function normalizeBusinessQuestions(questions, repoRoot) {
  return questions.map((question) => ({
    title: normalizeWhitespace(question.title || ""),
    file: normalizeFilePath(question.file, repoRoot),
    question: normalizeWhitespace(question.question || ""),
    blockedFindings: Array.isArray(question.blocked_findings)
      ? question.blocked_findings.map((item) => normalizeWhitespace(item)).filter(Boolean)
      : [],
  })).filter((question) => question.title && question.question);
}

function buildFindingBusinessQuestions(findings) {
  return findings
    .filter((finding) => finding.requiresBusinessConfirmation && finding.businessQuestion)
    .map((finding) => ({
      title: finding.title,
      file: finding.file,
      question: finding.businessQuestion,
      blockedFindings: [finding.title],
    }));
}

function deduplicateBusinessQuestions(questions) {
  const seen = new Set();
  const result = [];

  for (const question of questions) {
    const key = [
      question.file || "",
      question.title,
      question.question,
    ].map((item) => normalizeWhitespace(String(item)).toLowerCase()).join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(question);
  }

  return result;
}

function deduplicateFindings(findings) {
  const seen = new Set();
  const result = [];

  for (const finding of findings) {
    if (!finding.title || !finding.why || !finding.fingerprintBasis) {
      continue;
    }

    if (seen.has(finding.fingerprint)) {
      continue;
    }

    seen.add(finding.fingerprint);
    result.push(finding);
  }

  return result.sort(compareFindingEntries);
}

function buildFindingFingerprint(finding) {
  const raw = [
    finding.severity,
    finding.file || "",
    finding.title,
    finding.fingerprintBasis,
  ]
    .map((item) => normalizeWhitespace(String(item)).toLowerCase())
    .join("|");

  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function compareFindingEntries(left, right) {
  return [
    left.severity.localeCompare(right.severity),
    (left.file || "").localeCompare(right.file || ""),
    left.title.localeCompare(right.title),
  ].find((value) => value !== 0) || 0;
}

function serializeFindingForReport(finding) {
  return {
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    title: finding.title,
    file: finding.file,
    line_start: finding.lineStart,
    line_end: finding.lineEnd,
    why: finding.why,
    repro_or_evidence: finding.reproOrEvidence,
    fix_strategy: finding.fixStrategy,
    fingerprint_basis: finding.fingerprintBasis,
    requires_business_confirmation: finding.requiresBusinessConfirmation,
    business_question: finding.businessQuestion,
    first_seen_round: finding.firstSeenRound,
  };
}

function serializeBusinessQuestionForReport(question) {
  return {
    title: question.title,
    file: question.file,
    question: question.question,
    blocked_findings: question.blockedFindings,
  };
}

function formatFindingLabel(finding) {
  const location = finding.file
    ? `${finding.file}${finding.lineStart ? `:${finding.lineStart}` : ""}`
    : "unknown location";

  return `${finding.title} (${location})`;
}

function buildFailureReport(error, runState) {
  const details = error instanceof SelfIteratingReviewError ? error.details : {};

  return {
    status: "failed",
    run_id: runState?.runId ?? null,
    repo_name: runState?.repoName ?? null,
    repo_root: runState?.repoRoot ?? null,
    target_cwd: runState?.targetCwd ?? null,
    worktree_path: runState?.worktreePath ?? null,
    resolved_base_ref: runState?.resolvedBaseRef ?? null,
    final_status: "failed",
    stop_reason: "failed",
    rounds_executed: runState?.rounds.length ?? 0,
    phase: details.phase ?? null,
    round: details.round ?? null,
    error_type: details.errorType || "runtime_error",
    message: error instanceof Error ? error.message : String(error),
    exit_code: details.exitCode ?? null,
    signal: details.signal ?? null,
    cwd: details.cwd ?? null,
    sandbox: details.sandbox ?? null,
    artifact_paths: {
      ...(runState?.artifactPaths ?? {}),
      stdout_log: details.stdoutPath ?? null,
      stderr_log: details.stderrPath ?? null,
      structured_output: details.outputPath ?? null,
    },
    test_plan: runState?.config?.testPlan ?? null,
    baseline_tests: runState?.baselineTests ?? [],
    slice_plan: runState?.slicePlan ?? [],
    slices: runState?.slices ?? [],
    rounds: runState?.rounds.map((roundRecord) => ({
      slice_id: roundRecord.sliceId ?? null,
      slice_label: roundRecord.sliceLabel ?? null,
      round: roundRecord.round,
      global_round: roundRecord.globalRound ?? null,
      review_summary: roundRecord.review.roundSummary,
      active_findings: roundRecord.activeFindings.map(serializeFindingForReport),
      new_findings: roundRecord.newFindings.map(serializeFindingForReport),
      fix: roundRecord.fix,
      tests: roundRecord.tests,
    })) ?? [],
    command_failure: details.commandFailure ?? null,
    raw_output: details.rawOutput ?? null,
  };
}

function normalizeFilePath(filePath, repoRoot) {
  if (!filePath) {
    return null;
  }

  const trimmed = String(filePath).trim();
  if (!trimmed) {
    return null;
  }

  const absoluteCandidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
  const normalized = path.normalize(absoluteCandidate);
  const relative = path.relative(repoRoot, normalized);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative === "" ? "." : toPosixPath(relative);
  }

  return toPosixPath(trimmed);
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeScopePaths(paths, repoRoot) {
  return normalizeDistinctStrings(paths.map((item) => {
    const absolute = path.isAbsolute(item) ? path.normalize(item) : path.resolve(repoRoot, item);
    const relative = path.relative(repoRoot, absolute);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`Path boundary escapes the repository root: ${item}`);
    }

    return toPosixPath(relative);
  }));
}

function resolveScopeBaseRef(repoRoot, scope) {
  const normalizedScope = String(scope).toLowerCase();
  const mentionsOriginMain =
    normalizedScope.includes("against origin/main") ||
    normalizedScope.includes("diff against origin/main");
  const mentionsLocalMain =
    normalizedScope.includes("against main") ||
    normalizedScope.includes("diff against main");

  if (!mentionsOriginMain && !mentionsLocalMain) {
    return null;
  }

  if (mentionsOriginMain) {
    if (!gitRefExists(repoRoot, "origin/main")) {
      fail("The scope explicitly references `origin/main`, but that ref does not exist locally.");
    }

    return {
      requestedRef: "origin/main",
      resolvedRef: "origin/main",
      reason: "explicit-origin-main",
    };
  }

  const localMainExists = gitRefExists(repoRoot, "main");
  const remoteMainExists = gitRefExists(repoRoot, "origin/main");

  if (!localMainExists && !remoteMainExists) {
    fail("The scope references `main`, but neither `main` nor `origin/main` exists locally.");
  }

  if (!localMainExists && remoteMainExists) {
    return {
      requestedRef: "main",
      resolvedRef: "origin/main",
      reason: "local-main-missing",
    };
  }

  if (localMainExists && !remoteMainExists) {
    return {
      requestedRef: "main",
      resolvedRef: "main",
      reason: "origin-main-missing",
    };
  }

  const divergence = getRefDivergence(repoRoot, "main", "origin/main");
  if (divergence.right > 0 && divergence.left === 0) {
    return {
      requestedRef: "main",
      resolvedRef: "origin/main",
      reason: "local-main-behind-origin",
    };
  }

  return {
    requestedRef: "main",
    resolvedRef: "main",
    reason: "local-main-current",
  };
}

function buildReviewSlices({ config, repoRoot, resolvedBase, allowAutoSlicing }) {
  if (!resolvedBase) {
    return [
      buildSingleSlice({
        config,
        id: "slice-01",
        label: "full-scope",
        paths: config.paths,
        baseRef: null,
        diffFiles: [],
        repoRoot,
      }),
    ];
  }

  const diffFiles = collectScopedDiffFiles(
    repoRoot,
    resolvedBase.resolvedRef,
    config.paths,
  );
  const totalChangedLines = diffFiles.reduce(
    (sum, file) => sum + countChangedLines(file),
    0,
  );

  if (
    diffFiles.length <= AUTO_SLICE_MAX_FILES &&
    totalChangedLines <= AUTO_SLICE_MAX_CHANGED_LINES
  ) {
    const slicePaths =
      config.paths.length > 0
        ? config.paths
        : diffFiles.map((file) => file.path);

    return [
      buildSingleSlice({
        config,
        id: "slice-01",
        label: "full-scope",
        paths: slicePaths,
        baseRef: resolvedBase.resolvedRef,
        diffFiles,
        repoRoot,
      }),
    ];
  }

  if (!allowAutoSlicing || diffFiles.length === 0) {
    const slicePaths =
      config.paths.length > 0
        ? config.paths
        : diffFiles.map((file) => file.path);

    return [
      buildSingleSlice({
        config,
        id: "slice-01",
        label: "full-scope",
        paths: slicePaths,
        baseRef: resolvedBase.resolvedRef,
        diffFiles,
        repoRoot,
      }),
    ];
  }

  const sliceGroups = buildSliceGroups(diffFiles);
  return sliceGroups.map((group, index) =>
    buildSingleSlice({
      config,
      id: `slice-${String(index + 1).padStart(2, "0")}`,
      label: group.label,
      paths: group.files.map((file) => file.path),
      baseRef: resolvedBase.resolvedRef,
      diffFiles: group.files,
      repoRoot,
      sliceIndex: index,
      sliceCount: sliceGroups.length,
    }),
  );
}

function buildSingleSlice({
  config,
  id,
  label,
  paths,
  baseRef,
  diffFiles,
  repoRoot,
  sliceIndex = 0,
  sliceCount = 1,
}) {
  const scope =
    sliceCount <= 1
      ? config.scope.trim()
      : `${config.scope.trim()} Auto-slice ${sliceIndex + 1}/${sliceCount}: review only ${label}.`;

  return {
    id,
    label,
    scope,
    paths,
    baseRef,
    diff: buildSliceDiffContext({
      repoRoot,
      baseRef,
      paths,
      diffFiles,
    }),
  };
}

function buildSliceGroups(diffFiles) {
  const grouped = new Map();

  for (const file of diffFiles) {
    const groupKey = deriveSliceGroupKey(file.path);
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, []);
    }
    grouped.get(groupKey).push(file);
  }

  const slices = [];
  for (const groupKey of [...grouped.keys()].sort()) {
    const files = grouped.get(groupKey).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    let batch = [];
    let batchChangedLines = 0;
    let batchNumber = 1;

    for (const file of files) {
      const nextChangedLines = countChangedLines(file);
      const wouldOverflow =
        batch.length > 0 &&
        (batch.length >= AUTO_SLICE_MAX_FILES ||
          batchChangedLines + nextChangedLines > AUTO_SLICE_MAX_CHANGED_LINES);

      if (wouldOverflow) {
        slices.push({
          label:
            batchNumber === 1 && files.length === batch.length
              ? groupKey
              : `${groupKey} (part ${batchNumber})`,
          files: batch,
        });
        batch = [];
        batchChangedLines = 0;
        batchNumber += 1;
      }

      batch.push(file);
      batchChangedLines += nextChangedLines;
    }

    if (batch.length > 0) {
      slices.push({
        label:
          batchNumber === 1 && files.length === batch.length
            ? groupKey
            : `${groupKey} (part ${batchNumber})`,
        files: batch,
      });
    }
  }

  return slices;
}

function deriveSliceGroupKey(filePath) {
  const parts = toPosixPath(filePath).split("/");

  if (parts[0] === "apps" && parts[1]) {
    return `apps/${parts[1]}`;
  }

  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }

  if (parts[0] === ".github") {
    return ".github";
  }

  return parts[0] || "repo-root";
}

function buildSliceDiffContext({ repoRoot, baseRef, paths, diffFiles }) {
  if (!baseRef) {
    return null;
  }

  const statText = runGitDiff(repoRoot, baseRef, ["--stat"], paths).trim();
  const rawPatch = runGitDiff(repoRoot, baseRef, ["--unified=20"], paths);
  const patchExcerpt = truncateToLimit(rawPatch.trim(), DIFF_CONTEXT_CHAR_LIMIT);

  return {
    baseRef,
    fileCount: diffFiles.length,
    insertions: diffFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: diffFiles.reduce((sum, file) => sum + file.deletions, 0),
    files: diffFiles,
    statText,
    patchExcerpt: patchExcerpt.text,
    patchWasTruncated: patchExcerpt.truncated,
  };
}

function collectScopedDiffFiles(repoRoot, baseRef, paths) {
  const output = runGitDiff(repoRoot, baseRef, ["--numstat"], paths);
  if (!output.trim()) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [insertionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
      const filePath = toPosixPath(pathParts.join("\t").trim());
      const insertions =
        insertionsRaw === "-" ? 0 : Number.parseInt(insertionsRaw, 10) || 0;
      const deletions =
        deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10) || 0;

      return {
        path: filePath,
        insertions,
        deletions,
        changedLines:
          insertionsRaw === "-" || deletionsRaw === "-"
            ? BINARY_FILE_CHANGED_LINE_FALLBACK
            : insertions + deletions,
      };
    });
}

function countChangedLines(file) {
  return file.changedLines || file.insertions + file.deletions || BINARY_FILE_CHANGED_LINE_FALLBACK;
}

function runGitDiff(repoRoot, baseRef, diffArgs, paths) {
  const args = ["diff", ...diffArgs, `${baseRef}...HEAD`];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }

  const result = runProcess("git", args, { cwd: repoRoot });
  if (result.status !== 0) {
    fail(`Failed to read git diff for ${baseRef}.\n${formatCommandFailure(result)}`);
  }

  return result.stdout || "";
}

function buildSliceDiffPromptLines(slice) {
  if (!slice.diff) {
    return [];
  }

  const changedFiles = slice.diff.files.length === 0
    ? ["- No changed files were detected for this slice against the resolved base."]
    : slice.diff.files.map((file) => `- ${file.path} (+${file.insertions}/-${file.deletions})`);

  return [
    `- Resolved base ref: ${slice.diff.baseRef}`,
    `- Slice label: ${slice.label}`,
    `- Changed files in slice: ${slice.diff.fileCount}`,
    `- Estimated changed lines: +${slice.diff.insertions} / -${slice.diff.deletions}`,
    "- Changed files:",
    ...changedFiles,
    ...(slice.diff.statText
      ? ["- Diff stat:", slice.diff.statText]
      : []),
    ...(slice.diff.patchExcerpt
      ? [
          "- Relevant diff patch:",
          "```diff",
          slice.diff.patchExcerpt,
          "```",
          ...(slice.diff.patchWasTruncated
            ? ["- The diff patch above was truncated to keep the prompt bounded."]
            : []),
        ]
      : []),
  ];
}

function serializeSlicePlan(slice) {
  return {
    id: slice.id,
    label: slice.label,
    scope: slice.scope,
    base_ref: slice.baseRef,
    paths: slice.paths,
    diff: slice.diff
      ? {
          file_count: slice.diff.fileCount,
          insertions: slice.diff.insertions,
          deletions: slice.diff.deletions,
          files: slice.diff.files,
          patch_was_truncated: slice.diff.patchWasTruncated,
        }
      : null,
  };
}

function buildPlanOnlyReport(runState) {
  return {
    status: "planned",
    run_id: runState.runId,
    repo_name: runState.repoName,
    repo_root: runState.repoRoot,
    target_cwd: runState.targetCwd,
    worktree_path: runState.worktreePath,
    resolved_base_ref: runState.resolvedBaseRef,
    config: {
      scope: runState.config.scope,
      requested_mode: runState.config.requestedMode,
      mode: runState.config.mode,
      max_rounds: runState.config.maxRounds,
      stop_condition: runState.config.stopCondition,
      tests: runState.config.tests,
      test_plan: runState.config.testPlan,
      test_timeout_ms: runState.config.testTimeoutMs,
      paths: runState.config.paths,
      focus: runState.config.focus,
      extra_instructions: runState.config.extraInstructions,
      model: runState.config.model || null,
      search: runState.config.search,
      allow_no_tests: runState.config.allowNoTests,
      plan_only: runState.config.planOnly,
    },
    slice_plan: runState.slicePlan,
    artifact_paths: runState.artifactPaths,
  };
}

function createWorktreeCommitIfNeeded(runState) {
  if (runState.config.mode !== "worktree" || !runState.worktreePath) {
    return null;
  }

  const initialStatus = getGitStatus(runState.worktreePath);
  if (initialStatus.trim() === "") {
    return {
      status: "no_changes",
      worktree_path: runState.worktreePath,
      commit: null,
      cherry_pick_command: null,
    };
  }

  const addResult = runProcess("git", ["add", "-A"], { cwd: runState.worktreePath });
  if (addResult.status !== 0) {
    fail(`Failed to stage worktree fixes before creating a handoff commit.\n${formatCommandFailure(addResult)}`);
  }

  const commitResult = runProcess(
    "git",
    [
      "-c",
      "user.name=Codex Self Iterating Review",
      "-c",
      "user.email=codex-self-iterating-review@localhost",
      "commit",
      "-m",
      "self-iterating-review: apply automated fixes",
    ],
    { cwd: runState.worktreePath },
  );
  if (commitResult.status !== 0) {
    fail(`Failed to create worktree handoff commit.\n${formatCommandFailure(commitResult)}`);
  }

  const commitHashResult = runProcess("git", ["rev-parse", "HEAD"], { cwd: runState.worktreePath });
  if (commitHashResult.status !== 0) {
    fail(`Failed to read worktree handoff commit hash.\n${formatCommandFailure(commitHashResult)}`);
  }

  const commitHash = commitHashResult.stdout.trim();
  return {
    status: "committed",
    worktree_path: runState.worktreePath,
    commit: commitHash,
    cherry_pick_command: `git cherry-pick ${commitHash}`,
  };
}

function gitRefExists(repoRoot, refName) {
  const result = runProcess("git", ["rev-parse", "--verify", "--quiet", refName], {
    cwd: repoRoot,
  });
  return result.status === 0;
}

function getRefDivergence(repoRoot, leftRef, rightRef) {
  const result = runProcess(
    "git",
    ["rev-list", "--left-right", "--count", `${leftRef}...${rightRef}`],
    { cwd: repoRoot },
  );

  if (result.status !== 0) {
    fail(`Failed to compare ${leftRef} and ${rightRef}.\n${formatCommandFailure(result)}`);
  }

  const [leftCountRaw, rightCountRaw] = result.stdout.trim().split(/\s+/);
  return {
    left: Number.parseInt(leftCountRaw, 10) || 0,
    right: Number.parseInt(rightCountRaw, 10) || 0,
  };
}

function getGitRepoRoot(repoPath) {
  const result = runProcess("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoPath,
  });

  if (result.status !== 0) {
    fail(`Not a Git repository: ${repoPath}`);
  }

  return result.stdout.trim();
}

function getGitStatus(cwd) {
  const result = runProcess("git", ["status", "--short"], {
    cwd,
  });

  if (result.status !== 0) {
    fail(`Failed to read git status in ${cwd}.\n${formatCommandFailure(result)}`);
  }

  return result.stdout;
}

function getGitWorkspaceSnapshot(cwd) {
  return {
    status: getGitStatus(cwd),
    unstagedDiff: getGitDiffSnapshot(cwd, []),
    stagedDiff: getGitDiffSnapshot(cwd, ["--cached"]),
    untrackedFiles: getUntrackedFileSnapshots(cwd),
  };
}

function getGitDiffSnapshot(cwd, extraArgs) {
  const result = runProcess("git", ["diff", "--binary", ...extraArgs], {
    cwd,
  });

  if (result.status !== 0) {
    fail(`Failed to read git diff in ${cwd}.\n${formatCommandFailure(result)}`);
  }

  return result.stdout;
}

function getUntrackedFileSnapshots(cwd) {
  const result = runProcess("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
  });

  if (result.status !== 0) {
    fail(`Failed to list untracked files in ${cwd}.\n${formatCommandFailure(result)}`);
  }

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => getUntrackedFileSnapshot(cwd, relativePath));
}

function getUntrackedFileSnapshot(cwd, relativePath) {
  const absolutePath = path.resolve(cwd, relativePath);
  const relativeFromRoot = path.relative(cwd, absolutePath);

  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    fail(`Refusing to snapshot untracked path outside the repository: ${relativePath}`, {
      errorType: "untracked_path_outside_repo",
      cwd,
      path: relativePath,
    });
  }

  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return {
      path: toPosixPath(relativePath),
      type: "symlink",
      target: fs.readlinkSync(absolutePath),
    };
  }

  if (stat.isFile()) {
    return {
      path: toPosixPath(relativePath),
      type: "file",
      size: stat.size,
      hash: hashFile(absolutePath),
    };
  }

  return {
    path: toPosixPath(relativePath),
    type: "other",
    size: stat.size,
  };
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runShellCommand(command, cwd, timeoutMs) {
  if (process.platform === "win32") {
    const shell = getWindowsTestShell();
    return runProcess(shell.command, [...shell.args, command], { cwd, timeout: timeoutMs });
  }

  return runProcess("/bin/sh", ["-lc", command], { cwd, timeout: timeoutMs });
}

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
    timeout: options.timeout,
  });
}

function runProcessAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timeoutReason = null;
    let totalTimeoutId = null;
    let forceKillTimeoutId = null;
    let settled = false;

    function clearTimers() {
      if (totalTimeoutId) {
        clearTimeout(totalTimeoutId);
        totalTimeoutId = null;
      }
      if (forceKillTimeoutId) {
        clearTimeout(forceKillTimeoutId);
        forceKillTimeoutId = null;
      }
    }

    function finish(result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve({
        ...result,
        stdout,
        stderr,
        timedOut: Boolean(timeoutReason),
        timeoutReason,
      });
    }

    function terminateChild(reason) {
      if (timeoutReason) {
        return;
      }

      timeoutReason = reason;
      terminateProcessTree(child);

      forceKillTimeoutId = setTimeout(() => {
        terminateProcessTree(child, { force: true });
      }, CHILD_FORCE_KILL_GRACE_MS);
    }

    if (options.timeout) {
      totalTimeoutId = setTimeout(() => {
        terminateChild("total");
      }, options.timeout);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        status: null,
        signal: null,
        error,
      });
    });

    child.on("close", (status, signal) => {
      finish({
        status,
        signal,
        error: null,
      });
    });

    if (options.input != null) {
      child.stdin.end(options.input);
      return;
    }

    child.stdin.end();
  });
}

function terminateProcessTree(child, options = {}) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    runProcess("taskkill", [
      "/PID",
      String(child.pid),
      "/T",
      ...(options.force ? ["/F"] : []),
    ]);
    return;
  }

  try {
    child.kill(options.force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Ignore process-kill races; close/error handlers will resolve.
  }
}

function getReviewSandbox() {
  return DEFAULT_REVIEW_SANDBOX;
}

function warnSearchFlagUnsupported() {
  if (searchFlagWarningPrinted) {
    return;
  }

  searchFlagWarningPrinted = true;
  log("Local Codex CLI does not expose a supported `--search` flag position; continuing without passing that flag.");
}

function resolveCodexInvocation() {
  if (process.platform !== "win32") {
    return {
      command: "codex",
      baseArgs: [],
    };
  }

  return {
    command: "cmd.exe",
    baseArgs: ["/d", "/s", "/c", "codex.cmd"],
  };
}

function detectCodexExecCapabilities() {
  const globalHelpResult = runProcess(
    CODEX_INVOCATION.command,
    [...CODEX_INVOCATION.baseArgs, "--help"],
    {
      cwd: process.cwd(),
    },
  );
  const execHelpResult = runProcess(
    CODEX_INVOCATION.command,
    [...CODEX_INVOCATION.baseArgs, "exec", "--help"],
    {
      cwd: process.cwd(),
    },
  );

  const globalHelpText = `${globalHelpResult.stdout || ""}\n${globalHelpResult.stderr || ""}`;
  const execHelpText = `${execHelpResult.stdout || ""}\n${execHelpResult.stderr || ""}`;
  const supportsGlobalSearchFlag = hasHelpFlag(globalHelpText, "--search");
  const supportsExecSearchFlag = hasHelpFlag(execHelpText, "--search");
  const searchFlagPosition = supportsGlobalSearchFlag
    ? "global"
    : supportsExecSearchFlag
      ? "exec"
      : null;

  return {
    supportsSearchFlag: Boolean(searchFlagPosition),
    supportsGlobalSearchFlag,
    supportsExecSearchFlag,
    searchFlagPosition,
  };
}

function hasHelpFlag(helpText, flagName) {
  const escapedFlag = flagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,])${escapedFlag}(?=[\\s,])`).test(helpText);
}

function getWindowsTestShell() {
  if (windowsTestShell) {
    return windowsTestShell;
  }

  if (commandExistsOnWindows("pwsh.exe")) {
    windowsTestShell = {
      command: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    };
    return windowsTestShell;
  }

  if (commandExistsOnWindows("powershell.exe")) {
    windowsTestShell = {
      command: "powershell",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    };
    return windowsTestShell;
  }

  fail("Windows test commands require either `pwsh.exe` or `powershell.exe` on PATH.", {
    errorType: "missing_windows_shell",
  });
}

function commandExistsOnWindows(command) {
  if (process.platform !== "win32") {
    return false;
  }

  const result = runProcess("where.exe", [command]);
  return result.status === 0;
}

function shouldRetryReviewWithWorkspaceWrite(error, sandbox) {
  if (process.platform !== "win32" || sandbox !== DEFAULT_REVIEW_SANDBOX) {
    return false;
  }

  if (!(error instanceof SelfIteratingReviewError)) {
    return false;
  }

  if (error.details?.errorType !== "child_exec_failed") {
    return false;
  }

  const failureText = `${error.message}\n${error.details?.commandFailure || ""}`;
  return /\bsandbox\b|read[- ]only|not supported|unsupported/i.test(failureText);
}

function assertReviewDidNotModifyWorkspace(cwd, initialWorkspaceSnapshot, { outputPath, roundNumber }) {
  const finalWorkspaceSnapshot = getGitWorkspaceSnapshot(cwd);
  if (JSON.stringify(finalWorkspaceSnapshot) === JSON.stringify(initialWorkspaceSnapshot)) {
    return;
  }

  fail("Review round modified the working tree; review runs must leave the checkout unchanged.", {
    errorType: "review_modified_workspace",
    phase: "review",
    round: roundNumber,
    cwd,
    outputPath,
    commandFailure: [
      "git status before review:",
      initialWorkspaceSnapshot.status.trim() || "(clean)",
      "git status after review:",
      finalWorkspaceSnapshot.status.trim() || "(clean)",
    ].join("\n"),
  });
}

function validateTestCommandsForTargetWorkspace(commands, { mode, repoRoot, targetCwd }) {
  if (mode !== "worktree" || commands.length === 0) {
    return;
  }

  for (const command of commands) {
    const localOpsMatch = command.match(/(^|[\s"'`])(\.codex-local[\\/][^\s"'`]+)/);
    if (!localOpsMatch) {
      continue;
    }

    const referencedPath = localOpsMatch[2];
    const targetPath = path.resolve(targetCwd, referencedPath);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const sourcePath = path.resolve(repoRoot, referencedPath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    fail(
      `Worktree mode cannot run test command "${command}" because "${referencedPath}" exists only in the source workspace. Use \`--mode in-place\` or provide a repo-tracked equivalent test command.`,
      {
        errorType: "unsupported_worktree_test_command",
      },
    );
  }
}

function buildWindowsShellRuleLines() {
  if (process.platform !== "win32") {
    return [];
  }

  return [
    "",
    "Windows PowerShell rule:",
    "- When a path contains `[` or `]`, read it with `Get-Content -LiteralPath` or another literal-path-safe command. Do not use wildcard-sensitive path reads for Next.js route segments.",
  ];
}

function ensureFileExists(filePath, message) {
  if (!fs.existsSync(filePath)) {
    fail(`${message}: ${filePath}`);
  }
}

function buildRunId(repoName) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${repoName}`;
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeComparablePath(value) {
  const normalized = path.resolve(String(value).trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeDistinctStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map((item) => item.trim()).filter(Boolean)));
}

function readRequiredValue(argv, index, flagName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flagName}.`);
  }
  return value;
}

function truncate(text) {
  if (!text) {
    return "";
  }

  const normalized = String(text);
  if (normalized.length <= OUTPUT_TAIL_LIMIT) {
    return normalized.trim();
  }

  const headLength = Math.floor(OUTPUT_TAIL_LIMIT / 3);
  const tailLength = OUTPUT_TAIL_LIMIT - headLength - 32;
  const head = normalized.slice(0, headLength).trim();
  const tail = normalized.slice(normalized.length - tailLength).trim();
  return `${head}\n...\n[output truncated]\n...\n${tail}`;
}

function truncateToLimit(text, limit) {
  if (!text) {
    return { text: "", truncated: false };
  }

  const normalized = String(text);
  if (normalized.length <= limit) {
    return { text: normalized, truncated: false };
  }

  const headLength = Math.floor(limit * 0.6);
  const tailLength = limit - headLength - 48;
  const head = normalized.slice(0, headLength).trimEnd();
  const tail = normalized.slice(normalized.length - tailLength).trimStart();

  return {
    text: `${head}\n...\n[diff truncated to keep prompt bounded]\n...\n${tail}`,
    truncated: true,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function formatCommandFailure(result) {
  return [
    `error:\n${result.error ? `${result.error.name}: ${result.error.message}` : ""}`,
    `stdout:\n${truncate(result.stdout || "")}`,
    `stderr:\n${truncate(result.stderr || "")}`,
  ].join("\n");
}

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function fail(message, details = {}) {
  throw new SelfIteratingReviewError(message, details);
}

class SelfIteratingReviewError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SelfIteratingReviewError";
    this.details = details;
  }
}

main().catch((error) => {
  process.stderr.write(`${LOG_PREFIX} Unhandled failure: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
