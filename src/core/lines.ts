const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FORM_OPEN = /^:::form\{[^{}\n]*\}[ \t]*$/;
const FORM_CLOSE = /^:::[ \t]*$/;

/**
 * Each line of a note that isn't in a fenced code block, a fence, or a form embed, with where it
 * starts and which line it is, counted from 0. A form's body is JSON, so it is not the note's
 * prose. An opening with no closing line is not a form, and the lines stay. Indented lines are not
 * taken for code: a bullet nested three deep is indented as far as a code block is.
 */
export function* linesOutsideCode(text: string): Generator<{ line: string; from: number; index: number }> {
  const forms = formSpans(text);
  let fence: string | null = null;
  let from = 0;
  let index = 0;
  for (const line of text.split("\n")) {
    const inside = forms.some((span) => from >= span.from && from <= span.to);
    const marker = !inside ? FENCE.exec(line)?.[1]?.[0] : undefined;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
    } else if (!inside && !fence) yield { line, from, index };
    from += line.length + 1;
    index++;
  }
}

/** Where each closed `:::form` block runs, from its opening line through the end of its closing line. */
function formSpans(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let open: number | null = null;
  let fence: string | null = null;
  let from = 0;
  for (const line of text.split("\n")) {
    if (open !== null) {
      if (FORM_CLOSE.test(line)) {
        spans.push({ from: open, to: from + line.length });
        open = null;
      }
    } else if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
    } else if (FORM_OPEN.test(line)) open = from;
    else fence = FENCE.exec(line)?.[1] ?? null;
    from += line.length + 1;
  }
  return spans;
}
