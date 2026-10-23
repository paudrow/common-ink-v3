import { linesOutsideCode } from "./lines.ts";
import { nameKey, parseTodo, tagsOn, todosIn } from "./todos.ts";

/**
 * A tag a line of a note has from another line, which covers it. A note has every tag written in it,
 * but a line, and so a todo, has only those written on it and those that cover it:
 *
 * - A tag in a heading covers the lines under the heading, up to the next heading at the same or a higher level.
 * - A tag on a line of nothing but tags, not in a list, covers the lines after it to the end of the
 *   section it is in: up to the next heading at the same or a higher level than the one it is under.
 *   Before the first heading, it covers the lines up to that heading, or to the end of a note with none.
 *   Under a note's title, its first `#` heading, it covers the note up to the next `#` heading.
 * - A tag anywhere else covers its line and the lines nested under it: the ones after it that are
 *   indented further, up to the first that isn't.
 *
 * Code is not read: what is in it is no tag and no heading.
 */
export interface InheritedTag {
  name: string;
  /** The line it is written on, counted from 0. */
  line: number;
  /**
   * What it is written in: a line of tags before the first heading or under the note's title ("note"), a
   * heading ("heading"), a line of tags under another heading ("section"), or a list item the line is nested in ("item").
   */
  by: "note" | "heading" | "section" | "item";
  /** The words of the heading it is in or under, or of the item it is on. Null for "note". */
  under: string | null;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;
const TAB = 4;

const indentOf = (line: string) => {
  let width = 0;
  for (const ch of /^[ \t]*/.exec(line)![0]) width += ch === "\t" ? TAB - (width % TAB) : 1;
  return width;
};

/** A heading's or an item's words: without its marks, a todo's tokens, and the tags it ends in. */
function wordsOf(line: string): string {
  const words = parseTodo(line)?.words ?? line.replace(LIST_MARK, "");
  const tags = tagsOn(words);
  let end = words.length;
  for (let i = tags.length - 1; i >= 0 && !words.slice(tags[i]!.to, end).trim(); i--) end = tags[i]!.from;
  return words.slice(0, end).replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/** Whether a line is nothing but tags, which are what it says, and not in a list or a heading. */
const onlyTags = (line: string, tags: readonly { from: number; to: number }[]) => tags.length > 0 && indentOf(line) === 0 && tags.reduce((rest, tag) => rest.slice(0, tag.from) + " ".repeat(tag.to - tag.from) + rest.slice(tag.to), line).trim() === "";

/** The most tags a line has from other lines: the nearest ones. It keeps a todo's index to a few rows, however many tags a note writes over it. */
export const MOST_COVERING = 10;

/**
 * Each line outside code that tags from other lines cover, with those tags, nearest first, each once
 * ignoring case: the nearest when two lines write it, and at most {@link MOST_COVERING}. A tag the
 * line also writes itself is among them, since it stays whatever the line becomes. With `lines`,
 * only those lines are answered for.
 */
export function tagsCovering(text: string, lines?: ReadonlySet<number>): Map<number, InheritedTag[]> {
  const covering = new Map<number, InheritedTag[]>();
  if (!text.includes("#")) return covering;
  /** The sections the line is in, the innermost last. Before the first heading it is level 7, which any heading ends. */
  const sections: { level: number; under: string | null; tags: InheritedTag[] }[] = [{ level: 7, under: null, tags: [] }];
  /** The lines with tags that the line may be nested under, the innermost last. */
  const items: { indent: number; tags: InheritedTag[] }[] = [];
  let titled = false;
  for (const { line, index } of linesOutsideCode(text)) {
    if (!line.trim()) continue;
    const heading = HEADING.exec(line);
    const indent = indentOf(line);
    if (heading) {
      while (sections.length && sections.at(-1)!.level >= heading[1]!.length) sections.pop();
      items.length = 0;
    } else {
      while (items.length && items.at(-1)!.indent >= indent) items.pop();
    }
    if (!lines || lines.has(index)) {
      const has = new Map<string, InheritedTag>();
      const scopes = [...sections, ...items];
      for (let s = scopes.length - 1; s >= 0 && has.size < MOST_COVERING; s--) {
        const { tags } = scopes[s]!;
        for (let t = tags.length - 1; t >= 0 && has.size < MOST_COVERING; t--) if (!has.has(nameKey(tags[t]!.name))) has.set(nameKey(tags[t]!.name), tags[t]!);
      }
      if (has.size) covering.set(index, [...has.values()]);
    }
    const written = tagsOn(line);
    if (heading) {
      const under = wordsOf(heading[2]!);
      const level = heading[1]!.length;
      // The note's title is its first # heading, as its title is read: a line of tags under it is the note's.
      const title: boolean = level === 1 && !titled;
      titled ||= title;
      sections.push({ level, under: title ? null : under, tags: written.map(({ name }) => ({ name, line: index, by: "heading", under })) });
    } else if (onlyTags(line, written)) {
      const { under, tags } = sections.at(-1)!;
      tags.push(...written.map(({ name }): InheritedTag => ({ name, line: index, by: under === null ? "note" : "section", under })));
    } else if (written.length) {
      const under = wordsOf(line);
      items.push({ indent, tags: written.map(({ name }) => ({ name, line: index, by: "item", under })) });
    }
  }
  return covering;
}

/** The tags a todo has: the ones written on its line, then the ones that cover it and it doesn't write, nearest first, each once ignoring case. */
export function tagsOfTodo(written: string, covering: readonly InheritedTag[]): string[] {
  const names = new Map<string, string>();
  for (const { name } of [...tagsOn(written), ...covering]) if (!names.has(nameKey(name))) names.set(nameKey(name), name);
  return [...names.values()];
}

/** What the index holds of the tags of a note's todos: a row for each tag of each todo, as `tagsOfTodo` gives them. */
export function todoTagIndex(text: string): [line: number, key: string, name: string][] {
  const todos = todosIn(text);
  const covering = tagsCovering(text, new Set(todos.map((todo) => todo.line)));
  return todos.flatMap((todo) => tagsOfTodo(todo.text, covering.get(todo.line) ?? []).map((name): [number, string, string] => [todo.line, nameKey(name), name]));
}
