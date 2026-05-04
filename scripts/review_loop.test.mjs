import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildBusinessQuestionId,
  buildFailureReport,
  buildFindingFingerprint,
  buildRepairHistoryPromptLines,
  buildResumableSliceMap,
  buildReviewPrompt,
  buildSliceDiffPromptLines,
  detectNoProgressRepairAfterFix,
  detectStalledRepair,
  discoverTestCommands,
  extractGithubActionsRunCommands,
  inferReviewProfile,
  isLikelyVerificationCommand,
  isPathAllowedByBoundaries,
  markResolvedFindingsAfterReview,
  normalizeFinding,
  parseArgs,
  recordFixAttemptForFindings,
  resolveScopeBaseRef,
  updateFindingLedger,
  validateFixFindingResults,
} from "./review_loop.mjs";

const REVIEW_LOOP_SCRIPT = fileURLToPath(new URL("./review_loop.mjs", import.meta.url));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sir-test-"));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function runGit(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeFinding(overrides = {}) {
  return normalizeFinding({
    severity: "P2",
    title: "Missing status guard",
    confidence: "high",
    file: "src/app.js",
    line_start: 42,
    line_end: 45,
    why: "Bad state is accepted.",
    repro_or_evidence: "Static inspection.",
    fix_strategy: "Reject bad state.",
    dedupe_key: "accepts invalid state",
    fingerprint_basis: "invalid state accepted",
    requires_business_confirmation: false,
    business_question: null,
    ...overrides,
  }, process.cwd());
}

test("discovers package and GitHub Actions verification commands", () => {
  const repoRoot = makeTempDir();
  writeFile(path.join(repoRoot, "pnpm-lock.yaml"), "");
  writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    scripts: {
      test: "vitest run",
      lint: "eslint .",
    },
  }));
  writeFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), `
name: ci
jobs:
  test:
    steps:
      - run: pnpm install
      - run: pnpm test
      - run: pnpm run typecheck
      - run: echo done
`);

  const plan = discoverTestCommands(repoRoot);

  assert.equal(plan.confidence, "high");
  assert.deepEqual(plan.commands, [
    "pnpm test",
    "pnpm run lint",
    "pnpm run typecheck",
  ]);
});

test("rejects one normal review round because it cannot fix and re-review", () => {
  assert.throws(
    () => execFileSync(process.execPath, [
      REVIEW_LOOP_SCRIPT,
      "--scope",
      "Review the current branch diff for concrete correctness issues.",
      "--max-rounds",
      "1",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    (error) => {
      assert.match(error.stdout, /must be at least 2/);
      return true;
    },
  );
});

test("extracts multi-line GitHub Actions run commands conservatively", () => {
  const commands = extractGithubActionsRunCommands(`
jobs:
  test:
    steps:
      - run: |
          npm ci
          npm test
          npm run lint
      - run: docker build .
`);

  assert(commands.includes("npm test"));
  assert(commands.includes("npm run lint"));
  assert.equal(isLikelyVerificationCommand("npm ci"), false);
  assert.equal(isLikelyVerificationCommand("docker build ."), false);
});

test("infers spec review profile for specification scopes and injects checklist", () => {
  const config = {
    scope: "Review ICEBREAKER_SPEC.md for PR1-ready shared contract and QA acceptance criteria.",
    paths: ["ICEBREAKER_SPEC.md"],
    focus: ["correctness"],
    reviewProfile: "auto",
    extraInstructions: [],
    businessAnswers: {},
  };
  const slice = {
    scope: config.scope,
    paths: config.paths,
    diff: null,
  };

  assert.equal(inferReviewProfile(config, slice), "spec");

  const prompt = buildReviewPrompt({
    config,
    slice,
    roundNumber: 1,
    globalRoundNumber: 1,
    previousFailedTests: [],
    findingLedger: new Map(),
  });

  assert.match(prompt, /Review profile:\n- spec/);
  assert.match(prompt, /state x actor x action transition table/);
  assert.match(prompt, /request\/response\/empty-state\/error schemas/);
  assert.match(prompt, /acceptance criteria mapped to executable tests/);
});

test("auto review profile does not treat common code paths as specs", () => {
  const config = {
    scope: "Review implementation and tests for concrete correctness issues.",
    reviewProfile: "auto",
  };

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["tests/foo.spec.ts"],
  }), "code");

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["requirements.txt"],
  }), "code");

  assert.equal(inferReviewProfile({
    scope: "Review tests/foo.spec.ts for concrete correctness issues.",
    reviewProfile: "auto",
  }, {
    scope: "Review tests/foo.spec.ts for concrete correctness issues.",
    paths: [],
  }), "code");

  assert.equal(inferReviewProfile({
    scope: "Review requirements.txt for dependency changes.",
    reviewProfile: "auto",
  }, {
    scope: "Review requirements.txt for dependency changes.",
    paths: [],
  }), "code");

  for (const codePath of ["src/adr.ts", "src/rfc.ts", "src/prd.ts"]) {
    assert.equal(inferReviewProfile({
      scope: `Review ${codePath} for concrete correctness issues.`,
      reviewProfile: "auto",
    }, {
      scope: `Review ${codePath} for concrete correctness issues.`,
      paths: [codePath],
    }), "code");
  }
});

test("auto review profile keeps code slices on code profile in mixed spec scopes", () => {
  const config = {
    scope: "Review API contract and implementation changes for correctness.",
    reviewProfile: "auto",
  };

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["src/api.ts"],
  }), "code");

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["API_CONTRACT.md"],
  }), "spec");
});

test("auto review profile treats explicit spec scopes with spec directories as spec", () => {
  const config = {
    scope: "Review product spec document under docs/specs for contract gaps.",
    reviewProfile: "auto",
  };

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["docs/specs"],
  }), "spec");

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: ["src/api.ts"],
  }), "code");
});

test("infers spec review profile from obvious spec filenames in scope text", () => {
  const config = {
    scope: "Review ICEBREAKER_SPEC.md for concrete defects.",
    reviewProfile: "auto",
  };

  assert.equal(inferReviewProfile(config, {
    scope: config.scope,
    paths: [],
  }), "spec");
});

test("resume keeps an explicit auto review profile instead of inheriting the previous run", () => {
  const resumeDir = makeTempDir();
  writeFile(path.join(resumeDir, "final-report.json"), JSON.stringify({
    config: {
      scope: "Review previous scope.",
      review_profile: "spec",
    },
  }));

  const resumedConfig = parseArgs([
    "--resume", resumeDir,
    "--scope", "Review src/foo.ts for concrete correctness issues.",
    "--path", "src/foo.ts",
    "--review-profile", "auto",
  ]);

  assert.equal(resumedConfig.reviewProfile, "auto");
  assert.equal(inferReviewProfile(resumedConfig, {
    scope: resumedConfig.scope,
    paths: resumedConfig.paths,
  }), "code");
});

test("resume keeps explicit auto review profile after a previous code run", () => {
  const resumeDir = makeTempDir();
  writeFile(path.join(resumeDir, "final-report.json"), JSON.stringify({
    config: {
      scope: "Review previous scope.",
      review_profile: "code",
    },
  }));

  const resumedConfig = parseArgs([
    "--resume", resumeDir,
    "--scope", "Review API_CONTRACT.md for missing acceptance criteria.",
    "--path", "API_CONTRACT.md",
    "--review-profile", "auto",
  ]);

  assert.equal(resumedConfig.reviewProfile, "auto");
  assert.equal(inferReviewProfile(resumedConfig, {
    scope: resumedConfig.scope,
    paths: resumedConfig.paths,
  }), "spec");
});

test("resume inherits prompt contract inputs when they are not overridden", () => {
  const resumeDir = makeTempDir();
  writeFile(path.join(resumeDir, "final-report.json"), JSON.stringify({
    config: {
      scope: "Review src/api.ts.",
      paths: ["src/api.ts"],
      focus: ["correctness", "regression", "seed findings"],
      review_profile: "code",
      extra_instructions: ["Re-check pasted QA findings as seed evidence."],
    },
  }));

  const resumedConfig = parseArgs([
    "--resume", resumeDir,
  ]);

  assert.deepEqual(resumedConfig.focus, ["correctness", "regression", "seed findings"]);
  assert.deepEqual(resumedConfig.extraInstructions, ["Re-check pasted QA findings as seed evidence."]);
});

test("infers origin/main for current branch diff scope", () => {
  const repoRoot = makeTempDir();
  runGit(repoRoot, ["init", "-b", "main"]);
  runGit(repoRoot, ["config", "user.name", "Test"]);
  runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  writeFile(path.join(repoRoot, "README.md"), "test\n");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "initial"]);
  runGit(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  runGit(repoRoot, ["checkout", "-b", "feature"]);

  const resolution = resolveScopeBaseRef(
    repoRoot,
    "Review the current branch diff for concrete correctness issues.",
    {},
  );

  assert.equal(resolution.resolvedRef, "origin/main");
  assert.equal(resolution.reason, "default-branch-candidate");
});

test("finding fingerprint ignores title and severity churn", () => {
  const first = normalizeFinding({
    severity: "P2",
    title: "Missing status guard",
    confidence: "high",
    file: "src/app.js",
    line_start: 42,
    line_end: 45,
    why: "Bad state is accepted.",
    repro_or_evidence: "Static inspection.",
    fix_strategy: "Reject bad state.",
    dedupe_key: "accepts invalid state",
    fingerprint_basis: "invalid state accepted",
    requires_business_confirmation: false,
    business_question: null,
  }, process.cwd());
  const second = normalizeFinding({
    severity: "P3",
    title: "Invalid state accepted",
    confidence: "high",
    file: "src/app.js",
    line_start: 43,
    line_end: 45,
    why: "Bad state is accepted.",
    repro_or_evidence: "Static inspection.",
    fix_strategy: "Reject bad state.",
    dedupe_key: "accepts invalid state",
    fingerprint_basis: "invalid state accepted",
    requires_business_confirmation: false,
    business_question: null,
  }, process.cwd());

  assert.equal(buildFindingFingerprint(first), buildFindingFingerprint(second));
});

test("business question ids and resume slice reuse are stable", () => {
  const question = {
    file: "src/app.js",
    title: "Confirm state policy",
    question: "Should archived items be editable?",
    blockedFindings: ["Confirm state policy"],
  };

  assert.equal(buildBusinessQuestionId(question), buildBusinessQuestionId({ ...question }));

  const resumable = buildResumableSliceMap({
    run_id: "previous",
    slices: [
      {
        id: "slice-01",
        label: "api",
        scope: "Review api.",
        base_ref: "origin/main",
        paths: ["api"],
        stop_reason: "clean",
        final_active_findings: [],
      },
      {
        id: "slice-02",
        label: "web",
        stop_reason: "max-rounds",
        final_active_findings: [{ title: "still open" }],
      },
    ],
  });

  assert.equal(resumable.has("slice-01"), true);
  assert.equal(resumable.has("slice-02"), false);
});

test("resume does not reuse a clean slice when the effective review profile changes", () => {
  const previousReport = {
    run_id: "previous",
    config: {
      review_profile: "code",
    },
    slices: [
      {
        id: "slice-01",
        label: "spec",
        scope: "Review API_SPEC.md.",
        paths: ["API_SPEC.md"],
        stop_reason: "clean",
        final_active_findings: [],
      },
    ],
  };
  const plannedSlice = {
    id: "slice-01",
    label: "spec",
    scope: "Review API_SPEC.md.",
    paths: ["API_SPEC.md"],
    reviewProfile: "spec",
  };

  const resumable = buildResumableSliceMap(previousReport, {
    config: { reviewProfile: "spec", scope: "Review API_SPEC.md." },
    plannedSlices: [plannedSlice],
  });

  assert.equal(resumable.has("slice-01"), false);
});

test("resume does not reuse a clean slice when the reviewed boundary changes", () => {
  const previousReport = {
    run_id: "previous",
    config: {
      review_profile: "code",
    },
    slices: [
      {
        id: "slice-01",
        label: "docs",
        scope: "Review README.md.",
        paths: ["README.md"],
        base_ref: "origin/main",
        review_profile: "code",
        stop_reason: "clean",
        final_active_findings: [],
      },
    ],
  };

  assert.equal(buildResumableSliceMap(previousReport, {
    config: { reviewProfile: "code", scope: "Review SKILL.md." },
    plannedSlices: [{
      id: "slice-01",
      label: "docs",
      scope: "Review SKILL.md.",
      paths: ["SKILL.md"],
      baseRef: "origin/main",
      reviewProfile: "code",
    }],
  }).has("slice-01"), false);

  assert.equal(buildResumableSliceMap(previousReport, {
    config: { reviewProfile: "code", scope: "Review README.md." },
    plannedSlices: [{
      id: "slice-01",
      label: "docs",
      scope: "Review README.md.",
      paths: ["README.md"],
      baseRef: "HEAD~1",
      reviewProfile: "code",
    }],
  }).has("slice-01"), false);
});

test("resume does not reuse a clean slice when extra instructions change", () => {
  const previousReport = {
    run_id: "previous",
    config: {
      focus: ["correctness", "regression", "security"],
      review_profile: "code",
      extra_instructions: [],
    },
    slices: [
      {
        id: "slice-01",
        label: "api",
        scope: "Review src/api.ts.",
        paths: ["src/api.ts"],
        base_ref: "origin/main",
        review_profile: "code",
        stop_reason: "clean",
        final_active_findings: [],
      },
    ],
  };

  const resumable = buildResumableSliceMap(previousReport, {
    config: {
      focus: ["correctness", "regression", "security"],
      reviewProfile: "code",
      extraInstructions: ["Re-check pasted QA findings as seed evidence."],
      scope: "Review src/api.ts.",
    },
    plannedSlices: [{
      id: "slice-01",
      label: "api",
      scope: "Review src/api.ts.",
      paths: ["src/api.ts"],
      baseRef: "origin/main",
      reviewProfile: "code",
    }],
  });

  assert.equal(resumable.has("slice-01"), false);
});

test("resume does not reuse a clean slice when review focus changes", () => {
  const previousReport = {
    run_id: "previous",
    config: {
      focus: ["correctness", "regression", "security"],
      review_profile: "code",
      extra_instructions: [],
    },
    slices: [
      {
        id: "slice-01",
        label: "api",
        scope: "Review src/api.ts.",
        paths: ["src/api.ts"],
        base_ref: "origin/main",
        review_profile: "code",
        stop_reason: "clean",
        final_active_findings: [],
      },
    ],
  };

  const resumable = buildResumableSliceMap(previousReport, {
    config: {
      focus: ["correctness", "regression", "security", "prompt-contract regressions"],
      reviewProfile: "code",
      extraInstructions: [],
      scope: "Review src/api.ts.",
    },
    plannedSlices: [{
      id: "slice-01",
      label: "api",
      scope: "Review src/api.ts.",
      paths: ["src/api.ts"],
      baseRef: "origin/main",
      reviewProfile: "code",
    }],
  });

  assert.equal(resumable.has("slice-01"), false);
});

test("resume reuses a clean slice when the effective review profile is unchanged", () => {
  const previousReport = {
    run_id: "previous",
    config: {
      review_profile: "spec",
    },
    slices: [
      {
        id: "slice-01",
        label: "spec",
        scope: "Review API_SPEC.md.",
        paths: ["API_SPEC.md"],
        review_profile: "spec",
        stop_reason: "clean",
        final_active_findings: [],
      },
    ],
  };
  const plannedSlice = {
    id: "slice-01",
    label: "spec",
    scope: "Review API_SPEC.md.",
    paths: ["API_SPEC.md"],
    reviewProfile: "spec",
  };

  const resumable = buildResumableSliceMap(previousReport, {
    config: { reviewProfile: "spec", scope: "Review API_SPEC.md." },
    plannedSlices: [plannedSlice],
  });

  assert.equal(resumable.has("slice-01"), true);
  assert.equal(resumable.get("slice-01").reviewProfile, "spec");
});

test("failure reports serialize clean slices in a resumable shape", () => {
  const failureReport = buildFailureReport(new Error("review failed"), {
    runId: "failed-run",
    repoName: "repo",
    repoRoot: "/repo",
    targetCwd: "/repo",
    worktreePath: "/repo",
    resolvedBaseRef: "origin/main",
    baseResolution: null,
    rounds: [],
    config: {
      scope: "Review README.md.",
      requestedMode: "fresh-worktree",
      mode: "fresh-worktree",
      baseRef: "origin/main",
      maxRounds: 2,
      stopCondition: "no-new-p1p2",
      tests: [],
      testPlan: null,
      testTimeoutMs: 120000,
      paths: ["README.md"],
      allowSupportPaths: [],
      focus: [],
      reviewProfile: "code",
      extraInstructions: [],
      search: true,
      allowNoTests: false,
      autoApplyWorktree: false,
      businessAnswers: {},
      planOnly: false,
    },
    artifactPaths: {},
    baselineTests: [],
    slicePlan: [],
    slices: [{
      id: "slice-01",
      label: "docs",
      scope: "Review README.md.",
      baseRef: "origin/main",
      reviewProfile: "code",
      paths: ["README.md"],
      resumedFrom: null,
      stopReason: "clean",
      finalActiveFindings: [],
      rounds: [],
    }],
  });

  const resumable = buildResumableSliceMap(failureReport, {
    config: {
      focus: [],
      reviewProfile: "code",
      extraInstructions: [],
      scope: "Review README.md.",
    },
    plannedSlices: [{
      id: "slice-01",
      label: "docs",
      scope: "Review README.md.",
      paths: ["README.md"],
      baseRef: "origin/main",
      reviewProfile: "code",
    }],
  });

  assert.equal(failureReport.slices[0].stop_reason, "clean");
  assert.equal(resumable.has("slice-01"), true);
});

test("repair history records per-finding fix outcomes for later rounds", () => {
  const finding = makeFinding();
  const ledger = new Map();
  updateFindingLedger(ledger, [finding], 1);
  recordFixAttemptForFindings(ledger, [finding], {
    status: "partial",
    summary: "Added one guard but follow-up validation remains.",
    changed_files: ["src/app.js"],
    finding_results: [{
      fingerprint: finding.fingerprint,
      status: "partially_fixed",
      summary: "Added an early status guard.",
      reason: "A second call path still needs validation.",
    }],
    notes: ["Follow-up required."],
  }, 1);

  const historyLines = buildRepairHistoryPromptLines(ledger);

  assert.match(historyLines.join("\n"), new RegExp(finding.fingerprint));
  assert.match(historyLines.join("\n"), /latest_fix_status=partially_fixed/);
  assert.equal(ledger.get(finding.fingerprint).fixAttempts[0].reason, "A second call path still needs validation.");
});

test("resolved findings stay in compressed history after they disappear", () => {
  const finding = makeFinding();
  const ledger = new Map();
  updateFindingLedger(ledger, [finding], 1);
  recordFixAttemptForFindings(ledger, [finding], {
    status: "applied",
    summary: "Added status validation.",
    changed_files: ["src/app.js"],
    finding_results: [{
      fingerprint: finding.fingerprint,
      status: "fixed",
      summary: "Added a guard for archived state.",
      reason: "Invalid state is now rejected before mutation.",
    }],
    notes: [],
  }, 1);
  markResolvedFindingsAfterReview({
    ledger,
    previousRound: {
      activeFindings: [finding],
      blockedFindings: [],
    },
    currentFindings: [],
    roundNumber: 2,
  });

  const entry = ledger.get(finding.fingerprint);
  const historyLines = buildRepairHistoryPromptLines(ledger);

  assert.equal(entry.status, "fixed");
  assert.equal(entry.resolvedRound, 2);
  assert.match(historyLines.join("\n"), /status=fixed/);
  assert.match(historyLines.join("\n"), /latest_fix_summary=Added a guard/);
});

test("diff prompt uses summary only and omits patch bodies", () => {
  const patch = [
    "diff --git a/src/app.js b/src/app.js",
    "@@ -1,3 +1,4 @@",
    "-dangerousCall()",
    "+safeCall()",
  ].join("\n");
  const lines = buildSliceDiffPromptLines({
    label: "full-scope",
    diff: {
      baseRef: "origin/main",
      fileCount: 2,
      insertions: 10,
      deletions: 4,
      files: [
        { path: "src/app.js", insertions: 8, deletions: 4 },
        { path: "src/util.js", insertions: 2, deletions: 0 },
      ],
      statText: " src/app.js | 12 +++++---\n src/util.js | 2 ++",
      patchExcerpt: patch,
      patchWasTruncated: false,
    },
  });
  const promptText = lines.join("\n");

  assert.match(promptText, /Changed files in slice: 2/);
  assert.match(promptText, /Full patch is intentionally omitted/);
  assert.doesNotMatch(promptText, /dangerousCall/);
  assert.doesNotMatch(promptText, /```diff/);
});

test("stalled repair is detected when the same finding repeats after failed fix attempts", () => {
  const finding = makeFinding();
  const ledger = new Map();
  updateFindingLedger(ledger, [finding], 1);
  recordFixAttemptForFindings(ledger, [finding], {
    status: "partial",
    summary: "First attempt.",
    changed_files: ["src/app.js"],
    finding_results: [{
      fingerprint: finding.fingerprint,
      status: "partially_fixed",
      summary: "Changed one branch.",
      reason: "The alternate branch remains.",
    }],
    notes: [],
  }, 1);
  updateFindingLedger(ledger, [finding], 2);
  recordFixAttemptForFindings(ledger, [finding], {
    status: "applied",
    summary: "Second attempt.",
    changed_files: ["src/app.js"],
    finding_results: [{
      fingerprint: finding.fingerprint,
      status: "fixed",
      summary: "Adjusted the second branch.",
      reason: "Expected to reject the bad state.",
    }],
    notes: [],
  }, 2);
  updateFindingLedger(ledger, [finding], 3);

  const stalled = detectStalledRepair({
    ledger,
    activeFindings: [finding],
    previousRound: null,
  });

  assert.equal(stalled.reason, "repeated-finding-no-progress");
  assert.equal(stalled.findings[0].fingerprint, finding.fingerprint);
  assert.match(stalled.findings[0].reason, /appeared 3 time/);
});

test("no-progress fix output can stop the loop immediately", () => {
  const finding = makeFinding();
  const stalled = detectNoProgressRepairAfterFix({
    activeFindings: [finding],
    fixResult: {
      status: "no-op",
      summary: "Could not find a safe change.",
      changed_files: [],
      finding_results: [{
        fingerprint: finding.fingerprint,
        status: "no_progress",
        summary: "No code changed.",
        reason: "The required behavior is unclear.",
      }],
      notes: ["Needs human direction."],
    },
  });

  assert.equal(stalled.reason, "fix-round-reported-no-progress");
  assert.equal(stalled.findings[0].status, "no_progress");
  assert.equal(stalled.findings[0].reason, "The required behavior is unclear.");
});

test("fix output must report exactly one result per active finding", () => {
  const finding = makeFinding();
  assert.doesNotThrow(() => validateFixFindingResults({
    status: "applied",
    summary: "Fixed.",
    changed_files: ["src/app.js"],
    finding_results: [{
      fingerprint: finding.fingerprint,
      status: "fixed",
      summary: "Added validation.",
      reason: "The invalid state is now rejected.",
    }],
    notes: [],
  }, [finding], {
    outputPath: "fix-output.json",
    roundNumber: 1,
    targetCwd: process.cwd(),
  }));

  assert.throws(() => validateFixFindingResults({
    status: "applied",
    summary: "Missing structured result.",
    changed_files: ["src/app.js"],
    finding_results: [],
    notes: [],
  }, [finding], {
    outputPath: "fix-output.json",
    roundNumber: 1,
    targetCwd: process.cwd(),
  }), /exactly one finding_results entry/);
});

test("path guard allows nested paths only under configured boundaries", () => {
  assert.equal(isPathAllowedByBoundaries("src/auth/login.ts", ["src/auth"]), true);
  assert.equal(isPathAllowedByBoundaries("src/other/login.ts", ["src/auth"]), false);
});
