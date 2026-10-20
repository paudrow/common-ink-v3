# Restore the database with D1 Time Travel

This runbook restores Common Ink's database to an earlier time, and rehearses that on a scratch database first. The production database is `common-ink-v3` (binding `DB` in `wrangler.jsonc`). Uploads' bytes are in the R2 bucket `common-ink-v3-uploads`.

Run every command from the repository root, signed in to Cloudflare with `npx wrangler login`. The commands that act on production say so in their step.

## What Time Travel does

- It keeps the database's history for 30 days on the Workers Paid plan, and 7 days on the Free plan. Nothing has to be turned on.
- `wrangler d1 time-travel restore` rewinds a database in place. It overwrites everything written after the time you pick, for every member, and cancels the queries running at that moment.
- A restore prints a bookmark for the state it replaced. Restoring to that bookmark undoes the restore.
- It can't restore into another database. To rehearse, you restore a scratch database instead of production.

Cloudflare's [Time Travel reference](https://developers.cloudflare.com/d1/reference/time-travel/) has the details.

## What Time Travel does not bring back

**Uploads' bytes.** Time Travel covers D1 only. Nothing in this repository copies the R2 bucket, and Cloudflare's documentation describes no object history for R2, so a deleted object is gone. The Worker deletes an upload's bytes in `finishRemoving` (`src/core/uploads.ts`), always before the upload's row:

- when the hourly job removes an upload that has been in Trash for 30 days,
- when a member removes an upload from Trash for good,
- when the hourly job clears an upload that has stayed pending for a day, and when an upload is aborted.

A restore to a time before one of those brings the upload's row back without its bytes. The upload is listed again, in a folder, in Trash, or in a note that refers to it, and opening it answers `404` ("not_found" from `openUpload`). Step 8 of the incident procedure finds these uploads and removes them again.

The reverse also happens. An upload made after the restore point keeps its bytes in the bucket and loses its row. Nobody can read those bytes, because the Worker reads an object only for a row that names it. They cost storage until someone deletes them in the bucket.

**Deletions.** A restore to a time before someone deleted their account or a workspace brings that account or workspace back, whole. The privacy policy promises that a deletion leaves the backups within 30 days, so after a production restore every deletion made after the restore point has to be made again. The Worker keeps a record of each deletion in the bucket, as an object `deletions/<account|workspace>/<id>` with the time it was made, and a restore of the database doesn't touch it. The hourly job removes a record 31 days after its deletion, when no restore can reach back before it. Step 8 of the incident procedure runs `scripts/redo-deletions.ts`, which makes each one again.

**Everything that isn't the database.** Secrets, the Worker's code and the bucket's settings are not in D1. To go back to an earlier version of the Worker, use `npx wrangler rollback`.

**Smaller losses that have their own way back.** Trash keeps a note or an upload for 30 days, and a note's history can revert any change. Use those before you think of Time Travel.

## The checks

`docs/runbooks/restore-checks.sql` is the fixed set of checks you run before and after every restore:

- the number of rows in every table, the search index included,
- `PRAGMA quick_check`, which answers `ok` for a sound database (D1 documents `quick_check` among its supported statements, and not `integrity_check`),
- `PRAGMA foreign_key_check`, which lists every row whose reference points at nothing,
- the time of the latest change to a note and of the latest upload, in milliseconds since 1970,
- the number of drill markers, which is 0 everywhere except a scratch database in the middle of a drill.

Run them with `--json` and save the answer to a file:

```sh
npx wrangler d1 execute <database> --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > <file>.json
```

Then compare two answers. The script prints each check that differs and exits with 1, or prints `No differences.` and exits with 0:

```sh
node scripts/restore-drill.ts compare <before>.json <after>.json
```

`node scripts/restore-drill.ts` fails when a migration adds a table that `restore-checks.sql` doesn't count, and `npm test` runs it, so the checks keep up with the schema.

## Run the local half of the drill

`node scripts/restore-drill.ts` runs on this computer and needs no Cloudflare account. It builds a local D1 database from every migration and a seed, copies it into a second local database the way step 2 and step 3 of the rehearsal do, runs the checks on both and compares them. Then it adds the drill marker to the copy and checks that `compare` reports the marker and nothing else. It takes about 15 seconds, and `npm test` runs it.

A pass ends like this:

```text
- scratch matches source on every check
- after the marker, compare reports:
    rows in people: 2 -> 3
    SELECT count(*) AS restore_drill_markers FROM people WHERE id = 'restore-drill': [{"restore_drill_markers":0}] -> [{"restore_drill_markers":1}]
The local half of the restore drill passed.
```

## Rehearse a restore on a scratch database

The rehearsal copies production into a scratch database, `common-ink-v3-drill`, and restores that. Production is only read.

Two costs come with the copy:

- An export blocks other requests to production while it runs, according to Cloudflare's [import and export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/). With today's data that is seconds. Run it at a quiet hour.
- The exported file holds every member's notes. Keep it in the temporary folder below, and delete the folder at the end.

`wrangler d1 export` refuses a database that has a virtual table, and the search index (`note_search`) is one. So the copy exports every other table with `--table`, and makes the search index again from the notes with `docs/runbooks/restore-search.sql`. Local D1 accepts that export (the local half proves it). Whether Cloudflare's API accepts it for production has not been tried. If step 2 fails with "cannot export databases with Virtual Tables", skip the copy: do step 3 without the rows and the search index, and rehearse the restore on an empty schema.

1. Make a folder for the drill's files, and record production's checks. This only reads production.

   ```sh
   DRILL=$(mktemp -d)
   npx wrangler d1 execute common-ink-v3 --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$DRILL/production.json"
   ```

2. Export production's rows, every table but the search index.

   ```sh
   npx wrangler d1 export common-ink-v3 --remote --no-schema --output "$DRILL/rows.sql" $(node scripts/restore-drill.ts tables)
   ```

3. Create the scratch database and load it: the schema from the migrations, then the rows, then the search index. If `d1 create` asks whether to add the database to your configuration, answer no.

   ```sh
   npx wrangler d1 create common-ink-v3-drill
   cat migrations/*.sql > "$DRILL/schema.sql"
   npx wrangler d1 execute common-ink-v3-drill --remote --yes --file "$DRILL/schema.sql"
   npx wrangler d1 execute common-ink-v3-drill --remote --yes --file "$DRILL/rows.sql"
   npx wrangler d1 execute common-ink-v3-drill --remote --yes --file docs/runbooks/restore-search.sql
   ```

4. Check the copy against production.

   ```sh
   npx wrangler d1 execute common-ink-v3-drill --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$DRILL/copy.json"
   node scripts/restore-drill.ts compare "$DRILL/production.json" "$DRILL/copy.json"
   ```

   Expect `No differences.`. A member who wrote between step 1 and step 2 shows up here as a few more rows and a later `latest_change`, which is fine.

5. Note the restore point, with a minute's gap on each side so that the load and the marker fall clearly before and after it.

   ```sh
   sleep 60; BEFORE=$(date +%s); sleep 60
   ```

6. Make the marker change, and check that the checks see it.

   ```sh
   npx wrangler d1 execute common-ink-v3-drill --remote --yes --file docs/runbooks/restore-marker.sql
   npx wrangler d1 execute common-ink-v3-drill --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$DRILL/marked.json"
   node scripts/restore-drill.ts compare "$DRILL/copy.json" "$DRILL/marked.json"
   ```

   Expect two lines: one more row in `people`, and `restore_drill_markers` going from 0 to 1.

7. Look up the bookmark for the restore point, then restore the scratch database to it. Answer `y` when wrangler asks. Copy the bookmark the restore prints for undoing it.

   ```sh
   npx wrangler d1 time-travel info common-ink-v3-drill --timestamp="$BEFORE"
   npx wrangler d1 time-travel restore common-ink-v3-drill --timestamp="$BEFORE"
   ```

8. Verify the restore.

   ```sh
   npx wrangler d1 execute common-ink-v3-drill --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$DRILL/restored.json"
   node scripts/restore-drill.ts compare "$DRILL/copy.json" "$DRILL/restored.json"
   ```

   Expect `No differences.`: the marker is gone, and every count is as it was in the copy.

9. Undo the restore with the bookmark from step 7, and check that the marker is back.

   ```sh
   npx wrangler d1 time-travel restore common-ink-v3-drill --bookmark=<bookmark from step 7>
   npx wrangler d1 execute common-ink-v3-drill --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$DRILL/undone.json"
   node scripts/restore-drill.ts compare "$DRILL/marked.json" "$DRILL/undone.json"
   ```

   Expect `No differences.`.

10. Delete the scratch database and the drill's files.

    ```sh
    npx wrangler d1 delete common-ink-v3-drill
    rm -r "$DRILL"
    ```

11. Write down the date, how long step 2 and step 7 took, and what each `compare` printed, in issue #79.

## Restore production in an incident

Use this when the whole database is wrong: a migration that damaged data, or a write that changed far more than it should have. A restore loses every member's work after the restore point, so tell members before and after.

1. Stop whatever is still doing damage. If a deploy caused it, roll the Worker back first. `npx wrangler rollback` lists recent versions to choose from.

2. Find the last good time. These help:

   - when each migration ran: `npx wrangler d1 execute common-ink-v3 --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5"`,
   - the Worker's logs in the Cloudflare dashboard,
   - `max(created_at)` of `changes` around the time, in milliseconds.

   Write it down as an RFC 3339 time in UTC, such as `2026-10-19T14:05:00Z`, and set it in the shell:

   ```sh
   T=2026-10-19T14:05:00Z
   ```

3. Record the state now. These commands only read production.

   ```sh
   INCIDENT=$(mktemp -d)
   npx wrangler d1 time-travel info common-ink-v3 | tee "$INCIDENT/bookmark-now.txt"
   npx wrangler d1 execute common-ink-v3 --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$INCIDENT/before.json"
   npx wrangler d1 execute common-ink-v3 --remote --json --command "SELECT id FROM uploads" > "$INCIDENT/uploads-before.json"
   npx wrangler d1 execute common-ink-v3 --remote --json --command "SELECT id FROM people UNION ALL SELECT id FROM workspaces WHERE deleting_at IS NULL" > "$INCIDENT/kept-before.json"
   ```

4. Look up the bookmark for the restore point, and check that it is the time you meant.

   ```sh
   npx wrangler d1 time-travel info common-ink-v3 --timestamp="$T"
   ```

5. Restore production. Answer `y` when wrangler asks. Copy the bookmark it prints for undoing the restore, next to `bookmark-now.txt`.

   ```sh
   npx wrangler d1 time-travel restore common-ink-v3 --timestamp="$T"
   ```

6. Verify the restore.

   ```sh
   npx wrangler d1 execute common-ink-v3 --remote --json --command "$(cat docs/runbooks/restore-checks.sql)" > "$INCIDENT/after.json"
   node scripts/restore-drill.ts compare "$INCIDENT/before.json" "$INCIDENT/after.json"
   ```

   This time `compare` reports differences, because everything after the restore point is gone. Read each one:

   - `quick_check` must be `ok`.
   - `foreign_key_check` must be empty, or list only rows it listed before the restore.
   - `latest_change` and `latest_upload` must be at or before the restore point.
   - The counts must be what you expect from the restore point. A table you expected to be repaired, such as one a migration emptied, must have its rows back.
   - `restore_drill_markers` must be 0.

7. Sign in to commonink.app. Open a few notes, a note's history, and an upload.

8. Find the uploads whose rows came back without their bytes. They are the uploads in the database now that were not in it before the restore, and their bytes were deleted between the restore point and the incident.

   ```sh
   npx wrangler d1 execute common-ink-v3 --remote --json --command "SELECT id FROM uploads" > "$INCIDENT/uploads-after.json"
   node -e 'const ids = (f) => new Set(JSON.parse(require("fs").readFileSync(f, "utf8"))[0].results.map((r) => r.id)); const before = ids(process.argv[1]); console.log(JSON.stringify([...ids(process.argv[2])].filter((id) => !before.has(id))))' "$INCIDENT/uploads-before.json" "$INCIDENT/uploads-after.json"
   ```

   If it prints any ids, mark those uploads for removal. The hourly job then finishes removing them as it does any upload. It deletes the bytes, which are already gone, and then the rows.

   ```sh
   npx wrangler d1 execute common-ink-v3 --remote --command "UPDATE uploads SET state = 'removing' WHERE id IN (SELECT value FROM json_each('<the printed list>'))"
   ```

   Then make again every deletion of an account or a workspace made since the restore point. The script reads the record of deletions in the bucket, has the Worker delete each again, and prints what became of each id. Run it from the repository root, signed in with `npx wrangler login`. The Worker must be a version with `/redo-deletions` (this PR on): after a rollback to an older one, it answers 404.

   ```sh
   node scripts/redo-deletions.ts --since "$T"
   ```

   Each line is `<kind> <id>: <what happened>`. `deleted` is gone now. `deleting` is cut off, and the hourly job erases the rest. `gone` was gone already. `refused: ...` is an account whose person was the only admin of a shared workspace at the restore point; the script exits with 1, and that one needs a person to decide. Running it again is safe.

   As a check, compare `kept-before.json` with a fresh `kept-after.json`, as for uploads above. An id printed there that the script didn't list is a deletion whose record wasn't kept (the Worker logs "Couldn't keep the record of a deletion"). Pass it with `--account <id>` if it is in `people`, else with `--workspace <id>`. Both flags can be given more than once.

   ```sh
   npx wrangler d1 execute common-ink-v3 --remote --json --command "SELECT id FROM people UNION ALL SELECT id FROM workspaces WHERE deleting_at IS NULL" > "$INCIDENT/kept-after.json"
   node scripts/redo-deletions.ts --account <id> --workspace <id>
   ```

9. If the restore made things worse, undo it with the bookmark from step 5, and run step 6 again against `before.json`, which should then print `No differences.`.

   ```sh
   npx wrangler d1 time-travel restore common-ink-v3 --bookmark=<bookmark from step 5>
   ```

10. Tell members which time the database went back to, and that anything they wrote after it is gone. Delete `$INCIDENT` once the incident is closed. Its files name every upload.
