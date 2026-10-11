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

const TITLE_LENGTH = 80;

/** A line as it reads: without its marks, and without what is drawn in it and has no words of its own. */
const plainText = (line: string) =>
  line
    .replace(/^\s*(?:>\s*)*/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\](?:\s+|$))?/, "")
    // An embed and an image are drawn, and a block of math's fence is no words.
    .replace(/:{2,3}[a-z][a-z0-9-]*\{[^{}]*\}/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^(?::::|\$\$)\s*$/, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    // A link with no words of its own shows its note's title, which isn't this note's to keep.
    .replace(/\s*\[\[[a-z0-9]{12}\]\]/g, "")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    // Marks around words, and not a lone `*` or backtick that is one of the words: `2 * 3`.
    .replace(/(`+)([^`]+)\1/g, "$2")
    .replace(/(\*\*|~~|__)(?=\S)([^*~_]+)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(?=\S)([^*_]+)(?<=\S)\1(?![\w*])/g, "$2")
    .replace(/\s+/g, " ")
    .trim();

const ADDRESS = /^https?:\/\/\S+$/;

function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  const space = text.lastIndexOf(" ", length - 1);
  return `${text.slice(0, space > 0 ? space : length - 1).trimEnd()}…`;
}

/**
 * The title is the words of the first `#` heading outside code blocks that has any. A note with no
 * such heading is titled by its first line of words, cut to a title's length, and a line that is
 * only a web address is passed over for one that says something. The title is "" for a note with no
 * words at all. The snippet is the prose besides the title, and open todos count unchecked list
 * checkboxes.
 */
export function summarize(text: string): { title: string; snippet: string; openTodos: number } {
  let openTodos = 0;
  let heading = -1;
  const prose: string[] = [];
  for (const { line } of linesOutsideCode(text)) {
    if (OPEN_TODO.test(line)) openTodos++;
    if (RULE.test(line)) continue;
    const titling = heading < 0 ? HEADING.exec(line)?.[1] : undefined;
    const words = plainText(titling ?? line);
    if (!words) continue;
    if (titling !== undefined) heading = prose.length;
    prose.push(words);
  }
  const said = prose.findIndex((words) => !ADDRESS.test(words));
  const from = heading >= 0 ? heading : said >= 0 ? said : 0;
  const whole = prose[from] ?? "";
  const title = heading >= 0 ? whole : clip(whole, TITLE_LENGTH);
  // A first line too long for a title is still all there to read below it.
  if (title === whole) prose.splice(from, 1);
  return { title, snippet: clip(prose.join(" "), SNIPPET_LENGTH), openTodos };
}
