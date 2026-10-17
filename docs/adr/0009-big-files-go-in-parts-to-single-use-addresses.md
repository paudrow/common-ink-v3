# 9. A big file goes in parts, each to an address that takes it once

Status: accepted by the owner of #84 on 2026-10-16. The maintainer asked for 25 GB ("I'd like to be able to upload podcast episodes") and approved the approach in #84.

A request to the Worker can carry at most 100 MB on the Free and Pro plans, so a file larger than that can't come in one request. R2 takes a file in parts (multipart upload) and puts them together, so a file goes in parts of 80 MiB, each its own request, and is at most 25 GB: 320 parts. One request still takes a file of up to 80 MiB (`upload.create`), which the app uses for a file of up to 8 MB and `upload_file` for a small file an agent holds.

## The steps

`upload.start` makes the row `pending`, as `upload.create` does, and begins R2's multipart upload under the upload's id; the row keeps R2's id for it (`multipart_id`). Each part is one `upload.part`, whose bytes are the body of a `PUT`, and each one stored is a row of `upload_parts` with the tag R2 answered. `upload.finish` hands R2 the parts in order, checks the object is the size `upload.start` was told, reads the type from its first bytes as for any upload, and makes the row live. `upload.abort` removes the upload as Trash does, aborting the parts in R2. Until it is live an upload is pending, and nothing reads a pending upload (ADR 8), so a file is seen by no one, its sender included, until it is whole.

Every part's length is fixed by the plan (`src/core/parts.ts`), so a part of any other length is refused before R2 takes it, and the object can differ from the size declared only if the declaration changed. The check at the end is there all the same: the declared size is what the file is held to, and a file that isn't it is thrown away.

## The address a part goes to

A part goes to `/api/upload-parts/<secret>/<n>`. The secret is 256 random bits; only its SHA-256 is kept, as for an agent's token (`upload_passes`). An address names one upload and lapses an hour after it is given, and takes each part once (`upload_pass_uses`), whether or not that part arrived whole. `upload.resume` answers the parts stored and gives a fresh address for the rest, so a part that broke off is sent again and none that arrived is.

- **Why no token or session with a part.** An agent's own shell sends the bytes with `curl`, so they never pass through the model, and the model never handles its token in a shell command. The address is the permission, and it is worth little: one upload, an hour, each part once, and only while the upload is pending.
- **Why it still asks.** The address names the upload, not a grant. Each part is performed as whoever started the upload, as they are now: their agent's token still connected (`agentById`), their role still one that edits, and the folder still one they may put things in. A disconnected agent, a token limited to other folders since, and a member made a viewer stop at the next part.
- **Why random and stored, not signed.** A signed address (as the file site's, ADR 8) carries its own expiry but can't be used once: that needs a row anyway. A random secret kept as its hash gives expiry and single use from the same row, lives in the core where the access rules are tested by calling operations, and needs no key in the core.
- **Only the sender.** `upload.resume`, `upload.part`, `upload.finish` and `upload.abort` find a pending upload only for whoever started it, by `uploaded_by` and its kind. To anyone else, admins included, it is no upload, as a hidden one is.

## Abandoned uploads

R2 keeps the parts of a multipart upload until it is completed or aborted. The hourly run (`clearUploads`, the Cron trigger already in `wrangler.jsonc`) takes a pending upload that no part has reached for a day (`touched_at`) to be abandoned: the row becomes `removing`, the multipart upload is aborted, and the rows go. The clock is the last part, not the start, so a 25 GB file sent slowly isn't cut off while it is still arriving. R2's own lifecycle rule, "abort incomplete multipart uploads", is the backstop for a multipart upload no row names (a Worker stopped between R2 and D1); it counts from the start, so it is set to a few days, not one.

## No quota

A workspace's uploads have no limit together; the 1 GB of ADR 8 is gone (maintainer, "Why have a limit on this?"). Settings shows the members the total (`upload.storage`), private files and Trash among it, and the PR names R2's price (about $0.015 a GB-month). An admin-set quota would be one statement in `upload.start`, and was left out until one is wanted.

## In the app

A file over 8 MB dropped, pasted or picked goes in parts, three at once, with progress from each part's request. Its line is written into the note as soon as `upload.start` answers, and the note shows how far it has got in the room the line keeps; when it is there, the player or picture takes that room. A part that fails is sent again to a fresh address after a wait that grows, and a browser offline waits until it is online again, so a laptop closed half way carries on when it is opened. After six rounds that store nothing, or a refusal that no retry changes (403, 404), the app gives up, aborts the upload and says so. A file is not resumed after its tab is closed: the browser no longer has it, and the upload is cleared after a day.
