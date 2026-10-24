import { newId } from "./ids.ts";
import { MAX_RAW_BYTES, answers, bareSubject, headerBlock, normalAddress, readMessage, vouched, type Incoming } from "./mail.ts";
import { OpError, type MailAddress, type MailMessage, type MailSender, type MailThread, type MailThreadRead } from "./protocol.ts";

/*
 * A person's mail, kept: what reached notes@ from an address that is theirs, put in threads by the
 * ids messages name each other by. Every function here answers for one person, named by the caller:
 * the operations name only the person asking (src/core/sources.ts), and `receive` only the person
 * the sender's address is. See docs/adr/0018-email-is-kept-because-it-has-nowhere-else-to-be.md.
 */

/** What a person's connection to their mail is kept as in `source_connections`. */
export const MAIL_PROVIDER = "mail";
/** The one email data source, and what references to its threads name. */
export const MAIL_SOURCE = "email";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How much one address may send to be kept: so many messages an hour, and a person so many a day, whatever they come from. */
export const PER_SENDER_HOUR = 60;
export const PER_PERSON_DAY = 500;
/** How many addresses a person may add, and how long a code to verify one stands. */
export const MAX_SENDERS = 20;
export const CODE_MS = DAY;
/** How long apart two messages of a thread with no ids between them may be and still be taken for one conversation by subject. */
const SUBJECT_WINDOW = 30 * DAY;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Letters and digits nobody misreads for another. */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const letters = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};
/** The codes a subject or a line holds, as `newCode` writes them. */
const codesIn = (text: string) => [...text.toUpperCase().matchAll(/\b([A-Z2-9]{4})-([A-Z2-9]{4})\b/g)].map((m) => `${m[1]}-${m[2]}`);

// Senders ----------------------------------------------------------------------------------------

/** The person an address is: whoever signs in with it, or else whoever added it and verified it. */
export async function personOf(db: D1Database, address: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id, 0 AS rank FROM people WHERE email = ?1 UNION ALL SELECT person_id AS id, 1 AS rank FROM mail_senders WHERE address = ?1 AND verified_at IS NOT NULL ORDER BY rank LIMIT 1")
    .bind(normalAddress(address))
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function listSenders(db: D1Database, personId: string): Promise<MailSender[]> {
  const [person, added] = await db.batch([
    db.prepare("SELECT email FROM people WHERE id = ?").bind(personId),
    db.prepare("SELECT address, verified_at, code_expires_at FROM mail_senders WHERE person_id = ? ORDER BY created_at, address").bind(personId),
  ]);
  const email = (person!.results[0] as { email: string } | undefined)?.email;
  return [
    ...(email ? [{ address: email, account: true, verified: true, expiresAt: null }] : []),
    ...(added!.results as { address: string; verified_at: number | null; code_expires_at: number | null }[]).map((r) => ({ address: r.address, account: false, verified: r.verified_at !== null, expiresAt: r.verified_at === null ? r.code_expires_at : null })),
  ];
}

/**
 * Adds an address the person sends from, waiting for its code, or gives one waiting a new code.
 * The code is answered once and kept only as its hash.
 */
export async function addSender(db: D1Database, personId: string, address: string, now: number): Promise<string> {
  const said = normalAddress(address);
  const senders = await listSenders(db, personId);
  const kept = senders.find((s) => s.address === said);
  if (kept?.account) throw new OpError("conflict", "That is the email you sign in with, which is recognized already");
  if (kept?.verified) throw new OpError("conflict", "That address is verified already");
  if (!kept && senders.filter((s) => !s.account).length >= MAX_SENDERS) throw new OpError("conflict", `You can add at most ${MAX_SENDERS} addresses`);
  const code = newCode();
  await db
    .prepare(
      `INSERT INTO mail_senders (person_id, address, code_hash, code_expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (person_id, address) DO UPDATE SET code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at WHERE verified_at IS NULL`,
    )
    .bind(personId, said, await sha256(code), now + CODE_MS, now)
    .run();
  return code;
}

export async function removeSender(db: D1Database, personId: string, address: string): Promise<void> {
  const said = normalAddress(address);
  const done = await db.prepare("DELETE FROM mail_senders WHERE person_id = ? AND address = ?").bind(personId, said).run();
  if (!done.meta.changes) throw new OpError("not_found", (await listSenders(db, personId)).some((s) => s.account && s.address === said) ? "The email you sign in with can't be removed" : "No such address");
}

/**
 * Verifies an address waiting for its code, when mail from it carries the code. True when one was
 * verified: that message has done its work and is not kept. An address someone signs in with, or
 * one another person verified first, stays waiting.
 */
export async function verifyFrom(db: D1Database, address: string, said: string, now: number): Promise<boolean> {
  const codes = codesIn(said);
  if (!codes.length) return false;
  const hashes = await Promise.all(codes.map(sha256));
  const { results } = await db
    .prepare(`SELECT person_id, code_hash FROM mail_senders WHERE address = ? AND verified_at IS NULL AND code_expires_at > ? AND code_hash IN (${hashes.map(() => "?").join(",")})`)
    .bind(normalAddress(address), now, ...hashes)
    .all<{ person_id: string; code_hash: string }>();
  const row = results[0];
  if (!row || (await db.prepare("SELECT 1 FROM people WHERE email = ?").bind(normalAddress(address)).first())) return false;
  try {
    const done = await db
      .prepare("UPDATE mail_senders SET verified_at = ?3, code_hash = NULL, code_expires_at = NULL WHERE person_id = ?1 AND address = ?2 AND code_hash = ?4 AND verified_at IS NULL")
      .bind(row.person_id, normalAddress(address), now, row.code_hash)
      .run();
    return done.meta.changes > 0;
  } catch (err) {
    // Another person verified it first: a verified address is one person's.
    if (/UNIQUE/i.test(String(err))) return false;
    throw err;
  }
}

// Threads --------------------------------------------------------------------------------------

interface MessageRow {
  id: string;
  thread_id: string;
  message_id: string;
  in_reply_to: string | null;
  refs: string;
  from_name: string;
  from_address: string;
  to_list: string;
  cc_list: string;
  subject: string;
  sent_at: number;
  received_at: number;
  text: string;
  html: string | null;
  attachments: string;
  via: "sent" | "forwarded";
  comment: string | null;
}

const toMessage = (sourceId: string, r: MessageRow): MailMessage => ({
  sourceId,
  id: r.id,
  threadId: r.thread_id,
  messageId: r.message_id,
  inReplyTo: r.in_reply_to,
  references: r.refs ? r.refs.split(" ") : [],
  from: { name: r.from_name, address: r.from_address },
  to: JSON.parse(r.to_list) as MailAddress[],
  cc: JSON.parse(r.cc_list) as MailAddress[],
  subject: r.subject,
  sentAt: r.sent_at,
  receivedAt: r.received_at,
  text: r.text,
  html: r.html,
  attachments: JSON.parse(r.attachments) as MailMessage["attachments"],
  via: r.via,
  comment: r.comment,
});

/** How a message begins, as a list shows it: its own words, without the lines it quotes. */
const snippetOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** A thread as a list shows it, from its messages in order. */
function summed(sourceId: string, id: string, subject: string, messages: (Pick<MailMessage, "from" | "sentAt" | "text"> & { attached: boolean })[]): MailThread {
  const from: MailAddress[] = [];
  for (const m of messages) if (!from.some((f) => f.address === m.from.address)) from.push(m.from);
  const last = messages[messages.length - 1];
  return { sourceId, id, subject, from, firstAt: messages[0]?.sentAt ?? 0, lastAt: last?.sentAt ?? 0, count: messages.length, snippet: snippetOf(last?.text ?? ""), attachments: messages.some((m) => m.attached) };
}

/** A word to look for with LIKE, escaped. D1 takes a pattern of at most 50 bytes, so a long word is looked for by its start. */
function like(word: string): string {
  let kept = "";
  for (const c of word.replace(/[\\%_]/g, (special) => `\\${special}`)) {
    if (new TextEncoder().encode(kept + c).length > 40) break;
    kept += c;
  }
  return `%${kept.endsWith("\\") && !kept.endsWith("\\\\") ? kept.slice(0, -1) : kept}%`;
}

/**
 * What a search of the threads asks for, as a mail app's search box reads it: words, each to be found
 * somewhere in one message, `from:` words in its sender's name or address, `subject:` words in its
 * subject, and `has:attachment`. A phrase in quotes is one word.
 */
export interface MailQuery {
  words: string[];
  from: string[];
  subject: string[];
  attachment: boolean;
}

const TERM = /(?:(from|subject|has):)?(?:"([^"]*)"?|(\S+))/gi;

export function readQuery(query: string | undefined): MailQuery {
  const read: MailQuery = { words: [], from: [], subject: [], attachment: false };
  for (const [, op, quoted, bare] of (query ?? "").matchAll(TERM)) {
    const word = (quoted ?? bare ?? "").trim();
    const key = op?.toLowerCase();
    if (key === "has" && /^attachments?$/i.test(word)) read.attachment = true;
    else if (key === "from" && word) read.from.push(word);
    else if (key === "subject" && word) read.subject.push(word);
    else if (word) read.words.push(op ? `${op}:${word}` : word);
  }
  // At most so many of each, so a search is one statement D1 binds.
  return { words: read.words.slice(0, 10), from: read.from.slice(0, 5), subject: read.subject.slice(0, 5), attachment: read.attachment };
}

/**
 * A page of the person's threads, latest first, each with a message that has all `query` asks for.
 * `senders`, where it is given, keeps those with a message from one of those addresses.
 */
export async function listThreads(
  db: D1Database,
  personId: string,
  sourceId: string,
  ask: { query?: string | undefined; before?: number | undefined; limit: number; senders?: readonly string[] | undefined },
): Promise<{ threads: MailThread[]; more: boolean }> {
  const { words, from, subject, attachment } = readQuery(ask.query);
  const binds: unknown[] = [personId, ask.before ?? null, ask.limit + 1];
  const bound = (value: unknown) => `?${binds.push(value)}`;
  const haystack = "(m.subject || ' ' || m.from_name || ' ' || m.from_address || ' ' || m.to_list || ' ' || m.cc_list || ' ' || COALESCE(m.comment, '') || ' ' || m.text)";
  const holds = [
    ...words.map((w) => `${haystack} LIKE ${bound(like(w))} ESCAPE '\\'`),
    ...from.map((w) => `(m.from_name || ' ' || m.from_address) LIKE ${bound(like(w))} ESCAPE '\\'`),
    ...subject.map((w) => `m.subject LIKE ${bound(like(w))} ESCAPE '\\'`),
    ...(attachment ? ["m.attachments != '[]'"] : []),
    ...(ask.senders ? [`m.from_address IN (SELECT value FROM json_each(${bound(JSON.stringify(ask.senders))}))`] : []),
  ];
  const { results } = await db
    .prepare(
      `SELECT t.id, t.subject FROM mail_threads t WHERE t.person_id = ?1 AND t.merged_into IS NULL AND (?2 IS NULL OR t.last_at < ?2)
       AND EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id${holds.map((h) => ` AND ${h}`).join("")})
       ORDER BY t.last_at DESC, t.id LIMIT ?3`,
    )
    .bind(...binds)
    .all<{ id: string; subject: string }>();
  const page = results.slice(0, ask.limit);
  if (!page.length) return { threads: [], more: false };
  const { results: rows } = await db
    .prepare(`SELECT thread_id, from_name, from_address, sent_at, substr(text, 1, 400) AS text, attachments != '[]' AS attached FROM mail_messages WHERE thread_id IN (${page.map(() => "?").join(",")}) ORDER BY sent_at, received_at, id`)
    .bind(...page.map((t) => t.id))
    .all<{ thread_id: string; from_name: string; from_address: string; sent_at: number; text: string; attached: number }>();
  const byThread = Map.groupBy(rows, (r) => r.thread_id);
  return {
    threads: page.map((t) => summed(sourceId, t.id, t.subject, (byThread.get(t.id) ?? []).map((r) => ({ from: { name: r.from_name, address: r.from_address }, sentAt: r.sent_at, text: r.text, attached: r.attached === 1 })))),
    more: results.length > ask.limit,
  };
}

/** The thread an id names for the person: a thread's, one merged into another (which leads there), or one of its messages'. Null for anything else. */
export async function readThread(db: D1Database, personId: string, sourceId: string, id: string): Promise<MailThreadRead | null> {
  let threadId: string | null = (await db.prepare("SELECT thread_id FROM mail_messages WHERE id = ? AND person_id = ?").bind(id, personId).first<{ thread_id: string }>())?.thread_id ?? id;
  let thread: { id: string; subject: string; merged_into: string | null } | null = null;
  for (let hops = 0; threadId && hops < 10; hops++) {
    thread = await db.prepare("SELECT id, subject, merged_into FROM mail_threads WHERE id = ? AND person_id = ?").bind(threadId, personId).first();
    threadId = thread?.merged_into ?? null;
  }
  if (!thread || thread.merged_into) return null;
  const { results } = await db.prepare("SELECT * FROM mail_messages WHERE thread_id = ? AND person_id = ? ORDER BY sent_at, received_at, id").bind(thread.id, personId).all<MessageRow>();
  const messages = results.map((r) => toMessage(sourceId, r));
  return { ...summed(sourceId, thread.id, thread.subject, messages.map((m) => ({ ...m, attached: m.attachments.length > 0 }))), messages };
}

/** Whether `id` names one message of the person's (and not a thread). */
export const isMessage = async (db: D1Database, personId: string, id: string) => (await db.prepare("SELECT 1 FROM mail_messages WHERE id = ? AND person_id = ?").bind(id, personId).first()) !== null;

/**
 * The thread a message joins: the one any id it names, or names it, is in. When those are several
 * they are one conversation, and become one: the one begun earliest takes the others' messages.
 * With no id in common, a message that names none and whose subject says it answers another (a
 * forward written into the text, a reply whose mail app kept no ids) joins a thread of the same
 * subject from the last month that one of its people is in. Otherwise it begins a thread of its own.
 */
async function threadFor(db: D1Database, personId: string, m: Incoming, sentAt: number, now: number): Promise<string> {
  const ids = [...new Set([m.messageId, ...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references])];
  const { results } = await db
    .prepare(
      `SELECT i.thread_id, (SELECT MIN(sent_at) FROM mail_messages WHERE thread_id = i.thread_id) AS began FROM mail_ids i
       WHERE i.person_id = ?1 AND i.message_id IN (${ids.map((_, n) => `?${n + 2}`).join(",")}) GROUP BY i.thread_id ORDER BY began, i.thread_id`,
    )
    .bind(personId, ...ids)
    .all<{ thread_id: string; began: number | null }>();
  // At most so many are merged at once, so each statement's ids fit in what D1 binds; the rest are merged by the next message that names them.
  const [keep, ...others] = results.map((r) => r.thread_id).slice(0, 40);
  if (keep) {
    if (others.length) {
      const list = others.map(() => "?").join(",");
      await db.batch([
        db.prepare(`UPDATE mail_messages SET thread_id = ? WHERE thread_id IN (${list})`).bind(keep, ...others),
        db.prepare(`UPDATE mail_ids SET thread_id = ? WHERE thread_id IN (${list})`).bind(keep, ...others),
        db.prepare(`UPDATE mail_threads SET merged_into = ? WHERE person_id = ? AND (id IN (${list}) OR merged_into IN (${list}))`).bind(keep, personId, ...others, ...others),
        db.prepare(`UPDATE mail_threads SET last_at = MAX(last_at, (SELECT MAX(sent_at) FROM mail_messages WHERE thread_id = ?1)) WHERE id = ?1`).bind(keep),
      ]);
    }
    return keep;
  }
  const subject = bareSubject(m.subject);
  if (subject && answers(m.subject) && !m.inReplyTo && !m.references.length) {
    const people = new Set([m.from, ...m.to, ...m.cc].map((a) => a.address));
    const { results: near } = await db
      .prepare(
        `SELECT m.thread_id, m.from_address, m.to_list, m.cc_list FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
         WHERE t.person_id = ? AND t.merged_into IS NULL AND t.subject = ? AND m.sent_at BETWEEN ? AND ? ORDER BY m.sent_at DESC LIMIT 50`,
      )
      .bind(personId, subject, sentAt - SUBJECT_WINDOW, sentAt + SUBJECT_WINDOW)
      .all<{ thread_id: string; from_address: string; to_list: string; cc_list: string }>();
    const met = near.find((r) => [r.from_address, ...(JSON.parse(r.to_list) as MailAddress[]).map((a) => a.address), ...(JSON.parse(r.cc_list) as MailAddress[]).map((a) => a.address)].some((a) => people.has(a)));
    if (met) return met.thread_id;
  }
  const id = newId();
  await db.prepare("INSERT INTO mail_threads (id, person_id, subject, last_at) VALUES (?, ?, ?, ?)").bind(id, personId, subject || "(no subject)", sentAt || now).run();
  return id;
}

/**
 * Keeps one message for the person, in its thread. A message kept already, by its Message-ID, is
 * not kept again: the same mail copied and forwarded, or sent twice, is one message.
 */
export async function keep(db: D1Database, personId: string, m: Incoming, how: { sender: string; via: MailMessage["via"]; comment: string | null; now: number }): Promise<{ kept: string } | { duplicate: string }> {
  const already = await db.prepare("SELECT id FROM mail_messages WHERE person_id = ? AND message_id = ?").bind(personId, m.messageId).first<{ id: string }>();
  if (already) return { duplicate: already.id };
  // A Date in the future is the sender's clock, not when it was sent.
  const sentAt = m.sentAt !== null && m.sentAt <= how.now + DAY ? m.sentAt : how.now;
  const threadId = await threadFor(db, personId, m, sentAt, how.now);
  const id = newId();
  const ids = [...new Set([m.messageId, ...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references])];
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mail_messages (id, person_id, thread_id, message_id, in_reply_to, refs, sender, from_name, from_address, to_list, cc_list, subject, sent_at, received_at, text, html, attachments, via, comment)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
        )
        .bind(id, personId, threadId, m.messageId, m.inReplyTo, m.references.join(" "), how.sender, m.from.name, m.from.address, JSON.stringify(m.to), JSON.stringify(m.cc), m.subject, sentAt, how.now, m.text, m.html, JSON.stringify(m.attachments), how.via, how.comment),
      ...ids.map((messageId) => db.prepare("INSERT INTO mail_ids (person_id, message_id, thread_id) VALUES (?, ?, ?) ON CONFLICT (person_id, message_id) DO NOTHING").bind(personId, messageId, threadId)),
      db.prepare("UPDATE mail_threads SET last_at = MAX(last_at, ?) WHERE id = ?").bind(sentAt, threadId),
    ]);
  } catch (err) {
    // The same message arriving twice at once: the other was kept.
    if (!/UNIQUE/i.test(String(err))) throw err;
    const other = await db.prepare("SELECT id FROM mail_messages WHERE person_id = ? AND message_id = ?").bind(personId, m.messageId).first<{ id: string }>();
    if (!other) throw err;
    // A thread begun for it holds nothing now.
    await db.prepare("DELETE FROM mail_threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = ?1) AND NOT EXISTS (SELECT 1 FROM mail_ids WHERE thread_id = ?1)").bind(threadId).run();
    return { duplicate: other.id };
  }
  return { kept: id };
}

/** Everything a person's mail is kept as, and the addresses they added: what disconnecting it, or deleting the account, takes. */
export const forgetMail = (db: D1Database, personId: string) =>
  db.batch([
    db.prepare("DELETE FROM mail_ids WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM mail_messages WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM mail_threads WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM mail_senders WHERE person_id = ?").bind(personId),
  ]);

// Receiving ------------------------------------------------------------------------------------

/** What became of one message that reached notes@. Nothing of it is ever said to its sender. */
export type Received =
  | { kept: string; personId: string }
  | { duplicate: string; personId: string }
  | { verified: string }
  | { dropped: "too_large" | "unreadable" | "unauthenticated" | "unknown" | "not_connected" | "too_many"; why?: string };

/**
 * Takes one message that reached notes@ and keeps it for the person it is from, or drops it. It is
 * kept only when the From domain vouched for it (`vouched`) and the address is a person's, by
 * their sign-in email or one they verified, who has their mail connected. A message from an address
 * waiting for its code, carrying that code, verifies it instead. A forward keeps the message it
 * forwards, as written by whoever wrote it; that message's own domain can't be checked, and it is
 * the member's word, as anything they paste into a note is.
 */
export async function receive(db: D1Database, raw: string | ArrayBuffer | Uint8Array, opts: { authserv: string; now: number }): Promise<Received> {
  const size = typeof raw === "string" ? raw.length : raw.byteLength;
  if (size > MAX_RAW_BYTES) return { dropped: "too_large" };
  // Its headers are checked before its body is read: what fails costs next to nothing.
  const head = headerBlock(raw);
  const sender = head.from;
  if (!sender) return { dropped: "unreadable" };
  const vouch = vouched(head.headers, sender, opts.authserv);
  if (!vouch.ok) return { dropped: "unauthenticated", why: vouch.why };
  let read;
  try {
    read = await readMessage(raw);
  } catch {
    return { dropped: "unreadable" };
  }
  // The address checked is the address kept: a message the two readings disagree on is neither's.
  if (read.outer.from.address !== sender) return { dropped: "unreadable" };
  if (await verifyFrom(db, sender, `${read.outer.subject}\n${read.outer.text.slice(0, 500)}`, opts.now)) return { verified: sender };
  const personId = await personOf(db, sender);
  if (!personId) return { dropped: "unknown" };
  if (!(await db.prepare("SELECT 1 FROM source_connections WHERE person_id = ? AND provider = ?").bind(personId, MAIL_PROVIDER).first())) return { dropped: "not_connected" };
  const counts = await db
    .prepare("SELECT SUM(sender = ?2 AND received_at > ?3) AS hour, COUNT(*) AS day FROM mail_messages WHERE person_id = ?1 AND received_at > ?4")
    .bind(personId, sender, opts.now - HOUR, opts.now - DAY)
    .first<{ hour: number | null; day: number }>();
  if ((counts?.hour ?? 0) >= PER_SENDER_HOUR || (counts?.day ?? 0) >= PER_PERSON_DAY) return { dropped: "too_many" };
  const kept = read.forwarded
    ? await keep(db, personId, read.forwarded.original, { sender, via: "forwarded", comment: read.forwarded.comment, now: opts.now })
    : await keep(db, personId, read.outer, { sender, via: "sent", comment: null, now: opts.now });
  return { ...kept, personId };
}
