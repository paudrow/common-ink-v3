import { linesOutsideCode } from "./lines.ts";
import { writtenEventLink } from "./links.ts";
import { isPersonId, readableName, writableName, writtenMention } from "./mentions.ts";
import { addressSpans, blanked, codeSpans } from "./spans.ts";

/** A mention as notes wrote one before it was a link: `@[[target]]` or `@[[target|name]]`, where the `@` doesn't follow a letter, a digit, `_` or another `@`. */
const MENTION = /(?<![\p{L}\p{N}_@])@\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/gu;
/** A reference to an event as notes wrote one before it was a link: `::event{ref label}`. */
const EVENT = /::event\{([a-z0-9]{12})(?: [^{}\n]*)?\}/g;
const LINK = /\[\[[^[\]\n]*\]\]/g;

/**
 * The text with what notes wrote before everything a note opens was a link written as links, outside
 * code, and everything else as it was:
 *
 * - `@[[id|Name]]` is `[[person:id]]` where Name is the name of the member `memberName` says the id
 *   is, and `[[person:id|Name]]` where it isn't, so a name someone chose, or the only name left of
 *   someone who is no longer a member, is still what shows.
 * - `@[[id]]` is `[[person:id]]`, and `@[[Name]]` is `[[person:Name]]`.
 * - `::event{ref label}` is `[[event:ref]]`. The label was the event's title when it was referenced,
 *   which the link now shows as it is. One that names an event without a reference is left.
 *
 * Run on text already converted, it changes nothing.
 */
export function linksConverted(text: string, memberName: (id: string) => string | undefined): string {
  if (!text.includes("@[[") && !text.includes("::event{")) return text;
  let out = "";
  let at = 0;
  for (const { line, from } of linesOutsideCode(text)) {
    const code = blanked(line, codeSpans(line), "\0");
    const read = blanked(code, addressSpans(code), "\0");
    const found: { from: number; to: number; written: string }[] = [];
    for (const match of read.matchAll(MENTION)) {
      const target = readableName(match[1]!);
      if (!target) continue;
      const name = writableName(match[2] ?? "");
      const id = isPersonId(target) ? target : null;
      // The name a member was written with was their name then, and theirs now is shown in its place unless it is another.
      const kept = name && name !== writableName(id ? (memberName(id) ?? "") : target) ? name : null;
      found.push({ from: match.index, to: match.index + match[0].length, written: writtenMention({ id, name: target }, kept) });
    }
    // An event written inside a link, as in a mention's name, is the link's words.
    for (const match of blanked(code, [...code.matchAll(LINK)].map((link) => [link.index, link.index + link[0].length] as const), "\0").matchAll(EVENT)) found.push({ from: match.index, to: match.index + match[0].length, written: writtenEventLink(match[1]!) });
    for (const change of found.sort((a, b) => a.from - b.from)) {
      // One written inside another, as a mention in an event's label, is the other's.
      if (from + change.from < at) continue;
      out += text.slice(at, from + change.from) + change.written;
      at = from + change.to;
    }
  }
  return out + text.slice(at);
}

/** Whether a text holds a mention or a reference to an event as notes wrote them before they were links, outside code. */
export const holdsOldLinks = (text: string) => linksConverted(text, () => undefined) !== text;
