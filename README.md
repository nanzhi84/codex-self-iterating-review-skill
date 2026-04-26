# self-iterating-review

`self-iterating-review` is a Codex skill for running multi-round review loops in fresh contexts. Each review round is executed with `codex exec --ephemeral`, so the reviewer does not inherit the current thread state. The loop can review a scoped change set, surface current findings, launch a separate fresh fixing run, execute explicit test commands, and stop when the scope is clean, business confirmation is needed, or when a round limit is reached.

The repository contains two layers:

- `SKILL.md`: the Codex-facing trigger and workflow instructions.
- `scripts/review_loop.mjs`: the supervisor that orchestrates review, fix, test, reporting, and stop conditions.

## What It Does

- Runs review rounds in fresh non-interactive Codex sessions.
- Fixes concrete `P1` through `P4` findings.
- Stops and reports questions when a finding depends on unclear business semantics.
- Supports `auto`, `in-place`, and detached `worktree` mode.
- Defaults to `auto`: use the current checkout when it is already a linked worktree or has uncommitted changes, otherwise create a detached worktree for a clean main checkout.
- Creates a handoff commit in `worktree` mode when fixes are made.
- Tracks findings across rounds with stable fingerprints.
- Writes structured artifacts and a final report under `~/.codex/tmp/self-iterating-review/...`.

## Repository Layout

```text
self-iterating-review/
├── SKILL.md
├── README.md
├── .gitignore
├── agents/
│   └── openai.yaml
└── scripts/
    ├── review_loop.mjs
    ├── review-output.schema.json
    └── fix-output.schema.json
```

## Requirements

- Codex CLI with working `codex exec`
- Node.js 18+
- Git
- A Git repository to review

If `codex exec` is not healthy, the loop will fail before the first review round. In practice the most common blocker is stale local authentication. If the logs mention `invalid_grant`, `TokenRefreshFailed`, or similar auth errors, re-authenticate Codex CLI first and retry.

## Installation

Clone or copy this directory into your Codex skills directory:

```text
~/.codex/skills/self-iterating-review
```

After installation, Codex can trigger the skill from natural language requests such as:

- `Start a self-iterating review for this branch.`
- `Review this scoped change set in fresh rounds until it is clean.`
- `Use fresh-context review to fix concrete findings and stop if business confirmation is needed.`

## Usage

Run the supervisor directly:

```powershell
node "<skill-dir>/scripts/review_loop.mjs" `
  --scope "Review the current branch diff against origin/main for concrete correctness, regression, and security defects." `
  --path "src" `
  --test "pnpm test" `
  --test "pnpm lint" `
  --mode "auto" `
  --max-rounds "6"
```

### Important Flags

- `--scope`: one concrete sentence describing the review boundary
- `--test`: repeatable explicit test command
- `--path`: repeatable hard path boundary inside the repository
- `--mode auto|in-place|worktree`: choose automatic behavior, the current checkout, or a detached worktree; default is `auto`
- `--max-rounds`: upper bound for the loop
- `--stop-condition current-clean|no-new-p1p2`: choose the stop rule
- `--allow-no-tests`: allow a no-test run only when explicitly desired
- `--codex-timeout-ms`: per-run timeout for each fresh Codex session
- `--search`: live web search is enabled by default in child `codex exec` runs; the run fails if the local CLI cannot support it

## Output

Each run creates a timestamped directory under:

```text
~/.codex/tmp/self-iterating-review/<run-id>/
```

Typical artifacts include:

- baseline test results
- per-round review stdout/stderr logs
- per-round structured review output
- per-round structured fix output
- final structured JSON printed to stdout
- a worktree handoff commit and `git cherry-pick <commit>` command when `worktree` mode created fixes
- artifact paths that point back to the per-run debug directory

## Design Notes

The core requirement behind this skill is not “review repeatedly” in the same thread. It is “review repeatedly with bounded machine state and fresh model context”. That is why the loop keeps state outside Codex conversation memory and re-enters Codex through `codex exec --ephemeral` on every round.

This repository intentionally keeps the skill small. The supervisor script uses only Node.js built-ins and delegates code understanding and code edits to Codex itself. It does not invent product policy: findings that require business confirmation are reported as questions instead of being automatically fixed.
