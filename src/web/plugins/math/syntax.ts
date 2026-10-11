/** A formula as a note writes it, and where. `tex` is what is between the dollar signs. */
export interface Formula {
  from: number;
  to: number;
  tex: string;
  /** Set on its own, centered, as `$$…$$` is. */
  display: boolean;
}

/** A block of math, and how many lines the note writes it on, counting its two lines of `$$`. */
export interface MathBlock extends Formula {
  lines: number;
}

/**
 * `$$…$$`, or `$…$` with no space inside either dollar and no digit after the closing one, so
 * "$5 and $10" is money. A `\$` is a dollar sign and opens or closes nothing.
 */
const INLINE = /(?<![\\$])\$\$(?!\$)((?:\\.|[^$\\])+?)\$\$(?!\$)|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\])*?)(?<![\s\\])\$(?![\d$])/g;

/** The formulas on one line of a note, which starts at `offset`. */
export function formulasIn(line: string, offset = 0): Formula[] {
  return [...line.matchAll(INLINE)].map((match) => ({ from: offset + match.index, to: offset + match.index + match[0].length, tex: (match[1] ?? match[2]!).trim(), display: match[1] !== undefined }));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DOLLARS = /^\$\$[ \t]*$/;

/**
 * The blocks of math in a note: a line that is only `$$`, the formula on the lines after it, and a
 * line that is only `$$`. One with no closing line isn't a block, and neither is one in a code fence.
 */
export function mathBlocksIn(lines: Iterable<string>): MathBlock[] {
  const blocks: MathBlock[] = [];
  let fence: string | null = null;
  let open: { from: number; body: string[] } | null = null;
  let from = 0;
  for (const line of lines) {
    if (open) {
      if (DOLLARS.test(line)) {
        blocks.push({ from: open.from, to: from + line.length, tex: open.body.join("\n").trim(), display: true, lines: open.body.length + 2 });
        open = null;
      } else open.body.push(line);
    } else if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
    } else if (DOLLARS.test(line)) open = { from, body: [] };
    else fence = FENCE.exec(line)?.[1] ?? null;
    from += line.length + 1;
  }
  return blocks;
}

/** Whether text has anything that would be drawn as math, which is when the drawing is worth fetching. A price is not. */
export const hasMath = (text: string) => {
  const lines = text.split("\n");
  return lines.some((line) => formulasIn(line).length > 0) || mathBlocksIn(lines).length > 0;
};
