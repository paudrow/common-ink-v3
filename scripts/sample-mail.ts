// Keeps a few sample threads in the dev user's Email on a running Common Ink where dev sign-in is on,
// as mail sent to notes@ would be kept: through /dev/email, with the receiving server's header written
// as Cloudflare writes it. It connects Email and the sample contacts, which may be changed, first.
// Each message has an id of its own, so running it again keeps nothing twice.
//
//   node scripts/sample-mail.ts --url http://localhost:5300
//
// The threads: "Engine plans", a conversation of three with quoted replies; "Your receipt", HTML with
// a file attached and what sanitizing takes out; "Compiler notes", forwarded from Grace Hopper, a
// sample contact; "Frequency hopping", forwarded from Hedy Lamarr, who isn't one; and "Weekend sale"
// and "Last chance", forwarded from a mailing list, for a skip rule to match.
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { url: { type: "string" } } });
if (!values.url) throw new Error("usage: node scripts/sample-mail.ts --url <app url>");
const url = values.url.replace(/\/$/, "");

const me = (await (await fetch(`${url}/api/me`)).json()) as { person: { email: string }; workspaces: { id: string }[] };
const workspace = me.workspaces[0]?.id;
if (!workspace) throw new Error(`${url} has no workspace for the dev user`);
const email = me.person.email;
const domain = email.replace(/.*@/, "");

async function op(body: object): Promise<unknown> {
  const res = await fetch(`${url}/api/workspaces/${workspace}/ops`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${JSON.stringify(body)}: ${await res.text()}`);
  return res.json();
}

await op({ type: "source.connect", id: "email", back: "/email" });
await op({ type: "source.connect", id: "sample-contacts", back: "/email", edit: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toUTCString();
const head = (subject: string, id: string, hours: number, more: string[] = []) => [
  `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
  `From: Dev User <${email}>`,
  "To: notes@in.commonink.app",
  `Subject: ${subject}`,
  `Message-ID: <${id}@${domain}>`,
  `Date: ${ago(hours)}`,
  "MIME-Version: 1.0",
  ...more,
];
const plain = (text: string) => ["Content-Type: text/plain; charset=utf-8", "", text];
/** The member's forward of someone else's message, attached whole, as Gmail's "Forward as attachment" sends it. */
const forward = (subject: string, id: string, hours: number, from: string, text: string, more: string[] = []) => [
  ...head(`Fwd: ${subject}`, `fwd-${id}`, hours),
  'Content-Type: multipart/mixed; boundary="fw"',
  "",
  "--fw",
  ...plain(""),
  "--fw",
  "Content-Type: message/rfc822",
  "",
  `From: ${from}`,
  `To: Dev User <${email}>`,
  `Subject: ${subject}`,
  `Message-ID: <${id}@sample.example>`,
  `Date: ${ago(hours + 1)}`,
  ...more,
  ...plain(text),
  "--fw--",
];

const messages: string[][] = [
  [...head("Engine plans", "sample-plans-1", 50), ...plain("Shall we meet about the engine this week?\n\nAda")],
  [...head("Re: Engine plans", "sample-plans-2", 49, [`In-Reply-To: <sample-plans-1@${domain}>`]), ...plain(`Thursday works.\n\nOn ${ago(50)}, Dev User <${email}> wrote:\n> Shall we meet about the engine this week?\n>\n> Ada`)],
  [...head("Re: Engine plans", "sample-plans-3", 48, [`In-Reply-To: <sample-plans-2@${domain}>`]), ...plain("See you at ten, by the gears.\n\n> Thursday works.")],
  [
    ...head("Your receipt", "sample-receipt", 30),
    'Content-Type: multipart/mixed; boundary="m"',
    "",
    "--m",
    'Content-Type: multipart/alternative; boundary="a"',
    "",
    "--a",
    ...plain("Thanks for your order. Total: 42 pounds."),
    "--a",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<h2 style="color:red">Thanks for your order</h2><p onclick="alert(1)">Total: <b>42 pounds</b>.</p><table border="1" cellpadding="6"><tr><td>Brass gears</td><td>30</td></tr><tr><td>Punched cards</td><td>12</td></tr></table><p><a href="https://shop.example/order">Your order</a> · <a href="javascript:alert(2)">a link that goes nowhere</a></p><script>alert(3)</script><img src="https://track.example/pixel.gif" alt="a tracking picture">',
    "--a--",
    "--m",
    'Content-Type: application/pdf; name="receipt.pdf"',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcOkw7zDtsOfCg==",
    "--m--",
  ],
  forward("Compiler notes", "sample-compiler", 20, "Grace Hopper <grace@example.com>", "The compiler compiles. Next, a language anyone can read."),
  forward("Frequency hopping", "sample-hopping", 10, "Hedy Lamarr <hedy@films.example>", "A radio that hops between frequencies can't be jammed. Shall we patent it?"),
  forward("Weekend sale", "sample-sale-1", 6, "Shop News <deals@news.shop.example>", "Half price on everything this weekend. Unsubscribe any time.", ["List-Id: Shop News <news.shop.example>"]),
  forward("Last chance", "sample-sale-2", 2, "Shop News <deals@news.shop.example>", "Half price ends tonight. Unsubscribe any time.", ["List-Id: Shop News <news.shop.example>"]),
];

for (const lines of messages) {
  const res = await fetch(`${url}/dev/email`, { method: "POST", body: lines.join("\r\n") });
  const said = (await res.json()) as Record<string, unknown>;
  const subject = lines.find((l) => l.startsWith("Subject: "))!.slice(9);
  console.log(`${subject}: ${"kept" in said ? "kept" : "duplicate" in said ? "kept already" : `not kept (${JSON.stringify(said)})`}`);
}
