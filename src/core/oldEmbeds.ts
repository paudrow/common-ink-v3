import { BUILT_IN_EMBEDS, PLUGIN_PREFIX, fenced, holdable, readNote, writtenEmbed } from "./embedSyntax.ts";
import { writtenMention } from "./mentions.ts";
import { codeSpans } from "./spans.ts";

/**
 * Embeds were written `::name{config}`, and those that hold content `:::name{config}` on a line,
 * then the content, then `:::` on a line. This reads those, once, to write them as they are written
 * now.
 */

const INLINE = /(?<!:)::([a-z][a-z0-9-]*)\{([^{}\n]*)\}/g;
const OPENING = /^:::([a-z][a-z0-9-]*)\{([^{}\n]*)\}[ \t]*$/;
const CLOSING = /^:::[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether the old form of `name` was one of the app's embeds or a plugin's, which are the ones there are to convert. */
const known = (name: string) => Object.hasOwn(BUILT_IN_EMBEDS, name) || name.startsWith(PLUGIN_PREFIX);

/**
 * A config as the parentheses can hold it. One with a `)` nothing opens or a stray quote, as an
 * event's label could have, loses its parentheses, and then its quotes; one that still can't be held
 * is null.
 */
function heldConfig(config: string): string | null {
  for (const tried of [config, config.replace(/[()]/g, ""), config.replace(/[()"]/g, "")]) if (holdable(tried)) return tried;
  return null;
}

/**
 * A contact, `::contact{ref Name}`, as a mention of them by their name, as `@` writes one: a contact
 * is no embed now. One with no name has nothing to name them by, and is left as written.
 */
function contactNow(config: string): string | null {
  const name = /^[a-z0-9]{12} (.+)$/.exec(config.trim())?.[1];
  return (name && writtenMention({ name })) || null;
}

/**
 * Each `::name{config}` on a line outside inline code, where it is, with the `/name(config)` it is
 * written as now. One that followed a letter or a digit gets a space before it, so it is still an
 * embed. One that followed any other mark, as in `**::timer{5m}**` or an address, is left as
 * written: a space there would undo the mark around it. A contact is a mention, which is one
 * after any mark.
 */
function inlineOld(line: string): { whole: string; at: number; now: string }[] {
  if (!line.includes("::")) return [];
  const code = codeSpans(line);
  return [...line.matchAll(INLINE)].flatMap(({ 0: whole, 1: name, 2: config, index: at }) => {
    if (code.some(([from, to]) => at >= from && at < to)) return [];
    if (name === "contact") {
      const now = contactNow(config!);
      return now ? [{ whole, at, now }] : [];
    }
    const held = heldConfig(config!);
    const before = at > 0 ? line[at - 1]! : " ";
    if (!known(name!) || BUILT_IN_EMBEDS[name!] || held === null || code.some(([from, to]) => at >= from && at < to) || !/[\s\p{L}\p{N}]/u.test(before)) return [];
    return [{ whole, at, now: `${/\s/.test(before) ? "" : " "}${writtenEmbed(name!, held)}` }];
  });
}

const inlineConverted = (line: string) => inlineOld(line).reduceRight((out, { whole, at, now }) => out.slice(0, at) + now + out.slice(at + whole.length), line);

/**
 * A note's text with its embeds written as they are now: `::name{config}` as `/name(config)`, and
 * `:::name{config}` with its content and its closing `:::` as `/name(config)` with the content in a
 * fence under it, tagged with what it is. Code, inline code and a block that was never closed are
 * left as written, and so are names that were never an embed's. Run on text already converted, it
 * changes nothing.
 */
export function embedsConverted(text: string): string {
  if (!text.includes("::")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
      out.push(line);
      continue;
    }
    const open = OPENING.exec(line);
    const close = open ? lines.findIndex((l, m) => m > n && CLOSING.test(l)) : -1;
    const held = open && heldConfig(open[2]!);
    if (open && close > 0 && known(open[1]!) && held !== null) {
      const kind = BUILT_IN_EMBEDS[open[1]!] ?? "markdown";
      const body = lines.slice(n + 1, close).map((l) => l + "\n").join("");
      out.push(writtenEmbed(open[1]!, held) + fenced(kind, kind === "markdown" ? embedsConverted(body) : body));
      n = close;
      continue;
    }
    fence = FENCE.exec(line)?.[1] ?? null;
    out.push(fence ? line : inlineConverted(line));
  }
  return out.join("\n");
}

/** Whether a text writes an embed the old way, outside code, that there is to convert. */
export const holdsOldEmbeds = (text: string) => embedsConverted(text) !== text;

/** Each line of a text that writes an embed the old way, from 1, with the old forms on it and how the line is written now, for telling an agent what to write instead. */
export function oldEmbedLines(text: string): { line: number; written: string; now: string; forms: string[] }[] {
  if (!text.includes("::")) return [];
  const found: { line: number; written: string; now: string; forms: string[] }[] = [];
  for (const { line, index, is } of readNote(text).lines) {
    if (is !== "prose" && is !== "markdown") continue;
    const open = OPENING.exec(line);
    if (open && known(open[1]!)) {
      found.push({ line: index + 1, written: line.trim(), now: `${writtenEmbed(open[1]!, open[2]!)} with its content in a fence under it`, forms: [line.trim()] });
      continue;
    }
    const old = inlineOld(line);
    if (old.length) found.push({ line: index + 1, written: line.trim(), now: inlineConverted(line).trim(), forms: old.map((o) => o.whole) });
  }
  return found;
}
