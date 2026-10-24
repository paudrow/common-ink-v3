import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { aligned, authResults, bareSubject, headerBlock, htmlText, idsIn, inlineForward, readMessage, sanitizeHtml, vouched } from "../../src/core/mail.ts";
import { PER_SENDER_HOUR, personOf, readQuery, receive } from "../../src/core/mailbox.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { addressedTo, handleEmail } from "../../src/worker/mail.ts";
import { sourcesFor } from "../../src/worker/sources/index.ts";
import { addMember, newMember } from "./members.ts";

const AUTHSERV = "mx.cloudflare.net";
const T0 = Date.UTC(2026, 9, 22, 12);
const HOUR = 3_600_000;
const URL_ = new URL("https://commonink.app/api/ops");

interface Mail {
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  id?: string | null;
  inReplyTo?: string;
  references?: string;
  date?: string;
  body?: string;
  html?: string;
  /** The Authentication-Results the receiving server wrote, on top. Null for none. */
  auth?: string | null;
  /** Headers the sender wrote, under the server's. */
  sent?: string[];
  /** A whole message attached as message/rfc822. */
  attached?: string;
}

const domainOf = (address: string) => address.replace(/.*@/, "").replace(/>.*/, "");

/** A message as it reaches notes@, from the top: the receiving server's header, then the sender's. */
function mail(m: Mail): string {
  const domain = domainOf(m.from);
  const auth = m.auth === undefined ? `${AUTHSERV}; dkim=pass header.d=${domain} header.s=s1; dmarc=pass (p=reject) header.from=${domain}; spf=pass smtp.mailfrom=${m.from.replace(/.*</, "").replace(/>/, "")}` : m.auth;
  const headers = [
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    ...(m.sent ?? []),
    `From: ${m.from}`,
    `To: ${m.to ?? "notes@in.commonink.app"}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${m.subject ?? "Hello"}`,
    `Date: ${m.date ?? new Date(T0).toUTCString()}`,
    ...(m.id === null ? [] : [`Message-ID: <${m.id ?? `${crypto.randomUUID()}@${domain}`}>`]),
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
  ];
  if (m.attached) {
    return [...headers, 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", m.body ?? "", "--b1", "Content-Type: message/rfc822", "Content-Disposition: attachment", "", m.attached, "--b1--", ""].join("\r\n");
  }
  if (m.html) {
    return [...headers, 'Content-Type: multipart/alternative; boundary="b2"', "", ...(m.body ? ["--b2", "Content-Type: text/plain; charset=utf-8", "", m.body] : []), "--b2", "Content-Type: text/html; charset=utf-8", "", m.html, "--b2--", ""].join("\r\n");
  }
  return [...headers, "Content-Type: text/plain; charset=utf-8", "", m.body ?? "Hi."].join("\r\n");
}

const got = (m: Mail, now = T0) => receive(env.DB, mail(m), { authserv: AUTHSERV, now });

const emailOf = async (actor: Actor) => (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(actor.personId).first<{ email: string }>())!.email;
const as = <T extends OpInput>(actor: Actor, op: T) => perform(env.DB, actor, op, T0, sourcesFor(env, URL_));
/** A person with their email connected, and the address they sign in with. */
async function connected(): Promise<{ actor: Actor; email: string }> {
  const actor = await newMember();
  await as(actor, { type: "source.connect", id: "email" });
  return { actor, email: await emailOf(actor) };
}
const threads = async (actor: Actor, query?: string) => (await as(actor, { type: "email.list", ...(query ? { query } : {}) })).threads;

describe("reading a message", () => {
  it("reads its headers, ids and text", async () => {
    const read = await readMessage(mail({ from: "Ada Lovelace <ada@example.com>", cc: "Grace <grace@example.org>, sam@example.net", subject: "Re: Plans", id: "m2@example.com", inReplyTo: "m1@example.com", references: "<m0@example.com> <m1@example.com>", body: "Sounds good." }));
    expect(read.outer.from).toEqual({ name: "Ada Lovelace", address: "ada@example.com" });
    expect(read.outer.cc.map((a) => a.address)).toEqual(["grace@example.org", "sam@example.net"]);
    expect(read.outer.messageId).toBe("m2@example.com");
    expect(read.outer.inReplyTo).toBe("m1@example.com");
    expect(read.outer.references).toEqual(["m0@example.com", "m1@example.com"]);
    expect(read.outer.sentAt).toBe(T0);
    expect(read.outer.text.trim()).toBe("Sounds good.");
    expect(read.forwarded).toBeNull();
  });

  it("makes an id for a message that has none, the same for the same message", async () => {
    const a = await readMessage(mail({ from: "ada@example.com", id: null, body: "Same words" }));
    const b = await readMessage(mail({ from: "ada@example.com", id: null, body: "Same  words" }));
    expect(a.outer.messageId).toMatch(/^ink-[0-9a-f]{32}@commonink\.invalid$/);
    expect(a.outer.messageId).toBe(b.outer.messageId);
  });

  it("reads ids as References writes them", () => {
    expect(idsIn("<a@x> <b@y>\r\n <a@x>")).toEqual(["a@x", "b@y"]);
    expect(idsIn("bare@x")).toEqual(["bare@x"]);
    expect(idsIn("")).toEqual([]);
  });

  it("names a thread by its subject without Re: and Fwd:", () => {
    expect(bareSubject("Re: RE: Fwd: Plans")).toBe("Plans");
    expect(bareSubject("AW: Plans")).toBe("Plans");
  });

  it("takes out of HTML whatever runs, loads or tracks", async () => {
    const clean = await sanitizeHtml(
      `<html><head><style>body{background:url(https://t.example/x)}</style><script>alert(1)</script></head><body onload="x()"><p style="color:red" onclick="steal()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/">ok</a></p><img src="https://track.example/pixel.gif"><img src="data:image/png;base64,iVBORw0KGgo="><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="pw"></form><svg><script>1</script></svg><custom-tag>kept words</custom-tag><!-- comment --></body></html>`,
    );
    expect(clean).not.toMatch(/script|style|onclick|onload|javascript:|track\.example|iframe|form|input|svg|comment|<html|<body|custom-tag/i);
    expect(clean).toContain('href="https://ok.example/"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
    expect(clean).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(clean).toContain("kept words");
  });

  it("drops what an element read as raw text holds, which no tag inside it is seen in", async () => {
    for (const tag of ["xmp", "noembed", "noframes", "plaintext", "listing"]) {
      const clean = await sanitizeHtml(`<p>Before</p><${tag}><img src="https://t.example/p.png"><meta http-equiv="refresh" content="0;url=https://evil.example"></${tag}><p>After</p>`);
      expect(clean, tag).not.toMatch(/t\.example|evil\.example|<img|<meta/);
    }
  });

  it("keeps the newest ids of a long References, few enough to look them up at once", async () => {
    const refs = Array.from({ length: 150 }, (_, n) => `<r${n}@x>`).join(" ");
    expect(idsIn(refs)).toHaveLength(80);
    expect(idsIn(refs).at(-1)).toBe("r149@x");
  });

  it("reads a message's From and Authentication-Results from its headers alone", () => {
    const head = headerBlock(mail({ from: "Ada <Ada@Example.com>" }));
    expect(head.from).toBe("ada@example.com");
    expect(head.headers[0]!.key).toBe("authentication-results");
    expect(headerBlock(`From: a@example.com\r\nFrom: b@example.com\r\n\r\nTwo.`).from).toBe("");
  });

  it("reads the words of a message that came as HTML alone", async () => {
    const read = await readMessage(mail({ from: "ada@example.com", html: "<p>First &amp; foremost</p><p>Second<br>line</p><script>no()</script>" }));
    expect(read.outer.text).toBe("First & foremost\nSecond\nline");
    expect(read.outer.html).not.toContain("script");
    expect(await htmlText("<div>a</div><div>b</div>")).toBe("a\nb");
  });

  it("finds the message a forward writes into its text, as Gmail does", async () => {
    const text = ["FYI, see below.", "", "---------- Forwarded message ---------", "From: Grace Hopper <grace@example.org>", "Date: Wed, Oct 21, 2026 at 3:04 PM", "Subject: The compiler", "To: Ada <ada@example.com>", "", "It works now.", "Grace"].join("\n");
    const found = await inlineForward(text, { sentAt: T0 });
    expect(found?.comment).toBe("FYI, see below.");
    expect(found?.original.from).toEqual({ name: "Grace Hopper", address: "grace@example.org" });
    expect(found?.original.subject).toBe("The compiler");
    expect(found?.original.to.map((a) => a.address)).toEqual(["ada@example.com"]);
    expect(found?.original.sentAt).toBe(Date.parse("Wed, Oct 21, 2026 3:04 PM"));
    expect(found?.original.text).toBe("It works now.\nGrace");
  });

  it("finds the message a forward writes in Apple Mail's way, quoted", async () => {
    const text = ["Begin forwarded message:", "", "> From: Sam <sam@example.net>", "> Subject: Boiler", "> Date: 20 October 2026 09:00:00 GMT", "> ", "> Fixed."].join("\n");
    const found = await inlineForward(text, { sentAt: T0 });
    expect(found?.comment).toBeNull();
    expect(found?.original.from.address).toBe("sam@example.net");
    expect(found?.original.text).toBe("Fixed.");
  });

  it("reads a message forwarded whole, as an attachment, with its own ids", async () => {
    const original = mail({ from: "Grace <grace@example.org>", subject: "Original", id: "orig@example.org", inReplyTo: "earlier@example.com", body: "The original words." });
    const read = await readMessage(mail({ from: "ada@example.com", subject: "Fwd: Original", body: "Look at this", attached: original }));
    expect(read.forwarded?.original.messageId).toBe("orig@example.org");
    expect(read.forwarded?.original.inReplyTo).toBe("earlier@example.com");
    expect(read.forwarded?.original.from.address).toBe("grace@example.org");
    expect(read.forwarded?.comment).toBe("Look at this");
  });
});

describe("whether the sender's domain vouched for a message", () => {
  const headers = (...values: string[]) => values.map((value) => ({ key: "authentication-results", value }));

  it("reads an Authentication-Results header, comments and all", () => {
    const read = authResults("mx.cloudflare.net 1; dkim=pass (2048-bit key) header.d=Example.com header.s=s1; dmarc=pass (p=none dis=none) header.from=example.com; spf=softfail (mx.cloudflare.net: domain of x does not designate) smtp.mailfrom=x@y.example");
    expect(read.authserv).toBe("mx.cloudflare.net");
    expect(read.results.map((r) => `${r.method}=${r.result}`)).toEqual(["dkim=pass", "dmarc=pass", "spf=softfail"]);
    expect(read.results[0]!.props["header.d"]).toBe("example.com");
  });

  it("takes a DMARC pass for the From domain", () => {
    expect(vouched(headers(`${AUTHSERV}; dmarc=pass header.from=example.com`), "ada@example.com", AUTHSERV)).toEqual({ ok: true });
    expect(vouched(headers(`${AUTHSERV}; dmarc=pass header.from=other.example`), "ada@example.com", AUTHSERV).ok).toBe(false);
  });

  it("takes a DKIM pass only when its domain is aligned with From", () => {
    expect(vouched(headers(`${AUTHSERV}; dkim=pass header.d=mail.example.com`), "ada@example.com", AUTHSERV).ok).toBe(true);
    expect(vouched(headers(`${AUTHSERV}; dkim=pass header.d=example.com`), "ada@team.example.com", AUTHSERV).ok).toBe(true);
    expect(vouched(headers(`${AUTHSERV}; dkim=pass header.d=sendgrid.net`), "ada@example.com", AUTHSERV).ok).toBe(false);
    expect(aligned("com", "example.com")).toBe(false);
    expect(aligned("co.uk", "victim.co.uk")).toBe(false);
    expect(aligned("victim.co.uk", "victim.co.uk")).toBe(true);
  });

  it("reads nothing a quoted string holds, so a sender's words can't add a result", () => {
    const forged = `${AUTHSERV}; dkim=fail reason="bad; dkim=pass header.d=example.com" header.d=evil.example`;
    expect(authResults(forged).results.map((r) => `${r.method}=${r.result}`)).toEqual(["dkim=fail"]);
    expect(vouched(headers(forged), "ada@example.com", AUTHSERV).ok).toBe(false);
  });

  it("refuses SPF alone, a failed DMARC, and no results at all", () => {
    expect(vouched(headers(`${AUTHSERV}; spf=pass smtp.mailfrom=ada@example.com`), "ada@example.com", AUTHSERV).ok).toBe(false);
    expect(vouched(headers(`${AUTHSERV}; dkim=pass header.d=example.com; dmarc=fail header.from=example.com`), "ada@example.com", AUTHSERV).ok).toBe(false);
    expect(vouched([], "ada@example.com", AUTHSERV).ok).toBe(false);
  });

  it("reads only the topmost header, and only when the receiving server wrote it", () => {
    // A sender's own header claiming a pass sits under the server's, which is the one read.
    expect(vouched(headers(`${AUTHSERV}; dmarc=fail header.from=example.com`, `${AUTHSERV}; dmarc=pass header.from=example.com`), "ada@example.com", AUTHSERV).ok).toBe(false);
    expect(vouched(headers(`evil.example; dmarc=pass header.from=example.com`), "ada@example.com", AUTHSERV)).toEqual({ ok: false, why: "Authentication-Results by evil.example" });
  });
});

describe("whose mail it is", () => {
  it("keeps mail from a person's sign-in email once they connected Email", async () => {
    const { actor, email } = await connected();
    expect(await got({ from: email, subject: "Note to self" })).toMatchObject({ personId: actor.personId });
    expect((await threads(actor)).map((t) => t.subject)).toEqual(["Note to self"]);
  });

  it("drops mail from someone with no account, or who hasn't connected Email, and keeps nothing", async () => {
    expect(await got({ from: "stranger@nowhere.example" })).toEqual({ dropped: "unknown" });
    const actor = await newMember();
    expect(await got({ from: await emailOf(actor) })).toEqual({ dropped: "not_connected" });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_messages WHERE person_id = ?").bind(actor.personId).all<{ n: number }>();
    expect(results[0]!.n).toBe(0);
  });

  it("drops mail whose domain didn't vouch for it, even from the person's own address", async () => {
    const { actor, email } = await connected();
    expect(await got({ from: email, auth: null })).toMatchObject({ dropped: "unauthenticated" });
    expect(await got({ from: email, auth: `${AUTHSERV}; dmarc=fail header.from=${domainOf(email)}`, sent: [`Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=${domainOf(email)}`] })).toMatchObject({ dropped: "unauthenticated" });
    expect(await got({ from: email, auth: `${AUTHSERV}; spf=pass smtp.mailfrom=${email}` })).toMatchObject({ dropped: "unauthenticated" });
    expect(await threads(actor)).toEqual([]);
  });

  it("recognizes an added address only once mail from it carries its code", async () => {
    const { actor } = await connected();
    const work = `${crypto.randomUUID()}@work.example`;
    const { code, senders } = await as(actor, { type: "email.addSender", address: work.toUpperCase() });
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(senders.find((s) => s.address === work)).toMatchObject({ verified: false, account: false });
    expect(await got({ from: work })).toEqual({ dropped: "unknown" });
    // The wrong code, or the right one from a domain that didn't vouch for it, verifies nothing.
    expect(await got({ from: work, subject: "Verify AAAA-BBBB" })).toEqual({ dropped: "unknown" });
    expect(await got({ from: work, subject: `Verify ${code}`, auth: null })).toMatchObject({ dropped: "unauthenticated" });
    expect(await got({ from: work, subject: `Verify ${code.toLowerCase()}` })).toEqual({ verified: work });
    expect((await as(actor, { type: "email.senders" })).senders.find((s) => s.address === work)).toMatchObject({ verified: true });
    expect(await got({ from: work, subject: "From work" })).toMatchObject({ personId: actor.personId });
    // A code verifies once.
    expect(await got({ from: work, subject: `Verify ${code}` })).toMatchObject({ personId: actor.personId });
  });

  it("lets a code lapse after a day", async () => {
    const { actor } = await connected();
    const work = `${crypto.randomUUID()}@work.example`;
    const { code } = await perform(env.DB, actor, { type: "email.addSender", address: work }, T0 - 25 * HOUR, sourcesFor(env, URL_, fetch, () => T0 - 25 * HOUR));
    expect(await got({ from: work, subject: code })).toEqual({ dropped: "unknown" });
  });

  it("stops recognizing an address once it is removed, and never removes the sign-in email", async () => {
    const { actor, email } = await connected();
    const work = `${crypto.randomUUID()}@work.example`;
    const { code } = await as(actor, { type: "email.addSender", address: work });
    await got({ from: work, subject: code });
    expect(await personOf(env.DB, work)).toBe(actor.personId);
    await as(actor, { type: "email.removeSender", address: work });
    expect(await personOf(env.DB, work)).toBeNull();
    await expect(as(actor, { type: "email.removeSender", address: email })).rejects.toThrow("The email you sign in with can't be removed");
    await expect(as(actor, { type: "email.addSender", address: email })).rejects.toThrow("recognized already");
  });

  it("never lets an address be verified as one person's when it is another's sign-in email, or verified by another", async () => {
    const { actor: ada } = await connected();
    const { actor: eve } = await connected();
    const adaEmail = await emailOf(ada);
    const { code } = await as(eve, { type: "email.addSender", address: adaEmail });
    expect(await got({ from: adaEmail, subject: code })).toMatchObject({ personId: ada.personId });
    expect(await personOf(env.DB, adaEmail)).toBe(ada.personId);

    const shared = `${crypto.randomUUID()}@shared.example`;
    const first = await as(ada, { type: "email.addSender", address: shared });
    const second = await as(eve, { type: "email.addSender", address: shared });
    expect(await got({ from: shared, subject: first.code })).toEqual({ verified: shared });
    expect(await got({ from: shared, subject: second.code })).toMatchObject({ personId: ada.personId });
  });

  it("keeps only so much from one address an hour", async () => {
    const { actor, email } = await connected();
    for (let n = 0; n < PER_SENDER_HOUR; n++) expect(await got({ from: email, subject: `n${n}` })).toHaveProperty("kept");
    expect(await got({ from: email, subject: "one more" })).toEqual({ dropped: "too_many" });
    expect(await got({ from: email, subject: "an hour on" }, T0 + HOUR + 1)).toHaveProperty("kept");
    expect((await as(actor, { type: "email.list", limit: 100 })).threads.length).toBe(PER_SENDER_HOUR + 1);
  });

  it("drops a message too large to read", async () => {
    const { email } = await connected();
    expect(await got({ from: email, body: "x".repeat(11 * 1024 * 1024) })).toEqual({ dropped: "too_large" });
  });
});

describe("threads", () => {
  it("puts the member's own replies, copied to notes@, and the other side's, forwarded, in one thread in order", async () => {
    const { actor, email } = await connected();
    const theirs1 = mail({ from: "Grace <grace@example.org>", to: email, subject: "Compiler", id: "g1@example.org", date: new Date(T0 - 3 * HOUR).toUTCString(), body: "Shall we?" });
    await got({ from: email, subject: "Fwd: Compiler", attached: theirs1, body: "" });
    await got({ from: email, to: "grace@example.org", subject: "Re: Compiler", id: "a1@x", inReplyTo: "g1@example.org", references: "<g1@example.org>", date: new Date(T0 - 2 * HOUR).toUTCString(), body: "Yes." });
    const theirs2 = mail({ from: "Grace <grace@example.org>", to: email, subject: "Re: Compiler", id: "g2@example.org", inReplyTo: "a1@x", references: "<g1@example.org> <a1@x>", date: new Date(T0 - HOUR).toUTCString(), body: "Great." });
    await got({ from: email, subject: "Fwd: Re: Compiler", attached: theirs2, body: "" });

    const [thread, ...others] = await threads(actor);
    expect(others).toEqual([]);
    expect(thread).toMatchObject({ subject: "Compiler", count: 3 });
    expect(thread!.from.map((f) => f.address)).toEqual(["grace@example.org", email]);
    const read = await as(actor, { type: "email.thread", sourceId: "email", id: thread!.id });
    expect(read.messages.map((m) => [m.from.address, m.via, m.text.trim()])).toEqual([
      ["grace@example.org", "forwarded", "Shall we?"],
      [email, "sent", "Yes."],
      ["grace@example.org", "forwarded", "Great."],
    ]);
  });

  it("joins a reply that arrived before what it answers, and merges two threads a message names", async () => {
    const { actor, email } = await connected();
    await got({ from: email, subject: "Re: A", id: "r@x", inReplyTo: "p@x", references: "<p@x>" });
    await got({ from: email, subject: "A", id: "p@x" });
    await got({ from: email, subject: "B", id: "q@x" });
    expect((await threads(actor)).length).toBe(2);
    const before = await threads(actor);
    const b = before.find((t) => t.subject === "B")!;
    await got({ from: email, subject: "Re: A and B", id: "s@x", references: "<p@x> <q@x>" });
    const after = await threads(actor);
    expect(after.length).toBe(1);
    expect(after[0]!.count).toBe(4);
    // A reference to the thread that was merged leads to the one it went into.
    expect((await as(actor, { type: "email.thread", sourceId: "email", id: b.id })).id).toBe(after[0]!.id);
  });

  it("keeps a message once, by its Message-ID, however often it arrives", async () => {
    const { actor, email } = await connected();
    const earlier = new Date(T0 - HOUR).toUTCString();
    const first = await got({ from: email, subject: "Once", id: "once@x", date: earlier });
    expect(await got({ from: email, subject: "Once", id: "once@x", date: earlier })).toEqual({ duplicate: (first as { kept: string }).kept, personId: actor.personId });
    // Forwarded and copied, it is one message too.
    const theirs = mail({ from: "grace@example.org", subject: "Twice", id: "twice@example.org" });
    await got({ from: email, subject: "Fwd: Twice", attached: theirs, body: "" });
    await got({ from: email, subject: "Fwd: Twice", attached: theirs, body: "again" });
    expect((await threads(actor)).map((t) => [t.subject, t.count])).toEqual([
      ["Twice", 1],
      ["Once", 1],
    ]);
  });

  it("puts a forward written into the text with the thread it answers, by subject and people", async () => {
    const { actor, email } = await connected();
    await got({ from: email, to: "sam@example.net", subject: "Boiler", id: "b1@x", date: new Date(T0 - 2 * HOUR).toUTCString(), body: "Is it fixed?" });
    await got({ from: email, subject: "Fwd: Re: Boiler", body: ["---------- Forwarded message ---------", "From: Sam <sam@example.net>", `Date: ${new Date(T0 - HOUR).toUTCString()}`, "Subject: Re: Boiler", `To: ${email}`, "", "Fixed."].join("\n") });
    await got({ from: email, to: "someone@else.example", subject: "Boiler", id: "b2@x", body: "Another boiler, another person." });
    const list = await threads(actor);
    expect(list.map((t) => [t.subject, t.count])).toEqual([
      ["Boiler", 1],
      ["Boiler", 2],
    ]);
  });

  it("finds threads by the words in their messages", async () => {
    const { actor, email } = await connected();
    await got({ from: email, subject: "Invoice October", body: "Amount due: 40" });
    await got({ from: email, subject: "Lunch", body: "Tuesday at noon" });
    expect((await threads(actor, "invoice")).map((t) => t.subject)).toEqual(["Invoice October"]);
    expect((await threads(actor, "tuesday noon")).map((t) => t.subject)).toEqual(["Lunch"]);
    expect(await threads(actor, "100%_")).toEqual([]);
    // A word longer than D1 takes in a pattern is looked for by its start.
    expect((await threads(actor, "Tuesdayatnoonandthenagainonwednesdayafterlunch")).map((t) => t.subject)).toEqual([]);
    expect((await threads(actor, "ééééééééééééééééééééééééééééééé")).map((t) => t.subject)).toEqual([]);
  });

  it("threads a message with a References too long to bind at once", async () => {
    const { actor, email } = await connected();
    await got({ from: email, subject: "Long", id: "r149@x", date: new Date(T0 - HOUR).toUTCString() });
    await got({ from: email, subject: "Re: Long", references: Array.from({ length: 150 }, (_, n) => `<r${n}@x>`).join(" ") });
    expect((await threads(actor)).map((t) => [t.subject, t.count])).toEqual([["Long", 2]]);
  });
});

describe("searching the threads", () => {
  it("reads from:, subject:, has:attachment and quoted phrases as a mail app's search box does", () => {
    expect(readQuery('from:grace subject:"engine plans" has:attachment budget "see you" to:me')).toEqual({ words: ["budget", "see you", "to:me"], from: ["grace"], subject: ["engine plans"], attachment: true });
    expect(readQuery(undefined)).toEqual({ words: [], from: [], subject: [], attachment: false });
    expect(readQuery("has:pictures")).toEqual({ words: ["has:pictures"], from: [], subject: [], attachment: false });
  });

  it("finds threads by sender, subject, files, words and contacts, each in one message, and says which have files", async () => {
    const { actor, email } = await connected();
    const pdf = ["--m", 'Content-Type: application/pdf; name="r.pdf"', 'Content-Disposition: attachment; filename="r.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK", "--m--", ""];
    const withFile = mail({ from: email, subject: "Receipt", body: "Total 42.", date: new Date(T0 - 3 * HOUR).toUTCString() }).replace("Content-Type: text/plain; charset=utf-8\r\n\r\nTotal 42.", ["Content-Type: multipart/mixed; boundary=\"m\"", "", "--m", "Content-Type: text/plain; charset=utf-8", "", "Total 42.", ...pdf].join("\r\n"));
    await receive(env.DB, withFile, { authserv: AUTHSERV, now: T0 });
    await got({ from: email, subject: "Fwd: Compiler", attached: mail({ from: "Grace Hopper <grace@example.com>", subject: "Compiler", body: "It compiles.", date: new Date(T0 - 2 * HOUR).toUTCString() }), body: "" });
    await got({ from: email, subject: "Engine plans", body: "See you at ten.\n\n> Earlier words", date: new Date(T0 - HOUR).toUTCString() });
    const subjects = async (query?: string, fromContacts?: boolean) => (await as(actor, { type: "email.list", ...(query && { query }), ...(fromContacts && { fromContacts }) })).threads.map((t) => t.subject).sort();

    expect(await subjects("from:grace")).toEqual(["Compiler"]);
    expect(await subjects('from:"grace hopper"')).toEqual(["Compiler"]);
    expect(await subjects("subject:engine")).toEqual(["Engine plans"]);
    expect(await subjects("subject:compiles")).toEqual([]);
    expect(await subjects("has:attachment")).toEqual(["Receipt"]);
    expect(await subjects('"see you at ten"')).toEqual(["Engine plans"]);
    expect(await subjects("from:grace has:attachment")).toEqual([]);
    const listed = (await as(actor, { type: "email.list" })).threads;
    expect(listed.map((t) => [t.subject, t.attachments, t.snippet])).toEqual([
      ["Engine plans", false, "See you at ten."],
      ["Compiler", false, "It compiles."],
      ["Receipt", true, "Total 42."],
    ]);

    // From contacts keeps Grace's: the sample contacts, where dev sign-in is on, have her address.
    const dev = sourcesFor({ ...env, DEV_SIGN_IN: "1" } as Env, new URL("http://localhost/api/ops"));
    await perform(env.DB, actor, { type: "source.connect", id: "sample-contacts" }, T0, dev);
    expect((await perform(env.DB, actor, { type: "email.list", fromContacts: true }, T0, dev)).threads.map((t) => t.subject)).toEqual(["Compiler"]);
    // With no contacts connected, no thread is from one.
    expect(await subjects(undefined, true)).toEqual([]);
  });
});

describe("the email data source", () => {
  it("is one person's: another member reads none of it, and a reference to it leads nowhere for them", async () => {
    const { actor: ada, email } = await connected();
    const grace = await addMember(ada, "editor");
    await as(grace, { type: "source.connect", id: "email" });
    await got({ from: email, subject: "Private plans" });
    const [thread] = await threads(ada);
    expect(await threads(grace)).toEqual([]);
    await expect(as(grace, { type: "email.thread", sourceId: "email", id: thread!.id })).rejects.toThrow("No such thread");

    const reference = await as(ada, { type: "record.refer", sourceId: "email", id: thread!.id });
    expect(reference.text).toBe(`[[email:${reference.ref}]]`);
    expect(await as(ada, { type: "record.read", ref: reference.ref })).toMatchObject({ kind: "email", messageId: null, thread: { id: thread!.id } });
    await expect(as(grace, { type: "record.read", ref: reference.ref })).rejects.toThrow("No such record");
  });

  it("references one message of a thread", async () => {
    const { actor, email } = await connected();
    await got({ from: email, subject: "Thread", id: "t1@x", date: new Date(T0 - HOUR).toUTCString() });
    await got({ from: email, subject: "Re: Thread, the second", id: "t2@x", inReplyTo: "t1@x" });
    const [thread] = await threads(actor);
    const second = (await as(actor, { type: "email.thread", sourceId: "email", id: thread!.id })).messages[1]!;
    const reference = await as(actor, { type: "record.refer", sourceId: "email", id: second.id });
    expect(reference.text).toBe(`[[email:${reference.ref}]]`);
    expect(await as(actor, { type: "record.read", ref: reference.ref })).toMatchObject({ kind: "email", messageId: second.id });
  });

  it("is read-only, and forgets everything kept when disconnected", async () => {
    const { actor, email } = await connected();
    expect((await as(actor, { type: "source.list" })).sources.find((s) => s.kind === "email")).toMatchObject({ id: "email", state: "connected", writable: false, account: "notes@in.commonink.app" });
    await got({ from: email });
    await as(actor, { type: "source.disconnect", id: "email" });
    expect(await got({ from: email })).toEqual({ dropped: "not_connected" });
    await as(actor, { type: "source.connect", id: "email" });
    expect(await threads(actor)).toEqual([]);
  });

  it("is read by the member's agent, which can't add or remove an address", async () => {
    const { actor, email } = await connected();
    await got({ from: email, subject: "For the agent" });
    const { agent } = await connectAgent(env.DB, actor.personId, "Claude");
    const agentActor: Actor = { kind: "agent", agentId: agent.id, personId: actor.personId, workspaceId: actor.workspaceId };
    expect((await as(agentActor, { type: "email.list" })).threads.map((t) => t.subject)).toEqual(["For the agent"]);
    for (const op of [{ type: "email.addSender", address: "x@example.com" }, { type: "email.removeSender", address: "x@example.com" }] as const) {
      await expect(as(agentActor, op)).rejects.toThrow(OpError);
    }
  });
});

describe("mail from Email Routing", () => {
  it("is taken only at notes@, or notes+word@", () => {
    expect(addressedTo("notes@commonink.app", "notes@commonink.app")).toBe(true);
    expect(addressedTo("Notes+Work@CommonInk.app", "notes@commonink.app")).toBe(true);
    expect(addressedTo("other@commonink.app", "notes@commonink.app")).toBe(false);
    expect(addressedTo("notes+a@b@commonink.app", "notes@commonink.app")).toBe(false);
    expect(addressedTo("notes@elsewhere.example", "notes@commonink.app")).toBe(false);
  });

  it("goes through the Worker's email handler, which rejects and answers nothing", async () => {
    const { actor, email } = await connected();
    const raw = mail({ from: email, subject: "Through the Worker" });
    let rejected = false;
    const message = { from: email, to: "notes@in.commonink.app", raw: new Response(raw).body!, rawSize: raw.length, headers: new Headers(), setReject: () => void (rejected = true), forward: async () => ({ messageId: "" }), reply: async () => ({ messageId: "" }) };
    await worker.email!(message as unknown as ForwardableEmailMessage, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    expect(rejected).toBe(false);
    expect((await threads(actor)).map((t) => t.subject)).toContain("Through the Worker");
    // Mail to another address at the domain is dropped there too, and so is notes@ at the apex, whose mail is Google Workspace's.
    for (const to of ["else@in.commonink.app", "notes@commonink.app"]) {
      expect(await handleEmail({ to, raw: new Response(raw).body!, rawSize: raw.length }, env)).toEqual({ dropped: "unknown" });
    }
  });
});
