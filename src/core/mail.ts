import PostalMime, { addressParser, type Address, type Email } from "postal-mime";
import type { MailAddress, MailAttachment } from "./protocol.ts";

/*
 * Reading one message that reached notes@: who it is from, whether its domain vouches for that,
 * what it says, and, for a message the member forwarded, the message they forwarded. Nothing here
 * touches the database: src/core/mailbox.ts keeps what this reads.
 */

/** The most of a message read at all. Cloudflare takes up to 25 MiB; mail to keep notes from is far smaller. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;
/** The most of a message's text and HTML kept. A message with more HTML keeps its text alone. */
export const MAX_TEXT = 200_000;
export const MAX_HTML = 500_000;
const MAX_ADDRESSES = 100;

/** A message as it is kept, before it has a thread or an id of its own. */
export interface Incoming {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** Its Date, or null when it says none that can be read. */
  sentAt: number | null;
  text: string;
  html: string | null;
  attachments: MailAttachment[];
}

/** What reached notes@: the message as sent, and, when it forwards one, the message forwarded and what was written above it. */
export interface Read {
  outer: Incoming;
  forwarded: { original: Incoming; comment: string | null } | null;
  /** Every header, in order, top first, as `Authentication-Results` is looked for. */
  headers: { key: string; value: string }[];
}

export const normalAddress = (address: string) => address.trim().toLowerCase();
export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** The angle-bracketed ids in a header, such as References, without their brackets. A header with no brackets is one id. */
export function idsIn(header: string | undefined | null): string[] {
  if (!header) return [];
  const bracketed = [...header.matchAll(/<([^<>\s]{1,500})>/g)].map((m) => m[1]!);
  if (bracketed.length) return [...new Set(bracketed)].slice(0, 100);
  const bare = header.trim();
  return bare && !/\s/.test(bare) && bare.length <= 500 ? [bare] : [];
}

const mailboxes = (addresses: Address[] | Address | undefined): MailAddress[] =>
  (Array.isArray(addresses) ? addresses : addresses ? [addresses] : [])
    .flatMap((a) => (a.group ? a.group : [a]))
    .filter((a) => typeof a.address === "string" && a.address.includes("@"))
    .slice(0, MAX_ADDRESSES)
    .map((a) => ({ name: (a.name ?? "").slice(0, 200), address: normalAddress(a.address!).slice(0, 254) }));

/** Subject without the Re: and Fwd: that replies and forwards put in front, as threads are named. */
export function bareSubject(subject: string): string {
  let bare = subject.trim();
  for (let before = ""; before !== bare; ) {
    before = bare;
    bare = bare.replace(REPLIED, "");
  }
  return bare.slice(0, 500);
}

const REPLIED = /^(re|fw|fwd|aw|wg|sv|vs)(\[\d+\])?\s*:\s*/i;
/** Whether a subject says the message answers or passes on another: Re:, Fwd: and the like. */
export const answers = (subject: string) => REPLIED.test(subject.trim());

const parsedDate = (said: string | undefined | null): number | null => {
  if (!said) return null;
  const at = Date.parse(said.replace(/\s+at\s+/i, " "));
  return Number.isFinite(at) ? at : null;
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An id for a message that came with none, made from what it says, so the same message forwarded twice is kept once. */
export const madeId = async (m: Pick<Incoming, "from" | "sentAt" | "subject" | "text">) =>
  `ink-${(await sha256([m.from.address, m.sentAt ?? "", bareSubject(m.subject), m.text.replace(/\s+/g, " ").trim().slice(0, 2000)].join("\n"))).slice(0, 32)}@commonink.invalid`;

const attachmentsOf = (email: Email): MailAttachment[] =>
  email.attachments
    .filter((a) => a.mimeType !== "message/rfc822")
    .slice(0, 100)
    .map((a) => ({ name: (a.filename ?? "").slice(0, 300) || "Attachment", type: a.mimeType.slice(0, 200), size: typeof a.content === "string" ? a.content.length : a.content.byteLength }));

async function incoming(email: Email): Promise<Incoming> {
  const html = email.html && email.html.length <= MAX_HTML ? await sanitizeHtml(email.html) : null;
  const text = (email.text?.trim() ? email.text : email.html ? await htmlText(html ?? (await sanitizeHtml(email.html.slice(0, MAX_HTML)))) : "").slice(0, MAX_TEXT);
  const from = mailboxes(email.from)[0] ?? { name: "", address: "" };
  const made = { from, sentAt: parsedDate(email.date), subject: (email.subject ?? "").slice(0, 1000), text };
  return {
    ...made,
    messageId: idsIn(email.messageId)[0] ?? (await madeId(made)),
    inReplyTo: idsIn(email.inReplyTo)[0] ?? null,
    references: idsIn(email.references),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    html: html?.trim() ? html : null,
    attachments: attachmentsOf(email),
  };
}

/** The lines that begin a forwarded message in its text, as Gmail, Apple Mail and Outlook write them. */
const FORWARD_MARKS = [/^-{2,}\s*Forwarded message\s*-{2,}\s*$/im, /^Begin forwarded message:\s*$/im, /^-{2,}\s*Original Message\s*-{2,}\s*$/im];

/**
 * The message a forward written into the text holds: the headers the mail app wrote under its
 * mark, and the text under them. Null when the text forwards nothing, or names no sender.
 */
export async function inlineForward(text: string, outer: Pick<Incoming, "sentAt">): Promise<{ original: Incoming; comment: string | null } | null> {
  const marks = FORWARD_MARKS.map((mark) => mark.exec(text)).filter((m) => m !== null);
  const mark = marks.sort((a, b) => a.index - b.index)[0];
  if (!mark) return null;
  const comment = text.slice(0, mark.index).trim() || null;
  const lines = text.slice(mark.index + mark[0].length).replace(/^\r?\n/, "").split(/\r?\n/);
  const quoted = lines.filter((l) => l.trim()).every((l) => /^>/.test(l));
  const unquoted = quoted ? lines.map((l) => l.replace(/^> ?/, "")) : lines;
  const said: Record<string, string> = {};
  let at = 0;
  while (at < unquoted.length && !unquoted[at]!.trim()) at++;
  for (; at < unquoted.length; at++) {
    const header = /^\s*\*?(From|Date|Sent|Subject|To|Cc|Reply-To|Message-ID)\*?:\s*(.*)$/i.exec(unquoted[at]!);
    if (!header) break;
    said[header[1]!.toLowerCase()] = header[2]!.trim();
  }
  const from = mailboxes(addressParser(said.from ?? ""))[0];
  if (!from) return null;
  const body = unquoted.slice(at).join("\n").trim().slice(0, MAX_TEXT);
  const made = { from, sentAt: parsedDate(said.date ?? said.sent) ?? outer.sentAt, subject: (said.subject ?? "").slice(0, 1000), text: body };
  return {
    comment,
    original: {
      ...made,
      messageId: idsIn(said["message-id"])[0] ?? (await madeId(made)),
      inReplyTo: null,
      references: [],
      to: mailboxes(addressParser(said.to ?? "")),
      cc: mailboxes(addressParser(said.cc ?? "")),
      html: null,
      attachments: [],
    },
  };
}

/** Reads a message as it reached notes@, and the message it forwards, attached whole or written into its text. */
export async function readMessage(raw: string | ArrayBuffer | Uint8Array): Promise<Read> {
  const email = await PostalMime.parse(raw, { rfc822Attachments: true, maxNestingDepth: 50, maxPartCount: 500 });
  const outer = await incoming(email);
  const headers = email.headers.map((h) => ({ key: h.key.toLowerCase(), value: h.value }));
  const attached = email.attachments.find((a) => a.mimeType === "message/rfc822");
  if (attached) {
    const original = await incoming(await PostalMime.parse(attached.content as ArrayBuffer | string, { rfc822Attachments: false, maxNestingDepth: 50, maxPartCount: 500 }));
    if (original.from.address) return { outer, headers, forwarded: { original, comment: outer.text.trim() || null } };
  }
  return { outer, headers, forwarded: await inlineForward(outer.text, outer) };
}

/** One method's result in an Authentication-Results header: `dkim=pass header.d=example.com`. */
interface Result {
  method: string;
  result: string;
  props: Record<string, string>;
}

/** An Authentication-Results header's value: who wrote it, and what it found. Parenthesized comments are dropped. */
export function authResults(value: string): { authserv: string; results: Result[] } {
  let plain = value;
  for (let before = ""; before !== plain; ) {
    before = plain;
    plain = plain.replace(/\([^()]*\)/g, " ");
  }
  const [authserv = "", ...rest] = plain.split(";").map((part) => part.trim());
  const results = rest.flatMap((part): Result[] => {
    const [first, ...props] = part.split(/\s+/).filter(Boolean);
    const said = /^([a-z0-9-]+)=([a-z]+)$/i.exec(first ?? "");
    if (!said) return [];
    return [{ method: said[1]!.toLowerCase(), result: said[2]!.toLowerCase(), props: Object.fromEntries(props.map((p) => p.split("=")).filter((kv) => kv.length === 2).map(([k, v]) => [k!.toLowerCase(), v!.toLowerCase().replace(/^"|"$/g, "")])) }];
  });
  return { authserv: authserv.split(/\s+/)[0]!.toLowerCase(), results };
}

/** Whether DKIM's signing domain is aligned with the From domain, relaxed: the same domain, or one inside the other. A bare top-level domain never is. */
export const aligned = (signer: string, domain: string) => signer.includes(".") && (signer === domain || domain.endsWith(`.${signer}`) || signer.endsWith(`.${domain}`));

/**
 * Whether the domain of the From address vouched for this message, as the receiving server found
 * it: DMARC passed for that domain, or a DKIM signature from it (or a domain inside it, or one it is
 * inside) passed. SPF alone isn't enough: it names the envelope's sender, which needn't be From.
 *
 * Only the topmost Authentication-Results header is read, and only when `authserv` wrote it. A
 * receiving server puts its own on top of whatever the message came with, so any the sender wrote
 * are under it and never read.
 */
export function vouched(headers: Read["headers"], from: string, authserv: string): { ok: true } | { ok: false; why: string } {
  const domain = domainOf(from);
  if (!domain) return { ok: false, why: "no From address" };
  const top = headers.find((h) => h.key === "authentication-results");
  if (!top) return { ok: false, why: "no Authentication-Results" };
  const { authserv: by, results } = authResults(top.value);
  if (by !== authserv.toLowerCase()) return { ok: false, why: `Authentication-Results by ${by || "nobody"}` };
  if (results.some((r) => r.method === "dmarc" && r.result === "pass" && r.props["header.from"] === domain)) return { ok: true };
  if (results.some((r) => r.method === "dmarc" && (r.result === "fail" || r.result === "quarantine" || r.result === "reject"))) return { ok: false, why: "DMARC failed" };
  if (results.some((r) => r.method === "dkim" && r.result === "pass" && aligned(r.props["header.d"] ?? r.props["header.i"]?.replace(/^.*@/, "") ?? "", domain))) return { ok: true };
  return { ok: false, why: "no aligned DMARC or DKIM pass" };
}

/** Elements dropped with everything in them: what runs, loads, asks for input or is not to be read. */
const DROPPED = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea", "option", "link", "meta", "base", "title", "head", "svg", "math", "template", "noscript", "audio", "video", "source", "track", "canvas", "portal", "dialog", "picture"]);
/** Elements kept, with only the attributes `KEPT_ATTRIBUTES` names. Any other is taken away and what is in it kept. */
const KEPT = new Set([
  ..."a abbr b blockquote br caption center cite code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s small span strike strong sub sup table tbody td tfoot th thead tr u ul".split(" "),
]);
const KEPT_ATTRIBUTES = new Set(["href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "align", "valign", "dir", "lang", "color", "border", "cellpadding", "cellspacing"]);
/** A picture is kept only when its bytes are in the message itself: a remote one tells the sender it was opened, and from where. */
const INLINE_PICTURE = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * HTML from a message with everything taken out that could run, load anything from elsewhere, or
 * style its way out of its box: scripts, frames, forms, styles and style attributes, every `on`
 * attribute, remote pictures, and any link that isn't http, https or mailto. The app also draws it
 * in a frame that runs nothing, so this is the first of two walls.
 */
export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .onDocument({ comments: (c) => void c.remove(), doctype: () => {} })
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROPPED.has(tag)) return void el.remove();
        if (!KEPT.has(tag)) return void el.removeAndKeepContent();
        for (const [name, value] of [...el.attributes] as [string, string][]) {
          const lower = name.toLowerCase();
          const bad = !KEPT_ATTRIBUTES.has(lower) || (lower === "href" && (tag !== "a" || !/^(https?:|mailto:)/i.test(value.trim()))) || (lower === "src" && (tag !== "img" || !INLINE_PICTURE.test(value.trim())));
          if (bad) el.removeAttribute(name);
        }
        if (tag === "img" && !el.hasAttribute("src")) return void el.remove();
        if (tag === "a") {
          el.setAttribute("rel", "noopener noreferrer nofollow");
          el.setAttribute("target", "_blank");
        }
      },
    });
  return rewriter.transform(new Response(html)).text();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decoded = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

const BLOCKS = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "table", "ul", "ol", "dl", "dt", "dd"]);

/** The words of sanitized HTML, a line for each block, for a message that came with no text of its own. */
export async function htmlText(html: string): Promise<string> {
  const chunks: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        if (BLOCKS.has(el.tagName.toLowerCase())) chunks.push("\n");
      },
      text(t) {
        chunks.push(t.text);
      },
    })
    .transform(new Response(html))
    .text();
  return decoded(chunks.join(""))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
