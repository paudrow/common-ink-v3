# Analytics

What Common Ink counts, and how to turn each part on. Why it is built this way is in `docs/adr/0020-usage-is-counted-on-the-server-not-in-the-browser.md`.

## Web Analytics on the public pages

The landing, `/docs`, `/privacy` and `/terms` carry Cloudflare's Web Analytics beacon when the Worker has a site token. The app's pages never do.

1. In the Cloudflare dashboard, open Web Analytics and the site for commonink.app.
2. Switch it from automatic setup to manual setup (the JS snippet). This stops Cloudflare injecting the beacon into every page, the app's included, where the app's policy blocks it and the browser reports an error.
3. Copy the site token: the `token` value in the snippet Cloudflare shows, 32 characters.
4. Give it to the Worker:

   ```bash
   npx wrangler secret put WEB_ANALYTICS_TOKEN
   ```

To check it: `curl -s https://commonink.app/privacy | grep cloudflareinsights` shows the script, and `curl -s https://commonink.app/settings | grep cloudflareinsights` shows nothing. To stop it, delete the secret.

## Counts of how the app is used

The Worker writes each count to the Analytics Engine dataset `common_ink_usage` (the `USAGE` binding in `wrangler.jsonc`). Analytics Engine makes the dataset on the first write, so nothing else is set up. Each data point is:

| Column | Holds |
|---|---|
| `index1` | the workspace's id, or `-` for signing up and in |
| `blob1` | the event, from `UsageEvent` in `src/core/usage.ts` |
| `blob2` | `person`, `agent` or `plugin` |
| `blob3` | the feature, or the operation an agent called |
| `blob4` | the person's id, hashed under a key from `SESSION_SECRET` |
| `double1` | how many |

## The Usage page

The Usage page is a page of the app, at `/usage`, offered in the workspace menu and the command palette (Go to Usage) to those who may read it and to nobody else. It shows weekly and daily active members, sign-ups to trials to paid, notes and edits by people and agents, top features and what agents call, over 7, 30 or 90 days. Its counts come from `/api/usage`, which reads the dataset through the Analytics SQL binding (`USAGE_SQL`), so no API token is kept, and answers 404 to anyone who may not read it.

Only the admins of the operator's workspace see it. That workspace is Audrow's, `aya0dfol2jvi`, named by `USAGE_WORKSPACE` in `wrangler.jsonc`'s `vars`. It is an id, not a secret, and a deploy replaces the Worker's settings with what `wrangler.jsonc` says, so it is kept there rather than set in the dashboard. To hand the page to another workspace's admins, change that id and deploy.

This machine, Previews and the built Worker CI runs set it empty. There dev sign-in is on and nothing is counted, so the Dev User (`dev@common.ink`, whom they sign you in as) stands for the operator and sees made-up numbers, marked as such, and nobody else sees the page. Anywhere else with it empty, nobody is offered the page and `/api/usage` answers 404 to everyone.

To read the counts yourself, `SELECT ... FROM events.analyticsEngine.common_ink_usage WHERE timestamp >= NOW() - INTERVAL '7' DAY` works in the dashboard's SQL editor or through the SQL API.
