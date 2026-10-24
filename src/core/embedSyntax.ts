/** What an embed's content is, which is how the editor draws it and the tag its fence is written with. */
export type ContentKind = "markdown" | "html" | "json";

/**
 * What a name is to a note: not an embed (undefined), an embed with no content (null), or an embed
 * that holds content of that kind, written alone on its line with the content in a fence under it.
 */
export type KindOf = (name: string) => ContentKind | null | undefined;

/** The app's own embeds, each with the kind of content it holds or null. */
export const BUILT_IN_EMBEDS: Readonly<Record<string, ContentKind | null>> = {
  timer: null,
  stopwatch: null,
  html: "html",
  kanban: "markdown",
  form: "json",
  email: null,
  image: null,
  video: null,
  drawing: null,
  audio: null,
  file: null,
};

/** A third-party plugin's embeds are named `x-…`. Only its plugin knows what one holds, so the core reads none of them as holding content. */
export const PLUGIN_PREFIX = "x-";

/** The embeds the core knows of: the app's own and any plugin's. */
export const builtInKinds: KindOf = (name) => (Object.hasOwn(BUILT_IN_EMBEDS, name) ? BUILT_IN_EMBEDS[name] : name.startsWith(PLUGIN_PREFIX) ? null : undefined);

/** The fence around an embed's content: its opening line, its closing line, the run of backticks or tildes both start with, and the opening's tag. */
export interface Fence {
  marker: string;
  info: string;
  open: { from: number; to: number };
  close: { from: number; to: number };
}

/** An embed as a note writes it, and where. Offsets are into the note's text. */
export interface Written {
  name: string;
  config: string;
  /** Its content's lines, each with its line break. Empty for an embed with none. */
  body: string;
  /** What it holds, for an embed whose kind holds content, which it may not have yet; null for any other. */
  content: ContentKind | null;
  /** The fence its content is in, or null where no fence is under it. */
  fence: Fence | null;
  /** From its `/` to its `)`; for one that holds content, to the end of its line, or of its fence's closing line. */
  from: number;
  to: number;
  configFrom: number;
  bodyFrom: number;
}

const NAME = /[a-z][a-z0-9-]*/y;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The longest args are read: a line of thousands of `/timer(` would otherwise read the rest of the line from each. */
const LONGEST_ARGS = 400;

/**
 * Where the args that start at `at`, just past a `(`, end: the index of their `)`, or -1 where the
 * line has none. Parentheses inside them nest, and those inside "quotes" don't count.
 */
function argsEnd(line: string, at: number, last = line.length - 1): number {
  let depth = 0;
  let quoted = false;
  for (let i = at; i <= Math.min(last, at + LONGEST_ARGS); i++) {
    const c = line[i];
    if (c === "\n") return -1;
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")" && depth-- === 0) return i;
  }
  return -1;
}

/** Whether `config` can be written between an embed's parentheses and read back as all of it. */
export const holdable = (config: string) => argsEnd(`${config})`, 0) === config.length;

/** A `/name(args)` in a line, with where it is in the note. */
export interface Call {
  name: string;
  config: string;
  from: number;
  to: number;
  configFrom: number;
}

/** Each `/name(args)` in `line`, the line at `offset` in the note, for a name `kindOf` knows, at the start of the line or after whitespace. */
export function callsIn(line: string, offset = 0, kindOf: KindOf = builtInKinds): Call[] {
  const calls: Call[] = [];
  // Nothing past the last `)` can be closed, so a line of openings and no closing is read once.
  const last = line.lastIndexOf(")");
  for (let i = line.indexOf("/"); i >= 0 && i < last; i = line.indexOf("/", i + 1)) {
    if (i > 0 && !/\s/.test(line[i - 1]!)) continue;
    NAME.lastIndex = i + 1;
    const name = NAME.exec(line)?.[0];
    const open = i + 1 + (name?.length ?? 0);
    if (!name || line[open] !== "(" || kindOf(name) === undefined) continue;
    const end = argsEnd(line, open + 1, last);
    if (end < 0) continue;
    calls.push({ name, config: line.slice(open + 1, end), from: offset + i, to: offset + end + 1, configFrom: offset + open + 1 });
    i = end;
  }
  return calls;
}

/** The edit distance between two short words. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** Which of `words` `word` was most likely meant to be: one two edits away or less, or one it is the start of. Nothing for a word nowhere near any. */
export function closestOf(word: string, words: Iterable<string>): string | undefined {
  let best: { word: string; far: number } | undefined;
  for (const one of words) {
    const far = word.length >= 2 && one.startsWith(word) ? 0 : distance(word, one);
    if (far <= 2 && (!best || far < best.far)) best = { word: one, far };
  }
  return best?.word;
}

/** A `/name(args)` that names no embed, and the embed it was likely meant to be: `name` is where the name is written in the note. */
export interface Misspelt {
  name: string;
  meant: string;
  from: number;
  to: number;
}

/**
 * Each `/name(args)` in `line`, the line at `offset`, where an embed would be, whose name is no embed's
 * of `names` and is close to one. A word nowhere near a name, as `/usr(x)`, is ordinary text.
 */
export function misspeltIn(line: string, offset: number, names: readonly string[]): Misspelt[] {
  const found: Misspelt[] = [];
  const last = line.lastIndexOf(")");
  for (let i = line.indexOf("/"); i >= 0 && i < last; i = line.indexOf("/", i + 1)) {
    if (i > 0 && !/\s/.test(line[i - 1]!)) continue;
    NAME.lastIndex = i + 1;
    const name = NAME.exec(line)?.[0];
    const open = i + 1 + (name?.length ?? 0);
    if (!name || line[open] !== "(" || names.includes(name) || argsEnd(line, open + 1, last) < 0) continue;
    const meant = closestOf(name, names);
    // A short word is near too many names to be taken for one but by a letter: /or(x) is no /form.
    if (meant && (name.length >= 4 || distance(name, meant) <= 1)) found.push({ name, meant, from: offset + i + 1, to: offset + open });
  }
  return found;
}

/** The embeds with no content in `line`, the line at `offset` in the note. One whose kind holds content is an embed only on a line of its own, which `readNote` reads. */
export function inlineIn(line: string, offset = 0, kindOf: KindOf = builtInKinds): Written[] {
  return callsIn(line, offset, kindOf)
    .filter((call) => kindOf(call.name) === null)
    .map((call) => ({ ...call, body: "", content: null, fence: null, bodyFrom: call.to }));
}

/** What a line of a note is, as `readNote` reads it. */
export type LineIs =
  /** Words of the note, an embed's line among them. */
  | "prose"
  /** In a fenced code block, or one of its fences. */
  | "code"
  /** One of the fences around an embed's content. */
  | "fence"
  /** A line of an embed's content. Markdown content is words of the note; any other is code. */
  | ContentKind;

export interface NoteLine {
  line: string;
  from: number;
  /** Which line it is, counted from 0. */
  index: number;
  is: LineIs;
}

/** A fence's opening line, read as CommonMark does: its marker, and its info, which for backticks has none in it. */
function opening(line: string): { marker: string; info: string } | null {
  const open = FENCE_OPEN.exec(line);
  if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) return null;
  return { marker: open[1]!, info: open[2]!.trim() };
}

/** Whether `line` closes a fence opened with `marker`: as many of its character or more, and nothing else. */
const closes = (line: string, marker: string) => {
  const trimmed = line.trimEnd();
  let lead = 0;
  while (trimmed[lead] === " ") lead++;
  const run = trimmed.slice(lead);
  return lead <= 3 && run.length >= marker.length && [...run].every((c) => c === marker[0]);
};

/** The one embed `line` is, and nothing else but spaces after it. */
function aloneCall(line: string, offset: number, kindOf: KindOf): Call | undefined {
  if (!line.startsWith("/")) return undefined;
  const [call] = callsIn(line, offset, kindOf);
  return call && call.from === offset && line.slice(call.to - offset).trim() === "" ? call : undefined;
}

/**
 * Reads a note line by line, once: its fenced code, and each embed whose kind holds content, alone
 * on its line, with the fence directly under it as its content. A fence that is never closed is
 * code to the end of the note, as CommonMark has it, and is no embed's content.
 */
export function readNote(text: string, kindOf: KindOf = builtInKinds): { lines: NoteLine[]; blocks: Written[] } {
  const split = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of split) {
    starts.push(at);
    at += line.length + 1;
  }
  const closing = (from: number, marker: string) => {
    for (let n = from; n < split.length; n++) if (closes(split[n]!, marker)) return n;
    return -1;
  };
  const lines: NoteLine[] = [];
  const blocks: Written[] = [];
  const push = (n: number, is: LineIs) => lines.push({ line: split[n]!, from: starts[n]!, index: n, is });
  for (let n = 0; n < split.length; n++) {
    const line = split[n]!;
    const call = aloneCall(line, starts[n]!, kindOf);
    const content = call && kindOf(call.name);
    if (call && content) {
      push(n, "prose");
      const open = n + 1 < split.length ? opening(split[n + 1]!) : null;
      const close = open ? closing(n + 2, open.marker) : -1;
      if (!open || close < 0) {
        // Its line is all of it, spaces after it and all, so what is drawn in its place is whole lines.
        const to = starts[n]! + line.length;
        blocks.push({ ...call, body: "", content, fence: null, bodyFrom: to, to });
        continue;
      }
      const fence: Fence = {
        ...open,
        open: { from: starts[n + 1]!, to: starts[n + 1]! + split[n + 1]!.length },
        close: { from: starts[close]!, to: starts[close]! + split[close]!.length },
      };
      const bodyFrom = fence.open.to + 1;
      blocks.push({ ...call, body: text.slice(bodyFrom, fence.close.from), content, fence, bodyFrom, to: fence.close.to });
      push(n + 1, "fence");
      for (let m = n + 2; m < close; m++) push(m, content);
      push(close, "fence");
      n = close;
      continue;
    }
    const open = opening(line);
    if (!open) {
      push(n, "prose");
      continue;
    }
    const close = closing(n + 1, open.marker);
    const last = close < 0 ? split.length - 1 : close;
    for (let m = n; m <= last; m++) push(m, "code");
    n = last;
  }
  return { lines, blocks };
}

/** The embeds that hold content in a note, outside code, whether or not they have any yet. */
export const blocksIn = (text: string, kindOf: KindOf = builtInKinds): Written[] => readNote(text, kindOf).blocks;

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

/** `was`, or where a line of `body` would close a fence written with it, one of backticks no line of it can close. */
export function markerFor(body: string, was = "```"): string {
  const lines = body.split("\n");
  if (!lines.some((line) => closes(line, was))) return was;
  const longest = Math.max(...lines.map((line) => /^ {0,3}(`*)/.exec(line)![1]!.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Content as a fence under an embed writes it, from the line break that ends the embed's line. */
export function fenced(kind: ContentKind, body: string): string {
  const lines = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  const marker = markerFor(lines);
  return `\n${marker}${kind}\n${lines}${marker}`;
}

/** How an embed is written, with its content in a fence under it where it holds some. */
export const writtenEmbed = (name: string, config = "", content?: { kind: ContentKind; body: string }) => `/${name}(${config})${content ? fenced(content.kind, content.body) : ""}`;

/**
 * The edits to a note that give the embed written at `written` a new config, a new body, or both.
 * It throws for a config that would stop the note reading as that embed, so an embed can't write
 * its way out of its own range. A body goes in the fence under the embed, which is written where
 * there is none, and is written with a longer marker where a line of the body would close it.
 */
export function rewriteOf(written: Written, next: { config?: string; body?: string }): Rewrite[] {
  const edits: Rewrite[] = [];
  if (next.config !== undefined) {
    if (!holdable(next.config)) throw new Error("An embed's config can't hold a line break, or a ) that nothing opens");
    edits.push(...replacing(written.config, next.config, written.configFrom));
  }
  if (next.body !== undefined) {
    if (!written.content) throw new Error("Only an embed that holds content has a body");
    const body = next.body === "" || next.body.endsWith("\n") ? next.body : `${next.body}\n`;
    const { fence } = written;
    if (!fence) {
      if (body) edits.push({ from: written.to, to: written.to, insert: fenced(written.content, body) });
    } else if (markerFor(body, fence.marker) === fence.marker) edits.push(...replacing(written.body, body, written.bodyFrom));
    else {
      const marker = markerFor(body, fence.marker);
      edits.push({ from: fence.open.from, to: fence.close.to, insert: `${marker}${fence.info}\n${body}${marker}` });
    }
  }
  return edits;
}

/** Whether two readings are of the same embed with the same config and body, wherever each is in the note. */
export const sameWritten = (a: Pick<Written, "name" | "config" | "body" | "content">, b: Pick<Written, "name" | "config" | "body" | "content">) =>
  a.name === b.name && a.config === b.config && a.body === b.body && a.content === b.content;
