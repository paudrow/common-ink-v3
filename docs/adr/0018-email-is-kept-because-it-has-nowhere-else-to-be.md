# 18. Email is kept, because it has nowhere else to be read from

Status: proposed on 2026-10-22 with the Email data source (branch `inbound-email`). Overrule any of it in review.

## Context

People want the mail around their work next to their notes: a thread with a client, a receipt, a reply they sent. Common Ink should offer this without asking anyone for their mailbox. The way in is an address: mail sent, copied (BCC) or forwarded to notes@commonink.app shows up for the person who sent it.

ADR 0006 says a data source is one person's, read live where it is kept, with only a reference held in a note. A calendar and contacts live at Google. Mail sent to notes@ lives nowhere but the message Cloudflare hands the Worker once.

## Decision

**Email is a data source, and it is kept.** It is the third kind of `DataSource` (`MailSource` in `src/core/sources.ts`), from a provider of its own (`src/worker/sources/mail.ts`), and everything ADR 0006 says of whose a data source is still holds:

- It belongs to a person and to no workspace.
- Every operation answers for the asker alone.
- An agent limited to folders gets none of it.
- A reference in a note (`::email{ref subject}`) leads to it only for the person who made it.

The one difference is that its messages are stored, in D1 (`mail_messages`, `mail_threads`, `mail_ids`), because there is nowhere to read them from later. Disconnecting deletes them. So does deleting the account (`PERSON_COLUMNS` in `src/core/erase.ts`).

**Whose mail it is, decided by the sender's domain.** A From header says nothing on its own. A message is kept only when:

- The topmost `Authentication-Results` header was written by the server that received it for us, `mx.cloudflare.net` (`MAIL_AUTHSERV`).
- That header shows a DMARC pass for the From domain, or a DKIM pass from a domain aligned with it.
- The From address is a person's sign-in email or an address they verified.
- That person has connected Email.

Anything else is dropped. No message is rejected or answered, so a sender learns nothing about who has an account.

**Verifying an address without sending mail.** Common Ink sends no mail (as with invites). A person adds an address and is shown a code once; only its hash is kept. The address is verified when mail from it carrying the code reaches notes@ and passes the same checks. Sending from the address and passing its domain's DMARC or DKIM is what owning the address means here, so this proves the same thing a confirmation link would.

The rules:

- A verified address recognizes one person.
- An address someone signs in with can't be verified by anyone else.
- An agent can't add, remove or list addresses.

**A forward is the forwarded message's word.** When the person forwards a message, the message kept is the one forwarded, as its sender wrote it:

- An attached `message/rfc822` keeps its own ids.
- A forward written into the text keeps what Gmail, Apple Mail or Outlook wrote above it.

Its own domain can't be checked. It is the member's word, as anything they paste into a note is.

**Threads by the ids messages name.** Every Message-ID a thread has seen is kept (`mail_ids`): its messages' own, and every In-Reply-To and References they name. A message joins the thread any of its ids is in, whichever arrived first. When it names two threads, they become one, and the merged thread keeps `merged_into` so a reference to it still leads there.

A message that names no ids and whose subject says it answers another (Re:, Fwd:) joins a thread with the same subject from the last 30 days that one of its people is in. A forward written into the text arrives this way.

A message is kept once per person, by its Message-ID. A message that came without one gets an id made from what it says.

**HTML is sanitized twice.** On arrival, HTMLRewriter takes out everything that runs, loads, styles or tracks. In the app, the HTML is drawn in a frame with `sandbox=""`.

## Consequences

- Email works with no secret and no outside account, so it is offered on every deployment, Previews included. It needs Cloudflare Email Routing to send notes@ to the Worker, which is set up by hand (`docs/email.md`).
- The trust in a message rests on Cloudflare writing its `Authentication-Results` on top. Whether that is so has to be checked against a real message before the address is announced (`docs/email.md`, "Check the headers").
- Attachments' bytes aren't kept: only their names, types and sizes. Uploads are a workspace's, and mail is in none. Keeping them would need a place of the person's own in R2, and deleting it with the account.
- Kept mail counts against D1's size. A person is capped at 500 messages a day and 60 an hour from one address, and a message at 10 MB, with text and HTML cut to 200 KB and 500 KB.
