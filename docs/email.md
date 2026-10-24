# Email

Mail a person sends, copies (BCC) or forwards to **notes@in.commonink.app** is kept for them as threads in their Email data source. Nobody else sees it, whatever their role, and nothing in Common Ink changes it. Why it is kept, when a calendar and contacts aren't, is in `docs/adr/0018-email-is-kept-because-it-has-nowhere-else-to-be.md`.

## For a member

1. Open **Email** (under More in the sidebar) and press **Connect Email**. Until then, mail from you is dropped.
2. Mail from the address you sign in with is recognized as yours. To send from another address, add it under **Your addresses** (on the Email page, and in Settings under Email). You are shown a code, once, for example `K7QP-3MZD`. Send an email from that address to notes@in.commonink.app with the code in the subject, within a day. That message verifies the address and isn't kept. **New code** makes another, and **Remove** stops recognizing an address.
3. Send, BCC or forward mail to notes@in.commonink.app from your addresses:
   - **BCC on mail you send** keeps your own message. Your replies join the thread they answer.
   - **Forwarding** keeps the message you forwarded, from its sender, and what you wrote above it. Forwarding as an attachment keeps the original's ids, so it threads exactly. A forward written into the text, as Gmail, Apple Mail and Outlook write one, threads by its subject and the people in it.
4. The Email page lists your threads beside the one you read, as a mail app does: who wrote, the subject, how the latest message begins, and when. Search by words, `from:`, `subject:` and `has:attachment`, or press **Has attachments** or **From contacts**. j, k and the arrow keys move through the list, and Enter opens a thread. Its earlier messages are folded to a line each, and so is what a reply quotes. A message's formatting is drawn in a frame of its own origin that runs nothing and loads nothing from anywhere; **Show text** shows its text instead. Attachments are listed by name, type and size. **Make a note from this** makes a note with a link to the thread and its messages quoted.
5. A thread opens at `/email/<id>`. To link to it from a note, type `@` and words of its subject or sender, or press **Copy link** on the thread or on one message. The note holds `[[email:ref]]` and nothing of the mail. You see the link as the thread's subject; a click or vim's `gd` opens it, and resting on it shows who sent it, when, and how it begins. Everyone else who reads the note, members, guests and anyone with a share link, sees "Email" and nothing more. `[[email:ref|words]]` shows the words instead, to everyone. Notes written before links held `::email{ref subject}`, which is converted to `[[email:ref]]` once.

Mail is dropped, and its sender told nothing, when any of these is true:

- it comes from an address that isn't yours;
- its domain didn't vouch for it (DMARC, or DKIM aligned with the From address);
- it is over 10 MB;
- one address sent more than 60 messages in an hour, or a person more than 500 in a day.

Disconnecting Email deletes every message kept and every address you added.

## How it is built

| Part | Where |
|---|---|
| Inbound: the Worker's `email()` handler, the recipient check, `/dev/email` | `src/worker/mail.ts`, `src/worker/index.ts` |
| Reading a message: MIME (postal-mime), forwards, Authentication-Results, HTML sanitizing | `src/core/mail.ts` |
| The frame a message's HTML is drawn in: its document and policy, whose only script is its own, by hash | `src/worker/frames.ts` (`/embed-frame/mail`), `src/web/htmlFrame.ts` |
| Keeping it: senders and codes, threads, dedupe, limits, `receive` | `src/core/mailbox.ts` |
| The data source (`MailSource`, a third `DataSource` kind) and its operations | `src/core/sources.ts`, `src/worker/sources/mail.ts` |
| Operations: `email.list`, `email.thread`, `email.senders`, `email.addSender`, `email.removeSender`, and `record.refer` / `record.read` for `[[email:ref]]` | `src/core/protocol.ts`, `src/core/operations.ts` |
| Agents: `list_email`, `read_email_thread` (read-only), and `ink email`, `ink thread` | `src/worker/mcp/tools.ts`, `scripts/ink-cli.ts` |
| The Email plugin: the page, `@` and links to threads, the Settings section | `src/web/plugins/email/` |
| Tables | `migrations/0064_email.sql` |
| Tests | `test/core/mail.test.ts`, `test/core/plugin-email.test.ts` |

Email extends the plugin system in no new way. It is a built-in plugin that registers a `page`, a `settings` view and an embed (`referenceEmbed`, as Contacts does), and reads through `host.perform`. Like `source.*`, `event.*` and `contact.*`, `email.*` is refused to every plugin that isn't Common Ink's own (`OwnOnly`). The extension point it needed was on the server: a third member of `DataSource`, which ADR 0006 named as the way to add a kind of data source.

Two settings, both optional:

- `MAIL_ADDRESS`: the address mail is kept from. `wrangler.jsonc` sets it to `notes@in.commonink.app`, so every deploy keeps it; without it, it is the same. `notes+anything@` at the same domain is taken too.
- `MAIL_AUTHSERV`: whose `Authentication-Results` header is trusted. Defaults to `mx.cloudflare.net`.

### Trying it without Cloudflare

Where dev sign-in is on (this machine, Previews), a raw message POSTed to `/dev/email` by someone signed in goes through exactly what Email Routing's would, the header checks included. Write the `Authentication-Results` header yourself:

```sh
curl -s -b "__Host-ink_session=…" -X POST http://localhost:5173/dev/email --data-binary @- <<'MAIL'
Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com
From: Dev User <dev@example.com>
To: notes@in.commonink.app
Subject: Hello from dev
Message-ID: <hello-1@example.com>
Date: Thu, 22 Oct 2026 12:00:00 +0000

Kept as a thread.
MAIL
```

It answers what became of the message, such as `{"kept":"…","personId":"…"}` or `{"dropped":"not_connected"}`.

`node scripts/sample-mail.ts --url http://localhost:5173` keeps a few sample threads for the dev user this way: a conversation, an HTML receipt with a file, forwards from a sample contact and from someone who isn't one, and two from a mailing list.

## Setting it up in Cloudflare (by hand)

None of this is done by the PR, and nothing here is deployed by it. Do it in this order.

### 1. Leave the apex's mail alone

Mail for `commonink.app` itself goes to Google Workspace, and stays there: its `MX` records on `commonink.app` are not touched. Email Routing receives for the subdomain `in.commonink.app` only, which has no mail of its own. If the dashboard ever offers to add, replace or delete `MX` or SPF records on `commonink.app`, decline: accepting stops the apex's mail arriving at Google.

### 2. Deploy the Worker with this change

Merge, then deploy as usual: `npm run deploy` applies migration `0064_email.sql` to D1 and deploys the Worker, which then has the `email` handler and `MAIL_ADDRESS=notes@in.commonink.app` from `wrangler.jsonc`. Email Routing can only send to a Worker that has one.

### 3. Turn on Email Routing for in.commonink.app

**commonink.app → Email → Email Routing → Settings → Subdomains → Add subdomain:** `in`. Cloudflare offers to add the records the subdomain needs. Let it add them, all on `in.commonink.app`:

| Type | Name | Content | Priority |
|---|---|---|---|
| MX | `in.commonink.app` | `route1.mx.cloudflare.net` | (as Cloudflare gives, e.g. 13) |
| MX | `in.commonink.app` | `route2.mx.cloudflare.net` | (e.g. 86) |
| MX | `in.commonink.app` | `route3.mx.cloudflare.net` | (e.g. 24) |
| TXT | `in.commonink.app` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | |
| TXT | `cf2024-1._domainkey.in.commonink.app` | (the DKIM key Cloudflare gives) | |

Use the exact values the dashboard shows: the priorities and the DKIM key are Cloudflare's to give. Afterwards, check **DNS → Records**: the `MX` and SPF records on `commonink.app` are still Google's, and the new ones name `in.commonink.app`. If the zone's Email Routing has never been turned on, the dashboard may ask to enable it first and propose records for the apex: skip those (step 1).

### 4. Send notes@in.commonink.app to the Worker

**Email Routing → Routing rules → Custom addresses → Create address:**

- Custom address: `notes`, at the domain `in.commonink.app`
- Action: **Send to a Worker**
- Destination: `common-ink-v3`

Save, and make sure the rule is **Active**. Leave **Catch-all** off (Drop): any other address at the subdomain should go nowhere.

### 5. Check the headers before telling anyone

What a message is trusted by is the topmost `Authentication-Results` header, which must be the one Cloudflare's receiving server wrote (`mx.cloudflare.net`). Check this once against real mail:

1. Add a second, temporary rule: **Create address** `headers` → **Send to an email** → your own inbox (Cloudflare asks you to verify it as a destination).
2. From a Gmail address, send a message to `headers@in.commonink.app`. In Gmail, open it and choose **Show original**.
3. The first `Authentication-Results:` header from the top should read `mx.cloudflare.net; dkim=pass header.d=gmail.com …; dmarc=pass header.from=gmail.com …`.
   - If Cloudflare names itself differently, set `MAIL_AUTHSERV` on the Worker to what it writes.
   - If it writes only `ARC-Authentication-Results` and no `Authentication-Results`, stop: nothing will be kept, and the code needs to read that header instead.
4. Delete the temporary `headers` rule.

### 6. Try it

1. Sign in to commonink.app, open **Email**, and press **Connect Email**.
2. Send a message from the address you sign in with to notes@in.commonink.app. It shows up on the Email page within a few seconds.
3. `npx wrangler tail common-ink-v3` shows one line for each message, such as `Mail kept` or `Mail dropped: unauthenticated`. It never shows who sent it.

## Open questions

- **Attachments.** Only names, types and sizes are kept. Keeping the bytes means R2 objects of the person's own, outside any workspace, deleted with the account and on disconnect. Another way is saving one as an upload into a workspace the member picks.
- **Retention.** Mail is kept until the member disconnects or deletes their account. A limit, such as a year, or a cap per person, isn't set.
- **Search.** It is a `LIKE` over each message, fine for a person's mail at this size. **From contacts** reads the member's contacts from Google at each listing, up to 2,000 addresses. The notes' full-text index (`note_search`) is per workspace and isn't used.
- **Paging.** The next page of threads is asked for by the last one's time alone, so a thread whose latest message arrived in the same millisecond as the last one listed can be skipped. A cursor of time and id would fix it, at the cost of one more argument for every agent.
- **Threads merged by an old id.** Any id in References joins threads. Two threads of a mailing list that share one ancestor become one, and stay one.
- **A domain that lets anyone send as anyone.** Trust is the domain's: where one user can send as another's address, they can verify it as theirs. The code's prompt warns against sending a code someone else gave you.
- **`[[`.** `@` offers threads; `[[` offers notes and events, and not threads.
