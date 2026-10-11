const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Each line of a note that isn't in a fenced code block or a fence, with where it starts and which
 * line it is, counted from 0. Indented lines are not taken for code: a bullet nested three deep is
 * indented as far as a code block is.
 */
export function* linesOutsideCode(text: string): Generator<{ line: string; from: number; index: number }> {
  let fence: string | null = null;
  let from = 0;
  let index = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
    } else if (!fence) yield { line, from, index };
    from += line.length + 1;
    index++;
  }
}
