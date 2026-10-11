const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const OPEN_TODO = /^\s*(?:[-*+]|\d+[.)])\s+\[ \](?:\s|$)/;
const SNIPPET_LENGTH = 160;

/**
 * Each line of a note that isn't in a fenced code block or a fence, with where it starts. Indented
 * lines are not taken for code: a bullet nested three deep is indented as far as a code block is.
 */
export function* linesOutsideCode(text: string): Generator<{ line: string; from: number }> {
  let fence: string | null = null;
  let from = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
    } else if (!fence) yield { line, from };
    from += line.length + 1;
  }
}

const plainText = (line: string) =>
  line
    .replace(/^\s*(?:>\s*)*/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\](?:\s+|$))?/, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    // A link with no words of its own shows its note's title, which isn't this note's to keep.
    .replace(/\s*\[\[[a-z0-9]{12}\]\]/g, "")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`|\*|~~/g, "")
    .trim();

function clip(text: string): string {
  if (text.length <= SNIPPET_LENGTH) return text;
  const space = text.lastIndexOf(" ", SNIPPET_LENGTH - 1);
  return `${text.slice(0, space > 0 ? space : SNIPPET_LENGTH - 1).trimEnd()}…`;
}

/**
 * The title is the first `#` heading outside code blocks, or "" when there is none.
 * The snippet is the prose after it, and open todos count unchecked list checkboxes.
 */
export function summarize(text: string): { title: string; snippet: string; openTodos: number } {
  let title = "";
  let openTodos = 0;
  const prose: string[] = [];
  for (const { line } of linesOutsideCode(text)) {
    if (OPEN_TODO.test(line)) openTodos++;
    const heading = !title && HEADING.exec(line)?.[1]?.trim();
    if (heading) title = heading;
    else if (!RULE.test(line)) prose.push(plainText(line));
  }
  return { title, snippet: clip(prose.filter(Boolean).join(" ")), openTodos };
}
