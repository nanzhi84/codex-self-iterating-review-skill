---
name: self-iterating-review
description: Run a multi-round fresh-context code review loop for a Git repository. Use when the user asks to start self-iterating review, loop review, fresh-context review, multi-round self-review, or auto-fix and re-review a scoped change set until there are no current P1/P2 findings or a round limit is reached.
---

# Self Iterating Review

## Overview

Use this skill when the user wants Codex to keep reviewing the same scoped change set in fresh non-interactive runs, fix current high-severity defects, run explicit test commands, and stop only when the scoped code is clean at `P1/P2` level or the loop hits a configured round limit.

This skill delegates the loop to the bundled supervisor script:

```powershell
node "<skill-dir>/scripts/review_loop.mjs"
```

Resolve `<skill-dir>` to the installed directory of this skill, then run the bundled script from there. The script uses `codex exec --ephemeral`, so each review run starts with a fresh Codex context instead of reusing the current thread.

On Windows, the supervisor also disables PowerShell profile loading for child `codex exec` runs so local `profile.ps1` customizations do not break the loop.

## Required Inputs

Collect or confirm only these inputs:

- `scope`: required. A concrete sentence that describes exactly what should be reviewed.
- `test commands`: required unless the user explicitly allows a no-test run.
- `max rounds`: optional. Default `6`.
- `mode`: choose `in-place` when uncommitted or staged changes are part of the scope. Choose `worktree` only when the repository is clean and the scope is limited to committed history.

If the user does not provide test commands, ask once. Do not silently invent them.

## Scope Rules

Write one precise scope sentence before calling the script. Good scope lines are concrete:

- `Review the current uncommitted changes under src/payments and tests/payments for correctness, regression, and security issues.`
- `Review the current branch diff against origin/main, but only report findings whose root cause is inside packages/api and packages/shared.`
- `Review commit abc1234 for P1/P2 defects in request validation and auth checks.`

Bad scope lines are too vague:

- `Review my code.`
- `Check the repo carefully.`

Pass hard path boundaries with repeated `--path` flags when they matter.

## Severity Rubric

Only `P1` and `P2` findings belong in this loop.

- `P1`: incorrect behavior with severe impact, data loss or corruption, privilege or security breakage, release-blocking defects.
- `P2`: concrete functional regressions, boundary-condition bugs, missing validation, or other high-confidence defects that are important but not catastrophic.

Ignore style feedback, refactors, polish, and speculative concerns. Those belong outside this loop.

## Invocation Workflow

1. Verify that the target directory is a Git repository.
2. Build one concrete `--scope` string.
3. Choose `--mode in-place` or `--mode worktree`.
4. Pass every explicit test command with its own `--test`.
5. Run the script.
6. Read the final JSON printed to stdout and summarize:
   - why the loop stopped
   - how many rounds ran
   - which `P1/P2` findings were fixed
   - which `P1/P2` findings remain, if any
   - whether tests stayed green
   - where the run artifacts live

## Command Templates

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
  --scope "Review the current branch diff against origin/main for P1/P2 correctness issues." `
  --test "pnpm test" `
  --test "pnpm lint" `
  --mode "worktree" `
  --max-rounds "6"
```

If the user explicitly approves skipping tests, add `--allow-no-tests`.

## Output Expectations

The script writes per-round debug artifacts under `~/.codex/tmp/self-iterating-review/...` and never writes reports into the repository. The final result is printed to stdout as JSON and includes the run configuration, per-round review and fix summaries, test results, remaining `P1/P2` findings, and the artifact paths.

When the script finishes:

- read the final stdout JSON
- mention the worktree path when `worktree` mode was used
- do not create extra documentation files in the repository

## Troubleshooting

This skill depends on local `codex exec` runs. If the loop times out before the first review result and the logs mention `invalid_grant`, `TokenRefreshFailed`, or similar authentication errors, the local Codex CLI or connector login state is stale. Re-authenticate the local Codex CLI first, then retry the loop.
