import { defaultOf, numberRule, SWATCHES, valueOf, type DeclaredOption, type OptionValue } from "./embedOptions.ts";
import { blocksIn, inlineIn, type Written } from "./embedSyntax.ts";
import { linesOutsideCode } from "./lines.ts";
import { blanked, codeSpans } from "./spans.ts";

/**
 * What each embed's config takes, declared once: the settings panel draws a field from each key,
 * the editor and the MCP server say which words are wrong, and `note_syntax` tells agents the keys.
 * Each built-in schema mirrors what that embed's own parser reads and its own writer writes.
 */

/** A word matched by a pattern, for what only built-in embeds write: an upload's id, a size, a crop, an instant. */
export type WordKey = {
  type: "word";
  id: string;
  label: string;
  pattern: RegExp;
  rule: string;
  default: "";
  /** Set in the panel as a duration, in hours, minutes and seconds, as a timer's length, and not typed as a word. */
  input?: "duration";
};

/** One key of an embed's config. */
export type EmbedKey = (DeclaredOption | WordKey) & {
  /** Written as a bare word in its place among the bare words, as a timer's 5m or a picture's 640x480, not as key=value. */
  bare?: true;
  /** The embed can't be read without it. */
  required?: true;
  /** Never cleared from the panel, as an upload's id: a drawing's saved scene would be lost with it. */
  keep?: true;
  /** Written by the embed's own controls, as a timer's Start and Stop write when it runs: shown on the embed, not among its settings. */
  control?: true;
  /** Measured by the app, as a picture's size once it has loaded: never set by hand, so not among its settings. */
  inferred?: true;
};

export interface EmbedSchema {
  keys: readonly EmbedKey[];
  /** The bare words past the bare keys are one text of the embed's own, as a contact's label. */
  rest?: { id: string; label: string };
  /** Only key=value words with a key it names are checked; anything else is left alone. For a third-party embed's declared options, whose config the plugin also reads itself. */
  open?: true;
}

const DURATION_RULE = "Write it like 25m, 1h30m or 90s.";
const word = (id: string, label: string, pattern: RegExp, rule: string): WordKey => ({ type: "word", id, label, pattern, rule, default: "" });

/** A clock's run, as `writeClock` writes it and `readClock` reads it back. */
const since = { ...word("since", "Running since", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/, "An instant, like 2026-10-16T09:30:00.000Z."), control: true } as const;
const at = { ...word("at", "Stopped at", /^(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?$/, DURATION_RULE), control: true } as const;

const upload = { ...word("upload", "Upload", /^[a-z0-9]{12}$/, "An upload's id: 12 lowercase letters and digits."), bare: true, keep: true } as const;
const size = { ...word("size", "Size", /^(?!0+x)\d{1,5}x(?!0+$)\d{1,5}$/, "The room kept for it, like 640x480."), bare: true, inferred: true } as const;
const width = { ...word("width", "Width", /^(?:small|medium|large|full|(?!0{1,3}%)(?:0?\d{1,2}|100)%)$/, "small, medium, large or full, or a whole percent such as 42%."), bare: true } as const;
const crop = word("crop", "Crop", /^\d{1,5},\d{1,5},\d{1,5},\d{1,5}$/, "X,Y,WIDTH,HEIGHT in the pixels of its size, like 120,40,800,600.");

/** A contact's or an email's: the id `@` or refer_record wrote, then its label. */
const reference: EmbedSchema = { keys: [{ ...word("ref", "Reference", /^[a-z0-9]{12}$/, "A reference's id: 12 lowercase letters and digits."), bare: true, required: true }], rest: { id: "label", label: "Label" } };

const HTML_OPTIONS: readonly DeclaredOption[] = [{ type: "number", id: "height", label: "Height", min: 40, max: 2000, step: 1, default: 320 }];

export const EMBED_SCHEMAS: Readonly<Record<string, EmbedSchema>> = {
  timer: { keys: [{ ...word("length", "Length", /^(?=.*[1-9])(?:\d+h)?(?:\d+m)?(?:\d+s)?$/, DURATION_RULE), bare: true, required: true, input: "duration" as const }, since, at] },
  stopwatch: { keys: [since, at] },
  html: { keys: HTML_OPTIONS },
  kanban: { keys: [] },
  form: { keys: [] },
  contact: reference,
  email: reference,
  image: { keys: [{ ...upload, required: true }, size, width, crop] },
  video: { keys: [{ ...upload, required: true }, size, width] },
  // `::drawing{}` is one not drawn yet.
  drawing: { keys: [upload, size, width] },
  audio: { keys: [{ ...upload, required: true }] },
  file: { keys: [{ ...upload, required: true }] },
};

/** The keys a member sets in the settings panel, in order: all but those the embed's own controls write and those the app measures. */
export const settableKeys = (schema: EmbedSchema): EmbedKey[] => schema.keys.filter((key) => !key.control && !key.inferred);

/** Whether a key is set as a duration, in hours, minutes and seconds. */
export const isDuration = (key: EmbedKey) => key.type === "duration" || (key.type === "word" && key.input === "duration");

/** A built-in embed's schema, or the one a plugin's declared options make, whose other words are the plugin's own. */
export function schemaFor(name: string, declared?: readonly DeclaredOption[]): EmbedSchema | undefined {
  if (Object.hasOwn(EMBED_SCHEMAS, name)) return EMBED_SCHEMAS[name];
  return declared?.length ? { keys: declared, open: true } : undefined;
}

export interface Reading {
  /** Each key's text as the config writes it, its last word where there are several, and the rest under the rest's id. */
  values: Record<string, string>;
  written: ReadonlySet<string>;
  problems: Problem[];
}

/** Where a word is in its config. */
export interface At {
  from: number;
  to: number;
}

export type Problem =
  /** A key=value word with a key not in the schema, `word` as written. */
  | { kind: "unknown"; key: string; word: string; at: At; closest?: string }
  /** A value its key refuses, or a word written out of its place, `word` as written. */
  | { kind: "bad"; key: string; value: string; why: string; word: string; at: At }
  /** A required key not written. */
  | { kind: "missing"; key: string }
  /** A bare word no bare key or rest takes. */
  | { kind: "extra"; word: string; at: At };

/** One word of a config, where it is: `key=value`, `key="two words"`, or anything else. */
interface Word {
  key: string | null;
  value: string;
  raw: string;
  from: number;
  to: number;
}

const WORD = /([a-z][a-zA-Z0-9-]*)=(?:"([^"]*)"|(\S*))|\S+/g;

const wordsOf = (config: string): Word[] =>
  [...config.matchAll(WORD)].map((m) => ({ key: m[1] ?? null, value: m[1] ? (m[2] ?? m[3] ?? "") : m[0], raw: m[0], from: m.index, to: m.index + m[0].length }));

/** What a word of the config is to the schema. `other` is left alone. A key's word written where the embed's own reader doesn't look for it says so in `misplaced`. */
type Placed = { word: Word } & ({ is: "key"; key: EmbedKey; misplaced?: string } | { is: "rest" | "unknown" | "extra" | "other" });

/** Why `key` can't take `text`, or null where it can. */
function refusal(key: EmbedKey, text: string): string | null {
  if (key.type === "word") return key.pattern.test(text) ? null : key.rule;
  const read = valueOf(key, text);
  return "refused" in read ? read.refused : null;
}

/**
 * Each word's place. Bare words fill the bare keys in schema order: a word an optional key refuses
 * passes over it to the next, and a word a required key refuses is that key's, wrongly. In an embed
 * with a text of its own, a key=value word the schema doesn't name is only words of that text.
 */
function placedIn(schema: EmbedSchema, config: string): Placed[] {
  const bare = schema.keys.filter((k) => k.bare);
  let next = 0;
  let keyed = false;
  return wordsOf(config).map((word, n): Placed => {
    if (word.key !== null) {
      const key = schema.keys.find((k) => !k.bare && k.id === word.key);
      if (key || !(schema.open || schema.rest)) keyed = true;
      if (key) return { word, is: "key", key };
      if (schema.open) return { word, is: "other" };
      if (!schema.rest) return { word, is: "unknown" };
    }
    // The embeds' own readers take bare words by where they are: none after a key=value word, and the first only at the very start, as an upload's id.
    const misplaced = keyed ? "Write it before the key=value settings." : n === 0 && word.from > 0 ? "Write it first, with no space before it." : undefined;
    while (next < bare.length) {
      const key = bare[next++]!;
      if (key.required || !refusal(key, word.raw)) return { word, is: "key", key, ...(misplaced && { misplaced }) };
    }
    return { word, is: schema.rest ? "rest" : schema.open ? "other" : "extra" };
  });
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

/** The key=value key `key` was most likely meant to be: two edits away or less, or the start of one. */
function closestTo(schema: EmbedSchema, key: string): string | undefined {
  let best: { id: string; far: number } | undefined;
  for (const { id, bare } of schema.keys) {
    if (bare) continue;
    const far = key.length >= 2 && id.startsWith(key) ? 0 : distance(key, id);
    if (far <= 2 && (!best || far < best.far)) best = { id, far };
  }
  return best?.id;
}

/** What a config says against its schema: each key's text, which keys it writes, and what is wrong with it. */
export function readConfig(schema: EmbedSchema, config: string): Reading {
  const values: Record<string, string> = {};
  const written = new Set<string>();
  const problems: Problem[] = [];
  const rest: Word[] = [];
  for (const placed of placedIn(schema, config)) {
    const { word } = placed;
    const at = { from: word.from, to: word.to };
    if (placed.is === "key") {
      const { key } = placed;
      const value = key.bare ? word.raw : word.value;
      values[key.id] = value;
      written.add(key.id);
      const why = refusal(key, value) ?? placed.misplaced;
      if (why) problems.push({ kind: "bad", key: key.id, value, why, word: word.raw, at });
    } else if (placed.is === "rest") rest.push(word);
    else if (placed.is === "unknown") {
      const closest = closestTo(schema, word.key!);
      problems.push({ kind: "unknown", key: word.key!, word: word.raw, at, ...(closest && { closest }) });
    } else if (placed.is === "extra") problems.push({ kind: "extra", word: word.raw, at });
  }
  if (schema.rest && rest.length) {
    values[schema.rest.id] = config.slice(rest[0]!.from, rest.at(-1)!.to);
    written.add(schema.rest.id);
  }
  for (const key of schema.keys) if (key.required && !written.has(key.id)) problems.push({ kind: "missing", key: key.id });
  return { values, written, problems };
}

const labelOf = (schema: EmbedSchema, id: string) => schema.keys.find((k) => k.id === id)?.label ?? (schema.rest?.id === id ? schema.rest.label : id);

/** A problem as a member or an agent is told it. */
export function problemText(schema: EmbedSchema, problem: Problem): string {
  switch (problem.kind) {
    case "unknown": {
      const bare = schema.keys.find((k) => k.bare && k.id === problem.key);
      if (bare) return `${bare.id} is written as its value alone, not as ${bare.id}=. ${ruleOf(bare)}`;
      return `Unknown key ${problem.key}.${problem.closest ? ` Did you mean ${problem.closest}?` : ""}`;
    }
    case "bad":
      return `${labelOf(schema, problem.key)}: ${problem.why}`;
    case "missing": {
      const key = schema.keys.find((k) => k.id === problem.key);
      return `${labelOf(schema, problem.key)} is needed.${key ? ` ${ruleOf(key)}` : ""}`;
    }
    case "extra":
      return `"${problem.word}" isn't anything this embed takes.`;
  }
}

/** What a key takes, in words. */
export function ruleOf(key: EmbedKey): string {
  switch (key.type) {
    case "word":
      return key.rule;
    case "number":
      return numberRule(key);
    case "toggle":
      return "On or off.";
    case "choice":
      return `One of ${key.values.join(", ")}.`;
    case "colour":
      return `One of ${SWATCHES.join(", ")}, or none.`;
    case "duration":
      return DURATION_RULE;
    case "date":
      return "A day written like 2026-10-16.";
    case "text":
      return "Words, with no quotes or braces.";
  }
}

/** The config with each of `words` taken out, and the space before it, or after it at the start. */
function without(config: string, words: readonly { from: number; to: number }[]): string {
  let out = config;
  for (const { from, to } of [...words].sort((a, b) => b.from - a.from)) {
    let [start, end] = [from, to];
    while (start > 0 && /\s/.test(out[start - 1]!)) start--;
    if (start === 0) while (end < out.length && /\s/.test(out[end]!)) end++;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** `text` put into the config at `at`, with a space between it and any word beside it. */
function inserted(config: string, at: number, text: string): string {
  const before = at > 0 && !/\s/.test(config[at - 1]!) ? " " : "";
  const after = at < config.length && !/\s/.test(config[at]!) ? " " : "";
  return config.slice(0, at) + before + text + after + config.slice(at);
}

/** How a key=value word is written: bare where it is one word of plain characters, quoted otherwise. A word key's pattern only takes plain words. */
const keyWord = (key: EmbedKey, value: string) => (key.type === "word" || /^[\w.:/+-]+$/.test(value) ? `${key.id}=${value}` : `${key.id}="${value}"`);

/** Where a bare key that isn't written goes: after the bare words of the keys before it, or at the start. */
function bareSpot(schema: EmbedSchema, placed: readonly Placed[], before: number): number {
  const order = schema.keys.filter((k) => k.bare);
  const earlier = placed.filter((p) => p.is === "key" && p.key.bare && order.indexOf(p.key) < before).at(-1);
  return earlier ? earlier.word.to : 0;
}

/**
 * The config with key `id` set to what `text` says, or why it can't be. A key=value key's words are
 * taken out and one is written at the end, unless the value is the key's default, so a config says
 * only what differs. A bare key's word is replaced where it is, or put after the bare words before
 * it, as it is when it was written out of its place. The rest is replaced where it is, or put after
 * the bare words. Every other word stays where it was, byte for byte. Nothing typed takes a key out,
 * as `clearKey` does.
 */
export function setKey(schema: EmbedSchema, config: string, id: string, text: string): { config: string } | string {
  const t = text.trim();
  const key = schema.keys.find((k) => k.id === id);
  const placed = placedIn(schema, config);
  if (!key) {
    if (schema.rest?.id !== id) return `No setting ${id}.`;
    if (!t) return clearKey(schema, config, id);
    if (/[{}\r\n]/.test(t)) return "Braces and line breaks can't be in it.";
    const rest = placed.filter((p) => p.is === "rest");
    if (rest.length) return { config: config.slice(0, rest[0]!.word.from) + t + config.slice(rest.at(-1)!.word.to) };
    return { config: inserted(config, bareSpot(schema, placed, Infinity), t) };
  }
  if (!t && (key.type === "word" || key.type === "number" || key.type === "duration")) return clearKey(schema, config, id);
  const read = key.type === "word" ? (key.pattern.test(t) ? { value: t, words: t } : { refused: key.rule }) : valueOf(key, t);
  if ("refused" in read) return read.refused;
  if (key.bare) {
    const was = placed.find((p) => p.is === "key" && p.key === key);
    let next: string;
    if (was?.is === "key" && !was.misplaced) next = config.slice(0, was.word.from) + read.words + config.slice(was.word.to);
    else {
      const left = was ? without(config, [was.word]) : config;
      next = inserted(left, bareSpot(schema, placedIn(schema, left), schema.keys.filter((k) => k.bare).indexOf(key)), read.words);
    }
    // A word another bare key would take where it was put is refused, so it never turns into that key.
    return readConfig(schema, next).values[id] === read.words ? { config: next } : `${key.label} can't be written there.`;
  }
  const kept = without(config, placed.filter((p) => p.is === "key" && p.key === key).map((p) => p.word));
  const fallback = key.type === "word" ? "" : defaultOf(key);
  if (read.value === fallback) return { config: kept };
  return { config: inserted(kept, kept.length, keyWord(key, read.words)) };
}

/** The config without the word `raw` written at `at`, and the space before it. Every other word stays where it was. A config that has changed under it is left as it is. */
export function removeWord(config: string, raw: string, at: At): string {
  return config.slice(at.from, at.to) === raw ? without(config, [at]) : config;
}

/**
 * The config with each key=value word whose key is `from` given the key `to` instead, keeping its
 * value, or why it can't be. Every other byte stays as it was.
 */
export function renameKey(schema: EmbedSchema, config: string, from: string, to: string): { config: string } | string {
  if (!schema.keys.some((k) => !k.bare && k.id === to)) return `No setting ${to}.`;
  const words = wordsOf(config).filter((w) => w.key === from);
  if (!words.length) return `No key ${from} is written.`;
  let out = config;
  for (const { from: at } of [...words].reverse()) out = out.slice(0, at) + to + out.slice(at + from.length);
  return { config: out };
}

/** A word in a config that no key of its schema takes: a row of its own in the settings panel, to be removed, or renamed to the key it was likely meant to be. */
export interface Stray {
  word: string;
  at: At;
  text: string;
  /** The key=value key it is written with, and the key it was likely meant to be. */
  rename?: { from: string; to: string };
}

/** Where the settings panel shows each problem of a config: under the field of its key, as a row of its own, or, for the rest, above the fields. */
export interface Placing {
  /** What is wrong with each key a member sets, under its field. */
  byKey: Record<string, string>;
  strays: Stray[];
  /** What has no field or row of its own, as a needed key the panel has no field for. */
  rest: string[];
}

/** Each problem of `reading` where the settings panel shows it. */
export function placeProblems(schema: EmbedSchema, reading: Reading): Placing {
  const settable = new Set(settableKeys(schema).map((k) => k.id));
  const byKey: Record<string, string> = {};
  const strays: Stray[] = [];
  const rest: string[] = [];
  for (const problem of reading.problems) {
    if ((problem.kind === "bad" || problem.kind === "missing") && settable.has(problem.key)) {
      const said = problem.kind === "bad" ? problem.why : "Needed.";
      byKey[problem.key] = byKey[problem.key] ? `${byKey[problem.key]} ${said}` : said;
    } else if (problem.kind === "unknown") {
      const named = schema.keys.some((k) => k.bare && k.id === problem.key);
      strays.push({ word: problem.word, at: problem.at, text: named ? problemText(schema, problem) : `Unknown key ${problem.key}`, ...(problem.closest && { rename: { from: problem.key, to: problem.closest } }) });
    } else if (problem.kind === "extra") strays.push({ word: problem.word, at: problem.at, text: `Unknown word "${problem.word}"` });
    // A key with no field, as what a timer's Start and Stop write or a picture's size, is taken out where it is wrong.
    else if (problem.kind === "bad") strays.push({ word: problem.word, at: problem.at, text: problemText(schema, problem) });
    else rest.push(problemText(schema, problem));
  }
  return { byKey, strays, rest };
}

/** The config without key `id`, or why it can't be without it. Every other word stays where it was. */
export function clearKey(schema: EmbedSchema, config: string, id: string): { config: string } | string {
  const key = schema.keys.find((k) => k.id === id);
  if (!key && schema.rest?.id !== id) return `No setting ${id}.`;
  if (key?.required) return `${key.label} is needed.`;
  if (key?.keep) return `${key.label} can't be cleared.`;
  const placed = placedIn(schema, config);
  if (!key) {
    const rest = placed.filter((p) => p.is === "rest");
    return { config: rest.length ? without(config, [{ from: rest[0]!.word.from, to: rest.at(-1)!.word.to }]) : config };
  }
  return { config: without(config, placed.filter((p) => p.is === "key" && p.key === key).map((p) => p.word)) };
}

/** A number written past either end of its option's range, as by hand, is read as that end. Only a value typed in the field is refused for it. */
function withinRange(option: Extract<DeclaredOption, { type: "number" }>, text: string): string {
  const n = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) return text;
  return String(Math.min(Math.max(n, option.min ?? -Infinity), option.max ?? Infinity));
}

/** Each key's value as a plugin reads it: what the config says, or the default where it says nothing or what it says can't be taken. */
export function optionValues(keys: readonly EmbedKey[], config: string): Record<string, OptionValue> {
  const { values } = readConfig({ keys, open: true }, config);
  return Object.fromEntries(
    keys.map((key) => {
      const text = values[key.id];
      if (key.type === "word") return [key.id, text !== undefined && key.pattern.test(text) ? text : ""];
      const read = text === undefined ? null : valueOf(key, key.type === "number" ? withinRange(key, text) : text);
      return [key.id, read && "value" in read ? read.value : defaultOf(key)];
    }),
  );
}

/** What `note_syntax` says an embed's config takes, made from its schema so the two can't differ. */
export function keysText(schema: EmbedSchema): string {
  if (!schema.keys.length && !schema.rest) return "Keys: none. Any word in its config is a mistake.";
  const lines = schema.keys.map((key) => `- ${key.bare ? `${key.id}, written as its value alone` : `${key.id}=VALUE`}${key.required ? ", needed" : ""}${key.control ? ", written by its own controls: leave it out" : ""}. ${ruleOf(key)}`);
  if (schema.rest) lines.push(`- then the ${schema.rest.label.toLowerCase()}: the rest of the words.`);
  const head = schema.keys.some((k) => k.bare) ? "Keys, those written as a value alone first and in this order:" : "Keys:";
  return `${head}\n${lines.join("\n")}${schema.open || schema.rest ? "" : "\nAny other word is a mistake."}`;
}

/** What is wrong with one built-in embed a note writes, and where. */
export interface EmbedProblems {
  /** Its line in the note, from 1. */
  line: number;
  /** The embed as written: an inline one whole, a block's opening line. */
  written: string;
  problems: string[];
}

/** What is wrong with each built-in embed a note writes outside code, in the note's order. A plugin's embed is the plugin's to read. */
export function embedProblemsIn(text: string): EmbedProblems[] {
  if (!text.includes("::")) return [];
  const blocks = blocksIn(text);
  // A block's body is the block's own: an embed in it is the block's to read, and a fence in it is no fence of the note's.
  let outside = text;
  for (const b of blocks) outside = outside.slice(0, b.bodyFrom) + b.body.replace(/[^\n]/g, " ") + outside.slice(b.bodyFrom + b.body.length);
  const found: Written[] = [...blocks];
  for (const { line, from } of linesOutsideCode(outside)) {
    if (line.includes("::")) found.push(...inlineIn(blanked(line, codeSpans(line), " "), from));
  }
  return found
    .filter((w) => Object.hasOwn(EMBED_SCHEMAS, w.name))
    .sort((a, b) => a.from - b.from)
    .flatMap((w) => {
      const schema = EMBED_SCHEMAS[w.name]!;
      const problems = readConfig(schema, w.config).problems.map((p) => problemText(schema, p));
      const written = w.block ? text.slice(w.from, w.bodyFrom).trimEnd() : text.slice(w.from, w.to);
      return problems.length ? [{ line: text.slice(0, w.from).split("\n").length, written, problems }] : [];
    });
}
