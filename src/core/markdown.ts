const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const OPEN_TODO = /^\s*(?:[-*+]|\d+[.)])\s+\[ \](?:\s|$)/;
const SNIPPET_LENGTH = 160;

function* linesOutsideCode(text: string): Generator<string> {
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (!fence) yield line;
  }
}

const plainText = (line: string) =>
  line
    .replace(/^\s*(?:>\s*)*/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\](?:\s+|$))?/, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
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
  for (const line of linesOutsideCode(text)) {
    if (OPEN_TODO.test(line)) openTodos++;
    const heading = !title && HEADING.exec(line)?.[1]?.trim();
    if (heading) title = heading;
    else if (!RULE.test(line)) prose.push(plainText(line));
  }
  return { title, snippet: clip(prose.filter(Boolean).join(" ")), openTodos };
}
