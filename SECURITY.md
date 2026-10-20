# Security

Common Ink holds people's notes and acts for their agents, so a hole in it is someone's private writing. If you find one, please tell us privately first.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting for this repository: open [Report a vulnerability](https://github.com/paudrow/common-ink-v3/security/advisories/new) (the Security tab, then "Report a vulnerability"). Only the maintainers see the report, and the fix can be worked out with you in a private advisory.

Please don't open a public issue, pull request or discussion about it, and don't post it elsewhere, until a fix is out.

### What to include

- What an attacker can do, and to whom: read someone else's note, act as another member, reach another workspace, run script in the app, keep access after it was taken away, and so on.
- The steps to reproduce it, from a fresh account where you can: the requests, the note text, the plugin or embed, the agent token's options.
- Where it happens: the address (`commonink.app`, a page, `/api/...`, `/mcp`), and for the code, the file and line if you know them.
- What you used: browser and version, MCP client, the `ink` CLI.
- Anything you saw that belongs to someone else, so it can be dealt with. Don't keep a copy of it.

### What to expect

- An acknowledgement that the report was received. The maintainer aims to send it within 7 days.
- A first assessment (whether it reproduces, how severe it is, what is in the way of a fix) as soon as one is known, and news as the fix goes on.
- When it is fixed and deployed, the advisory is published, crediting you unless you would rather not be named.

Common Ink is maintained by one person and has no bug bounty.

## Scope

In scope:

- The app at `commonink.app`, its Worker and every route it answers: the pages, sign-in (`/auth/...`), the API (`/api/...`), share links (`/s/...`), the HTML embed document (`/embed-frame`), and the MCP endpoint (`/mcp`).
- Access: roles, guests and grants, private notes, folder limits, agent tokens and their options, share links, invites, signing out everywhere. Anything that lets one person, agent or link reach more than it was given.
- Workspace isolation: reaching another workspace's notes, members or history.
- What runs in the page: the content security policy, plugins and their sandbox, HTML embeds, media embeds, note markdown.
- Secrets: session cookies, agent tokens, Google tokens, share link tokens, and any of them reaching a log, a URL, another site or another person.
- The code in this repository, including the `ink` CLI (`scripts/ink-cli.ts`) and the migrations.

Out of scope:

- Previews: the per-PR test deployments at `*-common-ink-v3-previews.draftox.workers.dev`, on a Worker of their own. They sign anyone in as a test user on purpose and hold no real notes. A way to turn that on in production is in scope.
- Denial of service by volume, and rate limits with no further harm.
- Anything that needs the victim's unlocked device, browser profile or Google account, or a malicious browser extension.
- Social engineering of people, phishing, and physical attacks.
- Google's and Cloudflare's own services. Report those to them. How Common Ink uses them is in scope.
- Reports from automated scanners with no shown impact, such as a missing header or cookie flag on its own, or software versions.
- Self-XSS: script a person can only run against themself.

## What a backup keeps

The database is D1, whose Time Travel can restore it to any minute of the last 30 days. So a note purged from Trash, or a revoked token's hash, is gone from the app at once, and from Time Travel's history 30 days later. An upload purged from Trash is deleted from R2 when it is purged.

## Testing

Test against your own account and workspaces, and agents you connected. Don't read, change or delete anyone else's data, don't degrade the service for others, and stop and report as soon as you reach something that isn't yours. Work done in good faith within these lines will not be pursued.
