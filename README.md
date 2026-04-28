# self-iterating-review

`self-iterating-review` is a Codex skill for running multi-round review loops in fresh contexts. Each review round is executed with `codex exec --ephemeral`, so the reviewer does not inherit the current thread state. The loop can review a scoped change set, surface current findings, launch a separate fresh fixing run, execute explicit or auto-discovered test commands, and stop when the scope is clean, business confirmation is needed, or when a round limit is reached.

The repository contains two layers:

- `SKILL.md`: the Codex-facing trigger and workflow instructions.
- `scripts/review_loop.mjs`: the supervisor that orchestrates review, fix, test, reporting, and stop conditions.

## What It Does

- Runs review rounds in fresh non-interactive Codex sessions.
- Requests live web search using the flag position supported by the installed Codex CLI.
- Auto-discovers common test commands when none are provided.
- Fixes concrete `P1` through `P4` findings.
- Stops and reports questions when a finding depends on unclear business semantics.
- Keeps review rounds read-only by default; if Windows requires a writable sandbox, the supervisor checks a Git workspace snapshot afterward.
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
- PowerShell 7 (`pwsh`) is recommended on Windows; Windows PowerShell is used as a fallback.

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

Run the supervisor directly. This example uses PowerShell line continuation:

```powershell
node "<skill-dir>/scripts/review_loop.mjs" `
  --scope "Review the current branch diff against origin/main for concrete correctness, regression, and security defects." `
  --path "src" `
  --mode "auto" `
  --max-rounds "6"
```

On macOS or Linux, use shell line continuation instead:

```bash
node "<skill-dir>/scripts/review_loop.mjs" \
  --scope "Review the current branch diff against origin/main for concrete correctness, regression, and security defects." \
  --path "src" \
  --mode "auto" \
  --max-rounds "6"
```

### Important Flags

- `--scope`: one concrete sentence describing the review boundary
- `--test`: repeatable explicit test command; auto-discovered when omitted
- `--path`: repeatable hard path boundary inside the repository
- `--mode auto|in-place|worktree`: choose automatic behavior, the current checkout, or a detached worktree; default is `auto`
- `--max-rounds`: upper bound for the loop
- `--stop-condition current-clean|no-new-p1p2`: choose the stop rule
- `--allow-no-tests`: allow a no-test run only when explicitly desired
- `--codex-timeout-ms`: per-run timeout for each fresh Codex session
- `--test-timeout-ms`: per-command test timeout; default is 30 minutes
- `--search`: request live web search when the installed Codex CLI exposes a supported flag position

## Output

Each run creates a timestamped directory under:

```text
~/.codex/tmp/self-iterating-review/<run-id>/
```

Typical artifacts include:

- baseline test results
- auto-discovered or explicit test plan
- per-round review stdout/stderr logs
- per-round structured review output
- per-round structured fix output
- final structured JSON printed to stdout
- a worktree handoff commit and `git cherry-pick <commit>` command when `worktree` mode created fixes
- artifact paths that point back to the per-run debug directory

## Design Notes

The core requirement behind this skill is not “review repeatedly” in the same thread. It is “review repeatedly with bounded machine state and fresh model context”. That is why the loop keeps state outside Codex conversation memory and re-enters Codex through `codex exec --ephemeral` on every round.

Review runs are expected to inspect code without changing it. The supervisor compares the workspace before and after review using staged and unstaged diffs plus untracked file metadata and hashes, so already-dirty files are still protected from accidental review edits.

This repository intentionally keeps the skill small. The supervisor script uses only Node.js built-ins and delegates code understanding and code edits to Codex itself. It does not invent product policy: findings that require business confirmation are reported as questions instead of being automatically fixed.
