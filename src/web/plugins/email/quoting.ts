/** "On Thu, 22 Oct 2026 at 12:00, Ada <ada@example.com> wrote:", as a reply's quote begins. */
const ATTRIBUTION = /^\s*On\b.{4,300}\bwrote:\s*$/i;
const OUTLOOK = /^\s*-{3,}\s*Original Message\s*-{3,}\s*$/i;

/**
 * A reply's text as a mail app folds it: what it says, and what it quotes of the messages before it.
 * The quote is the rest of the text from the line that begins it: an attribution ("On … wrote:", on
 * one line or broken over two) over lines that start with `>`, lines that start with `>` alone, or
 * Outlook's "-----Original Message-----". A quote is folded only when nothing but more of it follows,
 * so a reply written between quoted lines is shown whole, and so is a message that is all quote.
 */
export function quoted(text: string): { said: string; quote: string | null } {
  const lines = text.split("\n");
  /** Whether everything from line `from` on is quoted, with something quoted in it. */
  const quotedFrom = (from: number) => {
    const rest = lines.slice(from).filter((line) => line.trim());
    return rest.length > 0 && rest.every((line) => /^\s*>/.test(line));
  };
  const begins = (at: number) =>
    OUTLOOK.test(lines[at]!) || quotedFrom(at) || (ATTRIBUTION.test(lines[at]!) && quotedFrom(at + 1)) || (ATTRIBUTION.test(`${lines[at]} ${lines[at + 1] ?? ""}`) && quotedFrom(at + 2));
  const at = lines.findIndex((_, i) => begins(i));
  const said = at < 0 ? "" : lines.slice(0, at).join("\n").trimEnd();
  if (!said.trim()) return { said: text, quote: null };
  return { said, quote: lines.slice(at).join("\n").trim() };
}

/** The most of a thread's text a note made from it quotes. */
const MOST_QUOTED = 20_000;

/**
 * The text of a note made from a thread: its subject as the title, the link to it, and each message
 * quoted under who sent it and when, without what it quotes of the ones before. A long thread is
 * quoted from its start until there is no more room.
 */
export function noteOf(thread: { subject: string; messages: readonly { from: { name: string; address: string }; sentAt: number; text: string }[] }, link: string, when: (time: number) => string): string {
  let room = MOST_QUOTED;
  const quotes: string[] = [];
  for (const message of thread.messages) {
    const said = quoted(message.text).said.trim();
    if (room <= 0) break;
    const text = said.slice(0, room);
    room -= text.length;
    const lines = [`**${message.from.name || message.from.address}** · ${when(message.sentAt)}`, "", ...(text ? text.split("\n") : [])];
    quotes.push(lines.map((line) => (line ? `> ${line}` : ">")).join("\n"));
  }
  return [`# ${thread.subject.replace(/\s+/g, " ").trim() || "(no subject)"}`, link, ...quotes].join("\n\n") + "\n";
}
