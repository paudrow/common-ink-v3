# Common Ink

An agent-first markdown notes app hosted at commonink.app. Vocabulary is in `CONTEXT.md`; product spec is in `docs/spec.md`.

## Working agreements

- Prefer larger PRs centered on one feature or one shared piece of the app, with checkpoints for feedback, over many small PRs.
- For features, don't run a long multi-step plan unattended. Stop for feedback after each step. Multi-step bug fixes and refactors can run through.
- Use the Poteto Mode skill when implementing. Build levers, and prioritize verification.
- Have a different model review the code, or at least a fresh worker.
- Always work in a colocated jj workspace: `jj git init --colocate` once in the checkout, then `jj workspace add` for each extra working copy instead of `git worktree`. A PR is one change with a bookmark named for its branch. Stack PRs as a chain of changes; to fix a PR, squash the fix into its change and let jj rebase the ones above, then `jj git push` the bookmarks that moved.
- Every PR gets a local preview: `npm run dev -- --port <port>`, linked as `http://localhost:<port>`. The PR body carries a `<!-- try -->` ... `<!-- /try -->` section that says what the PR adds and walks through trying each new thing; `node scripts/try-note.ts --url <preview> --pr <number>` writes it into the preview as the note `# Try in this PR`. Rerun it whenever the PR adds more. CI's Cloudflare Previews still run, but nobody needs to look at them.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `paudrow/common-ink-v3`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
