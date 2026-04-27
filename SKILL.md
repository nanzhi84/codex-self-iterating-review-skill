---
name: self-iterating-review
description: Run a multi-round fresh-context code review loop for a Git repository. Use when the user asks to start self-iterating review, loop review, fresh-context review, multi-round self-review, or auto-fix and re-review a scoped change set until there are no current fixable findings, business clarification is needed, or a round limit is reached.
---

# Self Iterating Review

## Overview

Use this skill when the user wants Codex to keep reviewing the same scoped change set in fresh non-interactive runs, fix current defects, run explicit test commands, and stop only when the scoped code is clean, a finding requires business clarification, or the loop hits a configured round limit.

This skill delegates the loop to the bundled supervisor script:

```powershell
node "<skill-dir>/scripts/review_loop.mjs"
```

Resolve `<skill-dir>` to the installed directory of this skill, then run the bundled script from there. The script uses `codex exec --ephemeral`, so each review run starts with a fresh Codex context instead of reusing the current thread.

On Windows, the supervisor disables PowerShell profile loading for child `codex exec` runs so local `profile.ps1` customizations do not break the loop. Test commands use PowerShell 7 (`pwsh`) when it is available, then fall back to Windows PowerShell.

## Required Inputs

Collect or confirm only these inputs:

- `scope`: required. A concrete sentence that describes exactly what should be reviewed.
- `test commands`: required unless the user explicitly allows a no-test run.
- `max rounds`: optional. Default `6`.
- `mode`: optional. Default `auto`. In `auto`, use the current checkout when it is already a linked worktree or has uncommitted changes; otherwise create a detached worktree for a clean main checkout. Use explicit `worktree` only when you want another isolated detached worktree.

If the user does not provide test commands, ask once. Do not silently invent them.

## Scope Rules

Write one precise scope sentence before calling the script. Good scope lines are concrete:

- `Review the current uncommitted changes under src/payments and tests/payments for correctness, regression, and security issues.`
- `Review the current branch diff against origin/main, but only report findings whose root cause is inside packages/api and packages/shared.`
- `Review commit abc1234 for concrete defects in request validation and auth checks.`

Bad scope lines are too vague:

- `Review my code.`
- `Check the repo carefully.`

Pass hard path boundaries with repeated `--path` flags when they matter.

When the review target is "the current branch against main", prefer the remote-tracking base if the local branch is stale. In practice:

- use `origin/main` when `main...origin/main` shows local `main` is behind
- only use local `main` when you have verified it reflects the intended base

If the first review round times out or stalls before producing structured output, do not simply keep raising the timeout. Narrow the scope first:

- split by top-level area such as `apps/api` and `apps/web`
- then split further by commit or by a small batch of touched files
- only increase timeout after the scope is already tight

## External Verification

Live web search should be used for child review runs when the local Codex CLI supports it. The supervisor requests `--search` by default, detects whether the installed CLI exposes it as a global flag or an `exec` flag, and uses the supported position. If the installed CLI does not expose that flag, the loop continues without passing it and logs that limitation instead of failing before review starts.

## Severity and Business Rubric

`P1` through `P4` findings belong in this loop when they are concrete and technically fixable.

- `P1`: incorrect behavior with severe impact, data loss or corruption, privilege or security breakage, release-blocking defects.
- `P2`: concrete functional regressions, boundary-condition bugs, missing validation, or other high-confidence defects that are important but not catastrophic.
- `P3`: lower-impact concrete bugs, clear validation gaps, deterministic UI/API inconsistencies, or test coverage gaps with a specific risk.
- `P4`: small but concrete correctness or quality issues that can be fixed without changing product behavior.

Fix all concrete findings regardless of severity. Do not fix style feedback, refactors, polish, or speculative concerns.

If a finding depends on unclear product policy or business semantics, do not invent the rule. Mark it as requiring business confirmation, include the exact question, and stop with that question in the final report.

## Invocation Workflow

1. Verify that the target directory is a Git repository.
2. Build one concrete `--scope` string.
3. Choose `--mode auto`, `--mode in-place`, or `--mode worktree`; omit it only when the default `auto` behavior is intended.
4. Pass every explicit test command with its own `--test`.
5. Optional: use `--plan-only` first when you want to inspect the resolved base and auto-slice plan without launching child Codex runs.
6. Run the script.
7. Read the final JSON printed to stdout and summarize:
   - why the loop stopped
   - how many rounds ran
   - which findings were fixed
   - which findings remain, if any
   - which business questions need human confirmation, if any
   - whether tests stayed green
   - the worktree handoff commit and `git cherry-pick <commit>` command when `worktree` mode created fixes
   - where the run artifacts live

## Command Templates

The examples below use PowerShell line continuation. On macOS or Linux, replace the trailing backticks with `\`.

In-place review for uncommitted work:

```powershell
node "<skill-dir>/scripts/review_loop.mjs" `
  --scope "Review the current uncommitted changes under src/auth for correctness, regression, and security issues." `
  --path "src/auth" `
  --test "pnpm test -- auth" `
  --test "pnpm lint" `
  --mode "in-place"
```

Detached worktree review for a clean repo:

```powershell
node "<skill-dir>/scripts/review_loop.mjs" `
  --scope "Review the current branch diff against origin/main for concrete correctness issues." `
  --test "pnpm test" `
  --test "pnpm lint" `
  --mode "auto" `
  --max-rounds "6"
```

When the current checkout is already a linked worktree, default `auto` mode does not create another worktree. It runs in-place inside that existing worktree.

If the user explicitly approves skipping tests, add `--allow-no-tests`.

Plan-only dry run:

```powershell
node "<skill-dir>/scripts/review_loop.mjs" `
  --scope "Review the current branch diff against main for concrete correctness issues." `
  --mode "in-place" `
  --allow-no-tests `
  --plan-only
```

## Output Expectations

The script writes per-round debug artifacts under `~/.codex/tmp/self-iterating-review/...` and never writes reports into the repository. The final result is printed to stdout as JSON and includes the run configuration, per-round review and fix summaries, test results, remaining findings, business questions, worktree handoff details, and the artifact paths.

The supervisor forces child `codex exec` runs to use a moderate reasoning effort so the loop does not inherit an overly slow global CLI default such as `model_reasoning_effort = "xhigh"`.

Review rounds run with a read-only sandbox by default. If a Windows Codex CLI rejects that sandbox mode, the supervisor retries with `workspace-write` but fails the run if the review round changes the Git working tree.

When post-fix tests fail, the loop carries those failures into the next review and fix prompts as high-priority evidence. The next round should fix the underlying cause when it is inside scope.

When `worktree` mode finishes with code changes, the supervisor stages those changes in the detached worktree and creates a handoff commit. The final JSON includes the commit hash and the `git cherry-pick <commit>` command to apply the fix on the original branch.

When the scope is a clean branch diff against `main` or `origin/main`, the supervisor now:

- resolves the effective base ref before review starts
- prefers `origin/main` when local `main` is behind
- computes a diff-based slice plan before the first child review run
- auto-splits oversized diffs into smaller file batches, grouped by top-level area when possible
- embeds a bounded diff summary and patch excerpt into each child review prompt

Use `--plan-only` to inspect that plan without spending review tokens.

When the script finishes:

- read the final stdout JSON
- mention the worktree path when `worktree` mode was used
- do not create extra documentation files in the repository

## Troubleshooting

This skill depends on local `codex exec` runs. If the loop times out before the first review result and the logs mention `invalid_grant`, `TokenRefreshFailed`, or similar authentication errors, the local Codex CLI or connector login state is stale. Re-authenticate the local Codex CLI first, then retry the loop.

If `worktree` mode rejects a test command because the command references files that only exist in the source workspace, switch to `--mode in-place` or replace the command with a repo-tracked equivalent.
