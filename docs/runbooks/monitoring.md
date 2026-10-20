# Knowing when it breaks

## Faults

The Worker reports every fault through `report()` in `src/worker/report.ts`:

- an error thrown while answering a request, and any 5xx answer;
- an MCP tool call that broke, which MCP answers in a 200;
- a fault in the hourly job;
- what the app's page saw: an error nothing caught, and an operation answered with a fault the Worker didn't make, such as a request Cloudflare cut off. A page sends at most 10, and the same one once, and leaves out what isn't Common Ink's: browser warnings, requests that couldn't be sent, and extensions' errors. The Worker hears at most 20 a minute from one person.

Each report is one line in Workers Logs with a `fault` field: `source` (`worker`, `client` or `job`), `route` as a pattern such as `/api/workspaces/*/ops`, `requestId` (Cloudflare's ray id), `op`, `status`, `name`, `message` and `stack`. The route keeps only the words of the app's own addresses and numbers, and the message and stack go through `redact()` in `src/core/logs.ts`, which takes out tokens, emails, link addresses and anything an error quotes. A report names no person. One limit: `redact()` can't tell words an error says without quotes from the code's own, so an error a full-trust plugin throws with a note's text in it, unquoted, would carry that text.

### Sentry, if you want it

Set one secret, and each report is also sent to Sentry as an event, with the Worker's version id as its release. The same fault goes at most once a minute from each Worker instance, so an uptime check during a D1 outage doesn't use up the quota:

```sh
npx wrangler secret put SENTRY_DSN   # the project's DSN, https://<key>@<host>/<project id>
```

In the Sentry project's settings, turn on "Prevent storing of IP addresses". The events come from Cloudflare, not from members, but the setting keeps it that way. To stop sending, delete the secret: `npx wrangler secret delete SENTRY_DSN`.

## Uptime

`https://commonink.app/health` answers 200 with `{"ok":true,"version":"<id>"}` when the Worker can reach D1, and 503 when it can't. It needs no sign-in, says nothing else, and costs one `SELECT 1`, so a check every minute is fine.

Point an outside check at it:

- **A free uptime service**, such as UptimeRobot or Better Stack. Check `https://commonink.app/health` every 1 to 5 minutes, expect status 200 and the text `"ok":true`, and alert by email after 2 failures in a row.
- **Cloudflare Health Checks**, if the zone is on Pro or above (the Free plan has none). In the commonink.app zone, open Health Checks (now part of Smart Shield) and create one: HTTPS, path `/health`, expected code 200, response body `"ok":true`, interval 60 s, and a notification on a change of status.

If the zone's bot rules challenge the service's requests, add a WAF skip rule for `/health`. Both run outside the Worker, so they notice when it is down, which no alert from inside it can.
