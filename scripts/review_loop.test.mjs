import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBusinessQuestionId,
  buildFindingFingerprint,
  buildResumableSliceMap,
  discoverTestCommands,
  extractGithubActionsRunCommands,
  isLikelyVerificationCommand,
  isPathAllowedByBoundaries,
  normalizeFinding,
  resolveScopeBaseRef,
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

test("path guard allows nested paths only under configured boundaries", () => {
  assert.equal(isPathAllowedByBoundaries("src/auth/login.ts", ["src/auth"]), true);
  assert.equal(isPathAllowedByBoundaries("src/other/login.ts", ["src/auth"]), false);
});
