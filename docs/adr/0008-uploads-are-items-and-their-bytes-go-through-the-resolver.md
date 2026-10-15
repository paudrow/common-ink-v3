# 8. An upload is an item like a note, and its bytes are only ever read through the resolver

Status: accepted by the owner of #22 on 2026-10-11, without the maintainer. Issue 1 left several of these open; overrule them here if they are wrong.

An upload is a file in a workspace. The spec says grants, archive and Trash apply to it as to a note. We made that literal: `uploads` has the same `folder_id`, `private_owner` and `state` columns as `notes`, the access resolver decides "an item in a folder" (`itemLevel`, `SEEN`) and is the same code for both, and the access matrix test holds every upload operation to the row its neighbouring note has. There is no second access system. An agent's folder limit (ADR 2) is part of that resolver, so it holds for an upload as for a note, and every way in makes the agent's actor in one place (`agentActor`), the addresses that carry bytes included.

## What an upload can and can't have of its own

- A grant to a person: yes, as a note. It is the most specific grant and wins over the folder's.
- Private: yes, to the member who uploaded it. A picture pasted into a private note is uploaded private, so making a note private doesn't leave its pictures listed for everyone who sees the folder.
- A link: no. A link opens a page to read, and an upload is reached by link only through a link on the folder it is in.

## A link on a note does not open the uploads the note refers to

Whoever holds a link sees what the link's item covers: a note link covers that note, a folder link covers the notes and uploads in the folder and below. A note that refers to an upload outside what the link covers shows a placeholder there.

We considered letting a note's link carry the uploads the note refers to. Then anyone who can edit a linked note could write `::image{<id>}` for an upload they can't see and read it through the link, and the resolver would need to know who wrote each reference and when. A reference is text; it never grants anything. To share a page with its pictures, put both in a folder and link the folder.

## What a reader who can't see an upload is told

Nothing: `{ id, upload: null }`, the same as for an id that was never an upload, and a placeholder of the size the note gives. The name of a file is never in a note's text, so it can't leak by way of the note either.

## The bytes

Every byte is served by the Worker, at `/api/workspaces/<id>/uploads/<upload>` for a session or an agent's token and `/api/shared/<token>/uploads/<upload>` for a link, and each request is one `upload.open` or `shared.upload` operation. The bucket has no public address and we sign no addresses, so there is nothing that keeps working after a grant or a link is taken away. Browsers may keep a private copy (`private, no-cache`) and must ask before using it, which is answered through the same check.

The bytes are whatever someone uploaded and they are served from the app's own host, so they must never act as a page of the app:

- The type is chosen by the server from a short list, and only when the name's ending and the first bytes agree. Everything else is `application/octet-stream`. The browser's declared type is never read. `X-Content-Type-Options: nosniff`.
- Only pictures (not SVG), video, sound and PDF are `inline`. Everything else, SVG and HTML among it, is `Content-Disposition: attachment`. An SVG still draws as the source of an `<img>`, where it can't run script.
- A PDF is inline so that it opens in a tab in the browser's own viewer (the maintainer asked for it, 15 Oct). Chromium shows it in a document of its own making at the PDF's address, and that document has the app's origin: the `sandbox` below doesn't reach it (measured in Chromium 1248). Nothing of the file's runs there. The PDF's own script runs inside the viewer: its `app.alert` is a dialog on that tab, under the app's address, and `app.launchURL`, `submitForm` and `getURL` sent nothing. `test/browser/uploads-open.spec.ts` checks that no mark reaches the app's storage, cookies or server from a PDF, an HTML file or an SVG, however each is opened. Only a separate origin for bytes would give a PDF's tab no origin of the app's.
- `Content-Security-Policy: sandbox` on every answer, so even a type let through by mistake is a document with no origin and no script. It never takes `allow-scripts` or `allow-same-origin` (`test/core/upload-http.test.ts`).
- Text is read in the app (`/file/<id>`): the bytes are fetched as text and drawn as text, never as markup, so an HTML file is shown as its source.
- `Cross-Origin-Resource-Policy: same-origin`, so another site, or an HTML embed's frame, can't load them with the member's session.

We considered serving bytes from the separate embed origin (`EMBED_ORIGIN`). A session cookie doesn't go there, so it would need signed addresses that outlive a revoked grant for as long as they are valid, and `EMBED_ORIGIN` is optional. The headers above give the same protection on one origin without that.

## Limits

50 MB a file, checked against the declared length before a byte is read and enforced while streaming (the bucket is handed exactly the declared number of bytes). 1 GB a workspace, counted in the statement that makes the row, uploads in Trash included; at the cap an upload is refused and the message says to delete some for good.

## Two stores, no transaction

A row in D1 and an object in R2 can't be changed together. An upload's `state` has two more values than a note's: `pending` (row made, bytes arriving) and `removing` (being deleted). Nothing reads an upload in either. Creating goes row, bytes, then live. Removing goes `removing`, delete bytes, delete row. Stopped anywhere, what is left is a row nothing reads, which the hourly run clears. So there are never readable bytes with no row to decide who may read them, and never a readable row with no bytes.

## Trashing an upload that notes still use

It is allowed, and the answer says how many notes use it. Those notes say the file is in Trash until it is restored. After it is removed for good they read as for an upload that never was. Deleting a note never touches the uploads it refers to.

## Buckets

Production reads `common-ink-v3-uploads`. Every PR Preview reads one shared bucket, `common-ink-v3-uploads-preview`: a bucket can be deleted only when empty and nothing in CI can empty one, so a bucket per Preview could never be cleaned up. Each Preview reads only the objects its own database names. When a PR closes, `scripts/preview.ts` deletes every object that database names and then the database. It misses a file whose upload was cut off before the hourly run cleared it (a Preview has no timer), and everything if the delete fails partway. A rule on the Previews bucket that deletes objects after 30 days is recommended for those, and nothing depends on it.
