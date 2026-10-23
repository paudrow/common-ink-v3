# 20. Usage is counted on the server, not in the browser

Status: proposed on 2026-10-23 with analytics (branch `analytics`). Overrule any of it in review.

## Context

Audrow wants to know how Common Ink is used: how many people come back each week, how many sign up and go on to pay, how much of the writing agents do, and which features matter. Cloudflare had started injecting its Web Analytics beacon into every HTML answer, and the app's Content-Security-Policy blocked it, as it should: the privacy policy says the app loads no script from another site.

A script in the app's pages would run beside every note a member opens. Whatever it reads, the page's address included, could reach another site. It would also miss what matters most in an agent-first app: an agent never loads a page.

## Decision

**The app is counted on the server.** The Worker counts what happens where it already happens (`src/core/usage.ts`): in `perform`, which every operation from the app, the CLI and MCP goes through; where a change to a note lands; and at sign-up, sign-in, a workspace made, an invite taken up and an agent connected. A count holds:

- what happened, from a fixed list of events (`UsageEvent`), and for a feature or an agent's call, a name from Common Ink's own code (`Feature`, `OpType`);
- the workspace's id;
- whether a person, an agent or a plugin did it;
- the person's id hashed under a key derived from `SESSION_SECRET`, so the same person counts once a week but nobody reading the counts can tell who;
- how many, such as the todos one change added;
- the time, which Analytics Engine adds.

Never what a note, title, tag, folder, file name or email says. An embed is counted by its name only when Common Ink ships it (`NOTE_SYNTAX`); a member's own plugin's embed is counted as `plugin`, since its name is theirs.

The counts go to Workers Analytics Engine (`USAGE`). A note change's count is kept with the statement that records the change, and counts only once that statement's batch lands, so a write retried after a conflict counts once, and notes written side by side never count each other. Counts of the same thing by the same person in one operation are written as one data point with how many, so renaming a tag in two hundred notes is one point. Nothing is counted for an operation that fails, and a count that can't be written never fails the operation.

**The site's public pages use Cloudflare Web Analytics.** The landing, the docs, privacy and terms hold nothing of anyone's, so they carry the beacon, written into the page by the Worker when it has a site token (`WEB_ANALYTICS_TOKEN`), under a policy of their own that allows Cloudflare's script and its reports and nothing else. Cloudflare's automatic injection is turned off, so the app's pages, share links and the frames embeds and plugins run in never load it.

**One page reads the counts back.** The Usage page is a page of the app (`src/web/Usage.tsx`), in its theme, beside the member's tabs. Its counts come from `/api/usage`, which answers the admins of the operator's workspace (`USAGE_WORKSPACE`) and is a 404 for anyone else; `/api/me` says whether to offer the page, so nobody else is shown a way to it. `/api/usage` reads Analytics Engine through the Analytics SQL binding (`USAGE_SQL`), so no API token is kept, and keeps each period's answer for ten minutes.

## Consequences

- Agents' work is counted the same way as people's, and can be compared with it.
- No script of anyone else's runs beside a note, and the app's Content-Security-Policy is unchanged.
- What the app counts is decided in review of `src/core/usage.ts`, not by what a third party's script collects. Adding an event is a code change, and so is any widening of what a count holds.
- Analytics Engine keeps three months, and may sample a busy workspace's counts. The Analytics SQL API weighs sums back up; a count of distinct members is of the members kept. Weekly active members over 90 days is the furthest this can see. A longer history would need a rollup kept elsewhere.
- The counts are pseudonymous, not anonymous: whoever holds `SESSION_SECRET` could hash a person's id and find their counts. They stay after an account or workspace is deleted, until they are three months old, and the privacy policy says so.
- A daily note the app makes when someone opens a day is not counted as a note made; what they write in it is counted as edits.
- Todos are counted by how many more open or done ones a change leaves, so a change that adds one todo and checks off another counts only the check.
- Rotating `SESSION_SECRET` changes every member's hash, so a week that spans the rotation counts a person twice.
- Billing (#154) isn't built. `trial_started` and `paid` are named, and the Usage page shows their rows, but nothing counts them until billing does.
- The dev server, Previews, the built Worker CI runs and tests have no `USAGE` or `USAGE_SQL`. There the Dev User stands for the operator, and the page draws made-up numbers and says so.
