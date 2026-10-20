# Rolling back a bad deploy

For when production is broken after a deploy. Every command runs from a checkout of `main` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set for the production account.

## How a deploy runs

The `deploy` job in `.github/workflows/ci.yml` runs `npm run deploy` on every push to `main`, which does three things in order:

1. `npm run build` builds the app and the Worker into `dist/`.
2. `wrangler d1 migrations apply DB --remote` runs every migration in `migrations/` that production hasn't run yet.
3. `wrangler deploy` uploads a new version of the Worker and sends all traffic to it.

Two things follow from that order:

- **Migrations go first.** For the seconds between steps 2 and 3, the old Worker answers requests against the new schema.
- **A rollback of the Worker never undoes a migration.** D1 has no down migrations. The way back for the schema is a new migration, or Time Travel.

## 1. Find out what is running

```sh
curl -s https://commonink.app/health
# {"ok":true,"version":"<version id>"}
npx wrangler deployments list   # which version gets the traffic, and when it started to
npx wrangler versions list      # the most recent versions, with their ids and messages
```

The version id in `/health` is the one `wrangler versions list` shows. A Preview's deploy message is its commit's sha. Production's deploy carries no message, so match a version to its commit by its upload time and the `deploy` run in GitHub Actions.

Faults since the deploy are in Workers Logs (Cloudflare dashboard, Workers and Pages, `common-ink-v3`, Logs), as lines with a `fault` field. Filter on `fault.route` or `fault.op`. With `SENTRY_DSN` set, they are also in Sentry, under the release named by the version id.

## 2. Roll back the Worker

If the bad deploy ran no migration, or its migrations only added things (a table, a nullable column, an index), the old Worker runs fine against the new schema. Roll it back:

```sh
npx wrangler rollback <version id> --message "Back from <bad version>: <what broke>"
curl -s https://commonink.app/health   # the version is the one you rolled back to
```

Then revert the bad commit on `main`. Otherwise, the next push deploys it again.

Cloudflare refuses a rollback to a version whose R2 bucket or KV namespace no longer exists. It keeps the 100 most recent versions.

A version carries its own settings, so a rollback to one made before a secret was rotated, or before `SENTRY_DSN` was set, may bring the old one back with it. Check the secrets after a rollback (`npx wrangler secret list`), and put any back that changed since.

## 3. When a migration has already run

Migrations go forward only. Pick one of these two:

### A compensating migration (the usual way)

Write a new migration that undoes the bad one, and deploy it like any other change. Use the next free number in `migrations/`.

```sh
npx wrangler d1 migrations create DB undo_<what>
# Write the SQL, then try it on a local copy:
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations list DB --local   # "No migrations to apply!"
```

This keeps every write made since the deploy. Use it when the schema is wrong but the data is fine: a column the old code can't handle, a bad index, or a constraint that refuses good rows.

Don't edit or delete a migration that production has already run. D1 records each migration by name in `d1_migrations`, so an edited one never runs again.

### D1 Time Travel (when the data is wrong)

Use this when a migration or a bug damaged the data itself. Time Travel puts the whole database back to how it was at a minute in the last 30 days (7 on the Workers Free plan). Every write since then is lost, from every member.

```sh
npx wrangler d1 time-travel info common-ink-v3 --timestamp 2026-10-19T14:05:00Z   # the bookmark for that minute
npx wrangler d1 time-travel restore common-ink-v3 --timestamp 2026-10-19T14:05:00Z
```

The restore runs in place on the production database. It prints a bookmark for the database as it was just before the restore: write that down, because you can restore to that bookmark (`--bookmark`) to undo the restore. Then:

1. Roll the Worker back (step 2) to a version that matches the restored schema, before the restore if you can. The restored `d1_migrations` table no longer lists the migrations that ran after the bookmark.
2. Remove or fix those migrations on `main` before the next deploy, or it runs them again.
3. Uploads sent since the bookmark have bytes in R2 but no row in D1, so the hourly job never removes them. They cost storage and nothing else. An upload purged from Trash since the bookmark is the other way round: its row is back, and its bytes are gone, so it opens as missing.

Before using this for real, rehearse it on a scratch database you create for the drill, never on production.

## Known gap: the old Worker during a deploy

Between the migrations and `wrangler deploy`, the old Worker serves every request against the new schema. A migration that renames or drops a column, adds a `NOT NULL` column without a default, or adds a constraint makes the old Worker's writes fail for those seconds. Members see "Common Ink broke" on a save, and the faults are reported on the old version.

Until the deploy can wait for this, write migrations in two steps:

1. **Expand.** Add the new column or table in a way the old code ignores, and deploy the code that uses it.
2. **Contract.** Drop the old column in a later deploy, once no running version reads it.

A rollback has the same gap in reverse: rolling back past an expand-only migration is safe, and rolling back past a contract is not.

## Checked on 2026-10-19

These were run with wrangler 4.149:

- `wrangler rollback --help`, `wrangler versions list --help`, `wrangler deployments list --help`, `wrangler d1 time-travel info --help` and `restore --help`: the flags above are theirs.
- `wrangler d1 migrations apply DB --local` and `wrangler d1 migrations list DB --local` on a fresh local database: every migration applies, and the list then says "No migrations to apply!".

The remote commands need the production token, so these weren't run: `versions list`, `deployments list`, `rollback`, and `time-travel`. The first restore drill (maintainer step 8 in #79) is where they get tried.
