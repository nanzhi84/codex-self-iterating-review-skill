#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_ROUNDS = 6;
const MAX_ALLOWED_ROUNDS = 12;
const DEFAULT_MODE = "in-place";
const DEFAULT_STOP_CONDITION = "current-clean";
const DEFAULT_FOCUS = ["correctness", "regression", "security"];
const DEFAULT_CODEX_TIMEOUT_MS = 180000;
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

main();

function main() {
  const config = parseArgs(process.argv.slice(2));
  ensureFileExists(REVIEW_SCHEMA_PATH, "Missing review schema");
  ensureFileExists(FIX_SCHEMA_PATH, "Missing fix schema");

  const repoRoot = getGitRepoRoot(config.repoPath);
  config.paths = normalizeScopePaths(config.paths, repoRoot);
  const repoName = path.basename(repoRoot);
  const initialStatus = getGitStatus(repoRoot);

  if (config.mode === "worktree" && initialStatus.trim() !== "") {
    fail("`--mode worktree` requires a clean repository because uncommitted changes are not copied into the detached worktree.");
  }

  const runId = buildRunId(repoName);
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const target = prepareTargetWorkspace({
    config,
    repoRoot,
    runDir,
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
    allFindingsByFingerprint: new Map(),
    finalActiveFindings: [],
    finalStatus: "unknown",
    stopReason: "unknown",
    artifactPaths: {
      runDir,
      reviewSchema: REVIEW_SCHEMA_PATH,
      fixSchema: FIX_SCHEMA_PATH,
    },
  };

  log(`Run directory: ${runDir}`);
  log(`Target workspace: ${runState.targetCwd}`);

  if (config.tests.length > 0) {
    log("Running baseline tests before the review loop.");
    runState.baselineTests = runTests(config.tests, runState.targetCwd, path.join(runDir, "baseline-tests"));
  }

  let stopReason = null;

  for (let roundNumber = 1; roundNumber <= config.maxRounds; roundNumber += 1) {
    const roundDir = path.join(runDir, `round-${String(roundNumber).padStart(2, "0")}`);
    fs.mkdirSync(roundDir, { recursive: true });

    log(`Round ${roundNumber}: fresh review run starting.`);
    const reviewResult = runReviewRound({
      config,
      roundNumber,
      roundDir,
      targetCwd: runState.targetCwd,
    });

    const activeFindings = reviewResult.findings.filter((finding) => finding.severity === "P1" || finding.severity === "P2");
    updateFindingLedger(runState.allFindingsByFingerprint, activeFindings, roundNumber);

    const roundRecord = {
      round: roundNumber,
      review: reviewResult,
      activeFindings,
      newFindings: activeFindings.filter((finding) => finding.firstSeenRound === roundNumber),
      fix: null,
      tests: [],
    };

    runState.rounds.push(roundRecord);
    runState.finalActiveFindings = activeFindings;

    if (activeFindings.length === 0) {
      stopReason = "clean";
      break;
    }

    if (config.stopCondition === "no-new-p1p2" && roundRecord.newFindings.length === 0) {
      stopReason = "no-new-p1p2";
      break;
    }

    if (roundNumber === config.maxRounds) {
      stopReason = "max-rounds";
      break;
    }

    log(`Round ${roundNumber}: fixing ${activeFindings.length} active finding(s).`);
    roundRecord.fix = runFixRound({
      config,
      roundNumber,
      roundDir,
      targetCwd: runState.targetCwd,
      activeFindings,
      baselineTests: runState.baselineTests,
    });

    if (config.tests.length > 0) {
      log(`Round ${roundNumber}: running post-fix tests.`);
      roundRecord.tests = runTests(config.tests, runState.targetCwd, path.join(roundDir, "tests"));
    }
  }

  runState.stopReason = stopReason || "max-rounds";
  runState.finalStatus = deriveFinalStatus(runState.stopReason, runState.finalActiveFindings);
  finalizeFindingLedger(runState.allFindingsByFingerprint, runState.finalActiveFindings);

  const finalReport = buildFinalReport(runState);
  const finalJsonPath = path.join(runDir, "final-report.json");
  const finalMarkdownPath = path.join(runDir, "final-report.md");
  writeJson(finalJsonPath, finalReport);
  fs.writeFileSync(finalMarkdownPath, buildMarkdownReport(finalReport), "utf8");

  log(`Finished with status '${runState.finalStatus}'.`);
  log(`Final report: ${finalMarkdownPath}`);
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
    search: false,
    codexTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
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
      case "--allow-no-tests":
        config.allowNoTests = true;
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

  if (!["in-place", "worktree"].includes(config.mode)) {
    fail("`--mode` must be either `in-place` or `worktree`.");
  }

  if (!["current-clean", "no-new-p1p2"].includes(config.stopCondition)) {
    fail("`--stop-condition` must be either `current-clean` or `no-new-p1p2`.");
  }

  if (!Number.isInteger(config.codexTimeoutMs) || config.codexTimeoutMs < 10000) {
    fail("`--codex-timeout-ms` must be an integer greater than or equal to 10000.");
  }

  if (!config.allowNoTests && config.tests.length === 0) {
    fail("At least one `--test` command is required unless `--allow-no-tests` is explicitly set.");
  }
}

function printHelp() {
  const lines = [
    "Usage:",
    "  node review_loop.mjs --scope <text> --test <command> [options]",
    "",
    "Required:",
    "  --scope <text>              Review boundary in one concrete sentence",
    "  --test <command>            Repeatable test command unless --allow-no-tests is used",
    "",
    "Options:",
    "  --repo <path>               Repository path (default: current directory)",
    "  --mode <in-place|worktree>  Execution mode (default: in-place)",
    "  --max-rounds <n>            Maximum review rounds (default: 6)",
    "  --stop-condition <value>    current-clean or no-new-p1p2",
    "  --path <path>               Hard path boundary, repeatable",
    "  --focus <text>              Extra review focus, repeatable",
    "  --extra-instruction <text>  Extra instruction for review and fix prompts",
    "  --model <name>              Optional model override for codex exec",
    "  --codex-timeout-ms <ms>     Per-run timeout for codex exec (default: 180000)",
    "  --search                    Enable live web search in codex exec",
    "  --allow-no-tests            Skip the explicit test requirement",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
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

function runReviewRound({ config, roundNumber, roundDir, targetCwd }) {
  const outputPath = path.join(roundDir, "review-output.json");
  const prompt = buildReviewPrompt({ config, roundNumber, targetCwd });
  const parsed = runCodexStructured({
    cwd: targetCwd,
    sandbox: "read-only",
    schemaPath: REVIEW_SCHEMA_PATH,
    outputPath,
    prompt,
    model: config.model,
    search: config.search,
    timeoutMs: config.codexTimeoutMs,
  });

  const findings = deduplicateFindings(
    (parsed.findings || []).map((finding) => normalizeFinding(finding, targetCwd)),
  );

  return {
    outputPath,
    roundSummary: parsed.round_summary || "",
    findings,
  };
}

function runFixRound({ config, roundNumber, roundDir, targetCwd, activeFindings, baselineTests }) {
  const outputPath = path.join(roundDir, "fix-output.json");
  const prompt = buildFixPrompt({
    config,
    roundNumber,
    targetCwd,
    activeFindings,
    baselineTests,
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
  });
}

function runCodexStructured({ cwd, sandbox, schemaPath, outputPath, prompt, model, search, timeoutMs }) {
  const args = [
    ...CODEX_INVOCATION.baseArgs,
    "exec",
    "-",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    "mcp_servers={}",
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

  if (search) {
    args.push("--search");
  }

  const result = runProcess(CODEX_INVOCATION.command, args, {
    cwd,
    input: prompt,
    timeout: timeoutMs,
  });

  fs.writeFileSync(outputPath.replace(/\.json$/i, ".stdout.log"), result.stdout || "", "utf8");
  fs.writeFileSync(outputPath.replace(/\.json$/i, ".stderr.log"), result.stderr || "", "utf8");

  if (result.status !== 0) {
    fail(`codex exec failed with exit code ${result.status}.\n${formatCommandFailure(result)}`);
  }

  const raw = fs.readFileSync(outputPath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Failed to parse structured Codex output at ${outputPath}: ${error.message}\nRaw output:\n${truncate(raw)}`);
  }
}

function buildReviewPrompt({ config, roundNumber, targetCwd }) {
  const pathLines = config.paths.length === 0
    ? ["- No hard path filter. Use the scope sentence as the boundary."]
    : config.paths.map((item) => `- ${item}`);

  const focusLines = config.focus.map((item) => `- ${item}`);
  const extraInstructionLines = config.extraInstructions.map((item) => `- ${item}`);

  return [
    `You are running review round ${roundNumber} inside a self-iterating review loop.`,
    "",
    "Goal:",
    "Report only concrete P1 or P2 defects that currently exist inside the scoped code.",
    "",
    "Scope:",
    config.scope.trim(),
    "",
    "Hard path boundaries:",
    ...pathLines,
    "",
    "Primary review focus:",
    ...focusLines,
    "",
    "Severity rubric:",
    "- P1: severe incorrectness, data loss or corruption, security or privilege breakage, release-blocking defects.",
    "- P2: concrete regressions, boundary-condition bugs, missing validation, or other high-confidence functional defects.",
    "- P3/P4: ignore them. Do not include style, maintainability, or speculative advice.",
    "",
    "Rules:",
    "- You may inspect repository context outside the scope, but only report findings whose root cause is inside the scope.",
    "- Report only current issues that are still present in this checkout.",
    "- Prefer high-confidence findings. Skip speculation.",
    "- Deduplicate findings within this run.",
    "- Keep titles short and stable.",
    "- `fingerprint_basis` must be a terse and stable phrase describing the bug mechanism.",
    "- Return JSON that matches the provided schema exactly.",
    ...(extraInstructionLines.length > 0
      ? ["", "Extra instructions:", ...extraInstructionLines]
      : []),
  ].join("\n");
}

function buildFixPrompt({ config, roundNumber, targetCwd, activeFindings, baselineTests }) {
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

  const pathLines = config.paths.length === 0
    ? ["- No hard path filter. Respect the scope sentence."]
    : config.paths.map((item) => `- ${item}`);

  const extraInstructionLines = config.extraInstructions.map((item) => `- ${item}`);

  return [
    `You are fixing the output of review round ${roundNumber} in a self-iterating review loop.`,
    "",
    "Goal:",
    "Apply the smallest safe code changes that eliminate the listed active P1/P2 findings.",
    "",
    "Scope:",
    config.scope.trim(),
    "",
    "Hard path boundaries:",
    ...pathLines,
    "",
    "Baseline test state:",
    ...baselineLines,
    "",
    "Active findings:",
    JSON.stringify(findingsPayload, null, 2),
    "",
    "Rules:",
    "- Fix root causes, not symptoms.",
    "- Keep edits inside the scoped code unless a tiny supporting change outside the scope is required to make the fix correct.",
    "- Do not create documentation files.",
    "- Do not rewrite unrelated code.",
    "- If a finding is invalid or blocked, leave the code unchanged and explain it in `notes`.",
    "- Return JSON that matches the provided schema exactly.",
    ...(extraInstructionLines.length > 0
      ? ["", "Extra instructions:", ...extraInstructionLines]
      : []),
  ].join("\n");
}

function runTests(commands, cwd, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  return commands.map((command, index) => {
    const startedAt = Date.now();
    const result = runShellCommand(command, cwd);
    const durationMs = Date.now() - startedAt;
    const record = {
      command,
      exitCode: result.status ?? 1,
      status: (result.status ?? 1) === 0 ? "passed" : "failed",
      durationMs,
      stdoutTail: truncate(result.stdout || ""),
      stderrTail: truncate(result.stderr || ""),
    };

    const filePath = path.join(outputDir, `test-${String(index + 1).padStart(2, "0")}.json`);
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
    run_id: runState.runId,
    repo_name: runState.repoName,
    repo_root: runState.repoRoot,
    target_cwd: runState.targetCwd,
    worktree_path: runState.worktreePath,
    skill_dir: SKILL_DIR,
    config: {
      scope: runState.config.scope,
      mode: runState.config.mode,
      max_rounds: runState.config.maxRounds,
      stop_condition: runState.config.stopCondition,
      tests: runState.config.tests,
      paths: runState.config.paths,
      focus: runState.config.focus,
      extra_instructions: runState.config.extraInstructions,
      model: runState.config.model || null,
      search: runState.config.search,
      allow_no_tests: runState.config.allowNoTests,
    },
    stop_reason: runState.stopReason,
    final_status: runState.finalStatus,
    rounds_executed: runState.rounds.length,
    baseline_tests: runState.baselineTests,
    rounds: runState.rounds.map((round) => ({
      round: round.round,
      review_summary: round.review.roundSummary,
      active_findings: round.activeFindings.map(serializeFindingForReport),
      new_findings: round.newFindings.map(serializeFindingForReport),
      fix: round.fix,
      tests: round.tests,
    })),
    remaining_findings: runState.finalActiveFindings.map(serializeFindingForReport),
    ledger: allFindings.map((entry) => ({
      ...entry,
      currently_active: finalActiveFingerprints.has(entry.fingerprint),
    })),
    artifact_paths: {
      ...runState.artifactPaths,
      final_report_json: path.join(runState.runDir, "final-report.json"),
      final_report_markdown: path.join(runState.runDir, "final-report.md"),
    },
  };
}

function buildMarkdownReport(report) {
  const lines = [
    "# Self Iterating Review Report",
    "",
    `- Run ID: \`${report.run_id}\``,
    `- Final status: \`${report.final_status}\``,
    `- Stop reason: \`${report.stop_reason}\``,
    `- Rounds executed: \`${report.rounds_executed}\``,
    `- Repo root: \`${report.repo_root}\``,
    `- Target workspace: \`${report.target_cwd}\``,
    `- Mode: \`${report.config.mode}\``,
    `- Scope: ${report.config.scope}`,
  ];

  if (report.worktree_path) {
    lines.push(`- Worktree path: \`${report.worktree_path}\``);
  }

  lines.push("", "## Baseline Tests", "");

  if (report.baseline_tests.length === 0) {
    lines.push("- No baseline tests were run.");
  } else {
    for (const test of report.baseline_tests) {
      lines.push(`- \`${test.command}\`: ${test.status}`);
    }
  }

  for (const round of report.rounds) {
    lines.push("", `## Round ${round.round}`, "");
    lines.push(`- Review summary: ${round.review_summary}`);
    lines.push(`- Active P1/P2 findings: ${round.active_findings.length}`);
    lines.push(`- New P1/P2 findings this round: ${round.new_findings.length}`);

    if (round.fix) {
      lines.push(`- Fix status: ${round.fix.status}`);
      lines.push(`- Fix summary: ${round.fix.summary}`);
    } else {
      lines.push("- Fix status: not run");
    }

    if (round.tests.length === 0) {
      lines.push("- Post-fix tests: not run");
    } else {
      for (const test of round.tests) {
        lines.push(`- Post-fix test \`${test.command}\`: ${test.status}`);
      }
    }

    if (round.active_findings.length > 0) {
      lines.push("", "Active findings:");
      for (const finding of round.active_findings) {
        lines.push(`- [${finding.severity}] ${formatFindingLabel(finding)} - ${finding.why}`);
      }
    }
  }

  lines.push("", "## Remaining P1/P2 Findings", "");

  if (report.remaining_findings.length === 0) {
    lines.push("- None.");
  } else {
    for (const finding of report.remaining_findings) {
      lines.push(`- [${finding.severity}] ${formatFindingLabel(finding)} - ${finding.why}`);
    }
  }

  lines.push("", "## Artifacts", "");
  lines.push(`- JSON report: \`${report.artifact_paths.final_report_json}\``);
  lines.push(`- Markdown report: \`${report.artifact_paths.final_report_markdown}\``);
  lines.push(`- Run directory: \`${report.artifact_paths.runDir}\``);

  return `${lines.join("\n")}\n`;
}

function deriveFinalStatus(stopReason, finalActiveFindings) {
  if (stopReason === "clean" && finalActiveFindings.length === 0) {
    return "clean";
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
  };

  normalizedFinding.fingerprint = buildFindingFingerprint(normalizedFinding);
  normalizedFinding.firstSeenRound = null;
  return normalizedFinding;
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
    first_seen_round: finding.firstSeenRound,
  };
}

function formatFindingLabel(finding) {
  const location = finding.file
    ? `${finding.file}${finding.line_start ? `:${finding.line_start}` : ""}`
    : "unknown location";

  return `${finding.title} (${location})`;
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

  if (normalized.startsWith(path.normalize(repoRoot))) {
    return toPosixPath(path.relative(repoRoot, normalized));
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

function runShellCommand(command, cwd) {
  if (process.platform === "win32") {
    return runProcess("powershell", ["-NoLogo", "-NoProfile", "-Command", command], { cwd });
  }

  return runProcess("/bin/sh", ["-lc", command], { cwd });
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
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

function fail(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
  process.exit(1);
}
