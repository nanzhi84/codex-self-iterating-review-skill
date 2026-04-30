import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBusinessQuestionId,
  buildFindingFingerprint,
  buildRepairHistoryPromptLines,
  buildResumableSliceMap,
  buildSliceDiffPromptLines,
  detectNoProgressRepairAfterFix,
  detectStalledRepair,
  discoverTestCommands,
  extractGithubActionsRunCommands,
  isLikelyVerificationCommand,
  isPathAllowedByBoundaries,
  markResolvedFindingsAfterReview,
  normalizeFinding,
  recordFixAttemptForFindings,
  resolveScopeBaseRef,
  updateFindingLedger,
  validateFixFindingResults,
} from "./review_loop.mjs";

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
