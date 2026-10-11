import { linesOutsideCode } from "./lines.ts";
import { parseTodo } from "./todos.ts";

const HEADING = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SNIPPET_LENGTH = 160;

const plainText = (line: string) =>
  line
    .replace(/^\s*(?:>\s*)*/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\](?:\s+|$))?/, "")
    // A mention reads as the name it was written with.
    .replace(/@\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/g, "@$1")
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
 * The snippet is the prose after it, a todo by its words alone, and open todos count the todos not yet done.
 */
export function summarize(text: string): { title: string; snippet: string; openTodos: number } {
  let title = "";
  let openTodos = 0;
  const prose: string[] = [];
  for (const { line } of linesOutsideCode(text)) {
    const todo = parseTodo(line);
    if (todo?.done === false) openTodos++;
    const heading = !title && HEADING.exec(line)?.[1]?.trim();
    if (heading) title = heading;
    // A todo reads as its words: its importance, due date and projects are options, not prose.
    else if (!RULE.test(line)) prose.push(plainText(todo ? todo.words : line));
  }
  return { title, snippet: clip(prose.filter(Boolean).join(" ")), openTodos };
}
