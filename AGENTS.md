# Common Ink

An agent-first markdown notes app hosted at commonink.app. Vocabulary is in `CONTEXT.md`; product spec is in `docs/spec.md`.

## Working agreements

- Prefer larger PRs centered on one feature or one shared piece of the app, with checkpoints for feedback, over many small PRs.
- For features, don't run a long multi-step plan unattended. Stop for feedback after each step. Multi-step bug fixes and refactors can run through.
- Use the Poteto Mode skill when implementing. Build levers, and prioritize verification.
- Have a different model review the code, or at least a fresh worker.
- Every PR gets a live preview on Cloudflare Workers.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `paudrow/common-ink-v3`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
