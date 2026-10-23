/** An embed as a note writes it, and where. Offsets are into the note's text. */
export interface Written {
  name: string;
  config: string;
  /** A block's lines between its opening and closing lines, each with its line break. Empty for an inline embed. */
  body: string;
  block: boolean;
  /** From the first `:` to the closing `}`, or for a block to the end of its closing line. */
  from: number;
  to: number;
  configFrom: number;
  bodyFrom: number;
}

const NAME = "[a-z][a-z0-9-]*";
const CONFIG = "[^{}\\n]*";
/** `::name{config}` on one line. A third colon makes it the opening of a block, which isn't one of these. */
const INLINE = new RegExp(`(?<!:)::(${NAME})\\{(${CONFIG})\\}`, "g");
const OPENING = new RegExp(`^:::(${NAME})\\{(${CONFIG})\\}[ \\t]*$`);
const CLOSING = /^:::[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The inline embeds in `text`, which starts at `offset` in the note. */
export function inlineIn(text: string, offset = 0): Written[] {
  return [...text.matchAll(INLINE)].map((match) => {
    const from = offset + match.index;
    const configFrom = from + 2 + match[1]!.length + 1;
    return { name: match[1]!, config: match[2]!, body: "", block: false, from, to: from + match[0].length, configFrom, bodyFrom: from + match[0].length };
  });
}

/**
 * The block embeds in a note: `:::name{config}` on a line of its own, then its body, then `:::` on a
 * line of its own. One with no closing line isn't a block, and neither is one inside a code fence.
 */
export function blocksIn(text: string): Written[] {
  const blocks: Written[] = [];
  let fence: string | null = null;
  let open: { name: string; config: string; from: number; bodyFrom: number } | null = null;
  let from = 0;
  for (const line of text.split("\n")) {
    const next = from + line.length + 1;
    if (open) {
      if (CLOSING.test(line)) {
        blocks.push({ ...open, body: text.slice(open.bodyFrom, from), block: true, to: from + line.length, configFrom: open.from + 3 + open.name.length + 1 });
        open = null;
      }
    } else if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
    } else {
      const opening = OPENING.exec(line);
      if (opening) open = { name: opening[1]!, config: opening[2]!, from, bodyFrom: next };
      else fence = FENCE.exec(line)?.[1] ?? null;
    }
    from = next;
  }
  return blocks;
}

export interface Rewrite {
  from: number;
  to: number;
  insert: string;
}

/** The smallest single replacement that turns `before` into `after`, with `before` at `at` in the note. */
function replacing(before: string, after: string, at: number): Rewrite[] {
  if (before === after) return [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return [{ from: at + start, to: at + before.length - end, insert: after.slice(start, after.length - end) }];
}

/**
 * The edits to a note that give the embed written at `written` a new config, a new body, or both.
 * It throws for one that would stop the note reading as that embed, so an embed can't write its way
 * out of its own range.
 */
export function rewriteOf(written: Written, next: { config?: string; body?: string }): Rewrite[] {
  const edits: Rewrite[] = [];
  if (next.config !== undefined) {
    if (/[{}\n]/.test(next.config)) throw new Error("An embed's config can't hold { or } or a line break");
    edits.push(...replacing(written.config, next.config, written.configFrom));
  }
  if (next.body !== undefined) {
    if (!written.block) throw new Error("Only a block embed has a body");
    const body = next.body === "" || next.body.endsWith("\n") ? next.body : `${next.body}\n`;
    if (body.split("\n").some((line) => CLOSING.test(line))) throw new Error("A block embed's body can't hold a line that is only :::");
    edits.push(...replacing(written.body, body, written.bodyFrom));
  }
  return edits;
}

/** Whether two readings are of the same embed with the same config and body, wherever each is in the note. */
export const sameWritten = (a: Pick<Written, "name" | "config" | "body" | "block">, b: Pick<Written, "name" | "config" | "body" | "block">) =>
  a.name === b.name && a.config === b.config && a.body === b.body && a.block === b.block;
