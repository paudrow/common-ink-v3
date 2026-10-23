import { FILE_CLASSES, KNOWN_TYPES, TEXT_ENDINGS, typesOf, type FileClass } from "./filetypes.ts";
import { RULE_GRAMMAR } from "./recurrence.ts";
import { asc, desc, type Order } from "./order.ts";
import { STATES_WRITTEN, TODO_STATES, isDay, markOf, nameKey, type TodoState } from "./todos.ts";

/**
 * The query language notes, todos and uploads are found by: words, "phrases", `key:value` filters,
 * `-` and `NOT`, `OR`, and parentheses, as GitHub's search writes them. This module is the whole of it and
 * touches nothing: text to a tree and back, and a tree to a condition in SQL. {@link FILTERS} is the
 * one place a filter is said. The parser, the printer, the builder, the help, the tools'
 * descriptions and `docs/search.md` are all read from it.
 */

export type Scope = "notes" | "todos" | "uploads";
export const SCOPES: readonly Scope[] = ["notes", "todos", "uploads"];
export type Cmp = "=" | ">" | ">=" | "<" | "<=";

export const MAX_SEARCH_LENGTH = 200;
export const MAX_DEPTH = 8;
export const MAX_TERMS = 40;
/** How many values D1 lets one statement bind. */
export const MAX_BOUND = 100;

/** What a filter's value is, which says how it is checked, completed and picked. */
export type ValueKind =
  | { type: "words"; words: readonly Word[] }
  | { type: "day" }
  /** Words in order from the lowest, each standing for its place: a todo's priority is `none` (0) to `high` (3). Its place is taken too. */
  | { type: "level"; levels: readonly string[] }
  | { type: "folder" }
  | { type: "tag" }
  | { type: "person" }
  | { type: "mentioned" }
  /** Some of a name, to be found anywhere in it. */
  | { type: "contains" }
  /** A number of bytes, or of kb, mb or gb. */
  | { type: "size" };

/** One of the words a filter such as `is:` takes. The same word can mean one thing of a note and another of a todo. */
export interface Word {
  word: string;
  aliases?: readonly string[];
  scopes: readonly Scope[];
  means: string;
  /** The condition, for a filter. */
  sql?: (c: Compiling, given: Given) => string;
  /** The order, for `sort:`. */
  order?: Order;
  /** The field it is offered under where it is not its filter's own, as Shared and Private are under Visibility and not State. */
  field?: "visibility";
}

/** A filter as it is handed to SQL: its names looked up, and its days the days they stand for. */
export interface Given {
  cmp: Cmp;
  value: string;
  to?: string;
  /** What a folder's or a person's name was found to be, who a mention of someone is matched by, or for `is:shared` the notes it is true of. */
  ids?: readonly string[];
}

/** What a condition is written with. Every value goes through `bind`, which answers its placeholder. */
export interface Compiling {
  scope: Scope;
  workspaceId: string;
  in: readonly In[];
  bind(value: string | number): string;
  /** True for the notes row `alias` when the asker can see it. */
  seen(alias: string): string;
  /** When a day begins and ends where the asker is, in milliseconds. */
  dayStart(day: string): number;
  dayEnd(day: string): number;
}

interface Spec {
  scopes: readonly Scope[];
  aliases: readonly string[];
  value: ValueKind;
  /** Whether it takes `>`, `>=`, `<`, `<=` and a range `a..b`. */
  compares: boolean;
  /** Set for what says how the whole query is read, and is no condition: it is written once, outside any group. */
  top?: true;
  means: string;
  example: string;
  /** What stands for the value where the filter is described, such as NAME. */
  shown: string;
  sql?: (c: Compiling, given: Given) => string;
}

const BOTH = ["notes", "todos"] as const;
const NOTES = ["notes"] as const;
const TODOS = ["todos"] as const;
const UPLOADS = ["uploads"] as const;
const ALL = SCOPES;
/** A note's title as the app shows it, so one with none is ordered as "Untitled". */
const SHOWN_TITLE = "CASE WHEN n.title = '' THEN 'Untitled' ELSE n.title END COLLATE NOCASE";
const KEPT = ["notes", "uploads"] as const;

/** A todo's priorities, from the lowest, as a query writes them. */
export const PRIORITIES = ["none", "low", "medium", "high"] as const;

/** The row a condition is of: the upload `u`, or the note `n`, which a todo is in. */
const item = (c: Compiling) => (c.scope === "uploads" ? "u" : "n");

/** The tags `g` of what a condition is of, as a FROM and a WHERE to go on with: a note's, or a todo's own and those that cover it (`tagScope.ts`). */
const TAGS_OF = (c: Compiling) => (c.scope === "todos" ? "todo_tags g WHERE g.note_id = t.note_id AND g.line = t.line" : "note_tags g WHERE g.note_id = n.id");

const among = (c: Compiling, given: Given) => `(SELECT value FROM json_each(${c.bind(JSON.stringify(given.ids ?? []))}))`;

/** A time compared with days: a day is all of it, from its first moment to the last. */
const timeIs = (column: string) => (c: Compiling, { cmp, value, to }: Given) => {
  const from = () => c.bind(c.dayStart(value));
  const until = (day: string) => c.bind(c.dayEnd(day));
  if (cmp === "=") return `(${column} >= ${from()} AND ${column} < ${until(to ?? value)})`;
  if (cmp === ">") return `${column} >= ${until(value)}`;
  if (cmp === ">=") return `${column} >= ${from()}`;
  if (cmp === "<") return `${column} < ${from()}`;
  return `${column} < ${until(value)}`;
};

const valueIs = (column: string, read: (value: string) => string | number) => (c: Compiling, { cmp, value, to }: Given) =>
  to === undefined ? `${column} ${cmp} ${c.bind(read(value))}` : `(${column} >= ${c.bind(read(value))} AND ${column} <= ${c.bind(read(to))})`;

/** Bytes as a query writes them: a number, and kb, mb or gb after it for so many of those. */
const SIZE = /^(\d{1,15}(?:\.\d{1,3})?)(b|kb|mb|gb)?$/;
const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const;
export const bytesOf = (written: string): number => {
  const [, number, unit] = SIZE.exec(written)!;
  return Math.round(Number(number) * UNITS[(unit ?? "b") as keyof typeof UNITS]);
};

/** A note of the upload's own workspace that the asker can see and that shows the upload. */
const USED = (c: Compiling) => `SELECT 1 FROM upload_refs r CROSS JOIN notes rn ON rn.id = r.note_id WHERE r.upload_id = u.id AND rn.workspace_id = u.workspace_id AND ${c.seen("rn")}`;

/** A name's part as LIKE finds it anywhere in the name, with what LIKE reads as more than a character read as itself. */
const containing = (c: Compiling, part: string) => `u.name LIKE ${c.bind(`%${part.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)} ESCAPE '\\'`;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const TEXT = `(${TEXT_ENDINGS.map((ending) => `u.name LIKE '%.${ending}'`).join(" OR ")})`;
/** An upload of a class of file, by its type, and for text by its name's ending, as `fileClass` says. Every value is the table's own, never typed. */
function classIs(cls: FileClass): string {
  const typed = typesOf(cls);
  const untyped = `u.type NOT IN (${quoted(KNOWN_TYPES)})`;
  if (cls === "text") return `(${untyped} AND ${TEXT})`;
  if (cls === "other") return `(${typed.length ? `u.type IN (${quoted(typed)}) OR ` : ""}(${untyped} AND NOT ${TEXT}))`;
  return `u.type IN (${quoted(typed)})`;
}
const CLASS_MEANS: Record<FileClass, string> = {
  image: "A picture",
  video: "A video",
  audio: "Sound",
  pdf: "A PDF",
  text: `Text to read, by its name's ending: ${TEXT_ENDINGS.join(", ")}`,
  other: "Any other file",
};

/** Each of `ids` names an author as `kind:id`. */
const changedBy = (first: boolean) => (c: Compiling, given: Given) =>
  `EXISTS (SELECT 1 FROM json_each(${c.bind(JSON.stringify(given.ids ?? []))}) j JOIN changes c ON c.note_id = n.id AND c.author_kind = substr(j.value, 1, instr(j.value, ':') - 1) AND c.author_id = substr(j.value, instr(j.value, ':') + 1)${first ? " WHERE c.revision = 1" : ""})`;

/** What `is:` says of a todo in each state, after the box it is written with. */
const STATE_MEANS: Record<TodoState, string> = {
  open: "open. A query that names no state lists only open todos",
  done: "done. With is:open OR is:done, both",
  abandoned: "abandoned, which won't be done",
  backlog: "in the backlog, put off for some day",
};

export const FILTERS = {
  folder: {
    scopes: ALL,
    aliases: [],
    value: { type: "folder" },
    compares: false,
    means: "In a folder, named or by its id, or in a folder inside it",
    example: "folder:Unsorted",
    shown: "NAME",
    sql: (c, given) => `${item(c)}.folder_id IN ${among(c, given)}`,
  },
  tag: {
    scopes: BOTH,
    aliases: [],
    value: { type: "tag" },
    compares: false,
    means: "Tagged with it or a tag inside it, as #NAME/sub. #NAME is short for it. A note has every tag written in it. A todo has the ones on its line, a heading's over it, a line of tags' above it in its section, and a list item's it is nested in",
    example: "tag:money",
    shown: "NAME",
    // By `substr`, since `_` is a tag's letter and LIKE's wildcard.
    sql: (c, given) => {
      const key = nameKey(given.value);
      return `EXISTS (SELECT 1 FROM ${TAGS_OF(c)} AND (g.tag = ${c.bind(key)} OR substr(g.tag, 1, length(${c.bind(key)}) + 1) = ${c.bind(`${key}/`)}))`;
    },
  },
  updated: {
    scopes: BOTH,
    aliases: [],
    value: { type: "day" },
    compares: true,
    means: "The day the note was last changed",
    example: "updated:>=2026-10-01",
    shown: "DAY",
    sql: timeIs("n.updated_at"),
  },
  created: {
    scopes: BOTH,
    aliases: [],
    value: { type: "day" },
    compares: true,
    means: "The day the note was made",
    example: "created:2026-10-01..2026-10-14",
    shown: "DAY",
    sql: timeIs("n.created_at"),
  },
  editor: {
    scopes: BOTH,
    aliases: ["edited-by"],
    value: { type: "person" },
    compares: false,
    means: "Changed by a member or an agent, by name. @me is you",
    example: "editor:@me",
    shown: "NAME",
    sql: changedBy(false),
  },
  author: {
    scopes: BOTH,
    aliases: [],
    value: { type: "person" },
    compares: false,
    means: "First written by a member or an agent, by name. @me is you",
    example: "author:@me",
    shown: "NAME",
    sql: changedBy(true),
  },
  mentions: {
    scopes: NOTES,
    aliases: ["mention"],
    value: { type: "mentioned" },
    compares: false,
    means: "Mentions a person, by name or id. @me is you",
    example: 'mentions:"Grace Hopper"',
    shown: "NAME",
    sql: (c, given) => `EXISTS (SELECT 1 FROM mentions a WHERE a.note_id = n.id AND a.who IN ${among(c, given)})`,
  },
  assignee: {
    scopes: TODOS,
    aliases: ["assigned"],
    value: { type: "mentioned" },
    compares: false,
    means: "Assigned to a person: mentioned on the todo's line, by name or id. @me is you",
    example: "assignee:@me",
    shown: "NAME",
    sql: (c, given) => `EXISTS (SELECT 1 FROM mentions a WHERE a.note_id = t.note_id AND a.line = t.line AND a.who IN ${among(c, given)})`,
  },
  name: {
    scopes: UPLOADS,
    aliases: [],
    value: { type: "contains" },
    compares: false,
    means: "The file's name has this in it, ignoring case",
    example: "name:report",
    shown: "TEXT",
    sql: (c, given) => containing(c, given.value),
  },
  type: {
    scopes: UPLOADS,
    aliases: ["kind"],
    value: { type: "words", words: FILE_CLASSES.map((cls): Word => ({ word: cls, scopes: UPLOADS, means: CLASS_MEANS[cls], sql: () => classIs(cls) })) },
    compares: false,
    means: "What kind of file it is",
    example: "type:image",
    shown: "WORD",
  },
  uploader: {
    scopes: UPLOADS,
    aliases: ["uploaded-by"],
    value: { type: "person" },
    compares: false,
    means: "Uploaded by a member or an agent, by name. @me is you",
    example: "uploader:@me",
    shown: "NAME",
    sql: (c, given) => `u.uploaded_by_kind || ':' || u.uploaded_by IN ${among(c, given)}`,
  },
  used: {
    scopes: UPLOADS,
    aliases: [],
    value: {
      type: "words",
      words: [
        { word: "yes", scopes: UPLOADS, means: "A note you can see shows it", sql: (c) => `EXISTS (${USED(c)})` },
        { word: "no", scopes: UPLOADS, means: "No note you can see shows it", sql: (c) => `NOT EXISTS (${USED(c)})` },
      ],
    },
    compares: false,
    means: "Whether a note shows it",
    example: "used:no",
    shown: "WORD",
  },
  size: {
    scopes: UPLOADS,
    aliases: [],
    value: { type: "size" },
    compares: true,
    means: "How big the file is: bytes, or kb, mb or gb",
    example: "size:>1mb",
    shown: "SIZE",
    sql: valueIs("u.size", bytesOf),
  },
  uploaded: {
    scopes: UPLOADS,
    aliases: [],
    value: { type: "day" },
    compares: true,
    means: "The day the file was uploaded",
    example: "uploaded:>=2026-10-01",
    shown: "DAY",
    sql: timeIs("u.created_at"),
  },
  is: {
    scopes: ALL,
    aliases: [],
    value: {
      type: "words",
      words: [
        { word: "open", scopes: KEPT, means: "Not archived and not in Trash", sql: (c) => `${item(c)}.state = 'live'` },
        ...TODO_STATES.map((state) => ({ word: state, scopes: TODOS, means: `A box written [${markOf(state)}]: ${STATE_MEANS[state]}`, sql: () => `t.state = '${state}'` })),
        { word: "archived", scopes: BOTH, means: "Archived. A query that doesn't say so leaves archived notes out", sql: () => "n.state = 'archived'" },
        { word: "archived", scopes: UPLOADS, means: "Archived. A query that doesn't say so leaves archived uploads out", sql: () => "u.state = 'archived'" },
        { word: "trashed", scopes: ALL, means: "In Trash. A query that doesn't say so leaves Trash out", sql: (c) => `${item(c)}.state = 'trashed'` },
        { word: "shared", scopes: ALL, field: "visibility", means: "Shared by itself with a person or by a link, where you may see how it is shared", sql: (c, given) => `${item(c)}.id IN ${among(c, given)}` },
        { word: "private", scopes: ALL, field: "visibility", means: "Private to one member", sql: (c) => `${item(c)}.private_owner IS NOT NULL` },
      ],
    },
    compares: false,
    means: "What state it is in",
    example: "is:archived",
    shown: "WORD",
  },
  has: {
    scopes: BOTH,
    aliases: [],
    value: {
      type: "words",
      words: [
        { word: "todo", aliases: ["task"], scopes: NOTES, means: "Has a todo, in any state", sql: () => "EXISTS (SELECT 1 FROM todos d WHERE d.note_id = n.id)" },
        { word: "open-todo", aliases: ["open-task"], scopes: NOTES, means: "Has an open todo", sql: () => "n.open_todos > 0" },
        { word: "link", scopes: BOTH, means: "Links to another note", sql: () => "EXISTS (SELECT 1 FROM links l WHERE l.source_id = n.id)" },
        { word: "backlink", scopes: BOTH, means: "Linked to from a note you can see", sql: (c) => `EXISTS (SELECT 1 FROM links l JOIN notes b ON b.id = l.source_id WHERE (l.target_id = n.id OR l.target_id IN (SELECT 'day:' || d.day FROM daily_notes d WHERE d.note_id = n.id)) AND b.id <> n.id AND ${c.seen("b")})` },
        { word: "tag", scopes: BOTH, means: "Has any tag", sql: (c) => `EXISTS (SELECT 1 FROM ${TAGS_OF(c)})` },
        { word: "attachment", scopes: NOTES, means: "Shows an upload: a picture, a video, sound or a file", sql: () => "EXISTS (SELECT 1 FROM upload_refs r WHERE r.note_id = n.id)" },
        { word: "due", scopes: TODOS, means: "Has a due date", sql: () => "t.due IS NOT NULL" },
        { word: "repeat", aliases: ["recurrence"], scopes: TODOS, means: "Repeats", sql: () => "t.recurs = 1" },
      ],
    },
    compares: false,
    means: "What it has. no:WORD is what it lacks, the same as -has:WORD",
    example: "has:link",
    shown: "WORD",
  },
  due: {
    scopes: TODOS,
    aliases: [],
    value: { type: "day" },
    compares: true,
    means: "The day a todo is due. Overdue is due:<today",
    example: "due:<today",
    shown: "DAY",
    sql: valueIs("t.due", (day) => day),
  },
  priority: {
    scopes: TODOS,
    aliases: ["importance"],
    value: { type: "level", levels: PRIORITIES },
    compares: true,
    means: "A todo's priority: high, medium, low or none, written !!!, !!, ! or nothing. 3 to 0 read the same",
    example: "priority:>=medium",
    shown: "LEVEL",
    sql: valueIs("t.importance", (level) => (PRIORITIES as readonly string[]).indexOf(level)),
  },
  in: {
    scopes: BOTH,
    aliases: [],
    value: {
      type: "words",
      words: [
        { word: "title", scopes: BOTH, means: "Every word of the query is looked for in the note's title" },
        { word: "body", scopes: BOTH, means: "Every word is looked for in the note's text, or for a todo in its line" },
      ],
    },
    compares: false,
    top: true,
    means: "Where the words are looked for",
    example: "budget in:title",
    shown: "WORD",
  },
  sort: {
    scopes: ALL,
    aliases: [],
    value: {
      type: "words",
      words: [
        { word: "updated-desc", scopes: BOTH, means: "Latest changed first", order: [desc("n.updated_at")] },
        { word: "updated-asc", scopes: BOTH, means: "Longest unchanged first", order: [asc("n.updated_at")] },
        { word: "created-desc", scopes: BOTH, means: "Newest first", order: [desc("n.created_at")] },
        { word: "created-asc", scopes: BOTH, means: "Oldest first", order: [asc("n.created_at")] },
        { word: "title-asc", scopes: BOTH, means: "By the note's title, A to Z", order: [asc(SHOWN_TITLE)] },
        { word: "title-desc", scopes: BOTH, means: "By the note's title, Z to A", order: [desc(SHOWN_TITLE)] },
        { word: "due-asc", scopes: TODOS, means: "Soonest due first, and those with no due date last", order: [asc("t.due IS NULL"), asc("t.due")] },
        { word: "due-desc", scopes: TODOS, means: "Latest due first, and those with no due date last", order: [asc("t.due IS NULL"), desc("t.due")] },
        { word: "priority-desc", aliases: ["importance-desc"], scopes: TODOS, means: "Highest priority first", order: [desc("t.importance")] },
        { word: "text-asc", scopes: TODOS, means: "By the todo's words, A to Z", order: [asc("t.words COLLATE NOCASE")] },
        { word: "uploaded-desc", scopes: UPLOADS, means: "Latest uploaded first", order: [desc("u.created_at")] },
        { word: "uploaded-asc", scopes: UPLOADS, means: "Earliest uploaded first", order: [asc("u.created_at")] },
        { word: "name-asc", scopes: UPLOADS, means: "By the file's name, A to Z", order: [asc("u.name COLLATE NOCASE")] },
        { word: "size-desc", scopes: UPLOADS, means: "Largest first", order: [desc("u.size")] },
      ],
    },
    compares: false,
    top: true,
    means: "The order of the answer",
    example: "sort:updated-desc",
    shown: "WORD",
  },
} as const satisfies Record<string, Spec>;

export type Key = keyof typeof FILTERS;
export type In = "title" | "body";
export type SortKey = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title-asc" | "title-desc" | "due-asc" | "due-desc" | "priority-desc" | "text-asc" | "uploaded-desc" | "uploaded-asc" | "name-asc" | "size-desc";
export type FilterKey = Exclude<Key, "in" | "sort">;

export type Filter = { kind: "filter"; key: FilterKey; cmp: Cmp; value: string; to?: string };
export type Text = { kind: "text"; words: string[]; phrase: boolean };
export type Node = { kind: "and" | "or"; of: Node[] } | { kind: "not"; of: Node } | Text | Filter;

export interface Query {
  where: Node | null;
  in: In[];
  sort: SortKey | null;
}

export interface QueryError {
  message: string;
  from: number;
  to: number;
}

export type Parsed = { ok: true; query: Query } | { ok: false; error: QueryError };

export const EMPTY: Query = { where: null, in: [], sort: null };

const spec = (key: Key): Spec => FILTERS[key];
export const KEYS = Object.keys(FILTERS) as Key[];
/** Every way a key is written, with the key it is. */
const NAMED = new Map<string, Key>(KEYS.flatMap((key) => [key, ...spec(key).aliases].map((name): [string, Key] => [name, key])));
/** `no:word` is `-has:word`. */
const LACKS = "no";

/** The filter a name is of, as it is written before the colon: the filter's own name, another name for it, or `no`. */
export const keyNamed = (name: string): Key | null => (name === LACKS ? "has" : (NAMED.get(name) ?? null));
export const keysFor = (scope: Scope): Key[] => KEYS.filter((key) => spec(key).scopes.includes(scope));
export const wordsFor = (key: Key, scope: Scope): Word[] => {
  const { value } = spec(key);
  return value.type === "words" ? value.words.filter((w) => w.scopes.includes(scope)) : [];
};
const wordOf = (key: Key, scope: Scope, written: string) => wordsFor(key, scope).find((w) => w.word === written || w.aliases?.includes(written));

/**
 * What a builder offers as one field and the help lists under one heading: a filter, or Visibility,
 * which is the words of `is:` that say who can see a note. Those say no state it is in.
 */
export type Field = Key | "visibility";
const FIELDS: Partial<Record<Field, { name: string; means?: string }>> = {
  is: { name: "State" },
  visibility: { name: "Visibility", means: "Who can see it: shared, or private to one member" },
  has: { name: "Has" },
  in: { name: "Words in" },
};
export const fieldName = (field: Field) => FIELDS[field]?.name ?? field[0]!.toUpperCase() + field.slice(1);
export const fieldMeans = (field: Field) => FIELDS[field]?.means ?? spec(keyOf(field)).means;
/** The filter a field writes. */
export const keyOf = (field: Field): Key => (field === "visibility" ? "is" : field);
const fieldOfWord = (key: Key, word: Word): Field => word.field ?? key;
/** The field a filter with this value is shown in. */
export function fieldOf(key: Key, value: string): Field {
  const { value: kind } = spec(key);
  const word = kind.type === "words" ? kind.words.find((w) => w.word === value || w.aliases?.includes(value)) : undefined;
  return word ? fieldOfWord(key, word) : key;
}
/** The fields a filter is offered as in a scope: itself, or for `is:` State and Visibility. */
export const fieldsOf = (key: Key, scope: Scope): Field[] => [...new Set([key, ...wordsFor(key, scope).map((w) => fieldOfWord(key, w))])];
/** The words a field takes in a scope. */
export const wordsIn = (field: Field, scope: Scope): Word[] => wordsFor(keyOf(field), scope).filter((w) => fieldOfWord(keyOf(field), w) === field);

const RELATIVE = /^(today|yesterday|tomorrow|[+]?\d{1,4}d)$/;
/** Whether a day is written as one that depends on what today is: `today`, `yesterday`, `tomorrow`, `7d` for seven days ago, `+7d` for seven days ahead. */
export const isRelative = (day: string) => RELATIVE.test(day);

const DAY_MS = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
/** The day so many days after `day`, or before it, and no further than the calendar a day is written in goes. */
export const shift = (day: string, days: number) => new Date(Math.min(at("9999-12-31"), Math.max(at("0001-01-01"), at(day) + days * DAY_MS))).toISOString().slice(0, 10);

/** The day a day as written stands for, given what today is. */
export function dayOf(written: string, today: string): string {
  if (!isRelative(written)) return written;
  if (written === "today") return today;
  if (written === "yesterday") return shift(today, -1);
  if (written === "tomorrow") return shift(today, 1);
  const days = Number(written.replace(/[+d]/g, ""));
  return shift(today, written.startsWith("+") ? days : -days);
}

const TAG_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u;
const isTag = (name: string) => TAG_NAME.test(name) && /\D/.test(name);
const WORD = /[\p{L}\p{N}]+/gu;
export const wordsOf = (text: string) => text.match(WORD) ?? [];
/** Text as its words alone, without case or accents, a space between them: what the index makes of it, for finding a word by its start in a line. */
export const folded = (text: string) => wordsOf(text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")).join(" ");
const OPERATORS = new Set(["AND", "OR", "NOT"]);
/** Words as a term. A lone AND, OR or NOT is a word only in quotes, so it is always the phrase. */
const textOf = (words: string[], phrase: boolean): Text => ({ kind: "text", words, phrase: phrase || (words.length === 1 && OPERATORS.has(words[0]!)) });
/** The NOT of a term. A NOT of a NOT says what is under both, so no tree has one. */
const negate = (of: Node): Node => (of.kind === "not" ? of.of : { kind: "not", of });

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The names nearest to one that isn't any of them, for the error that says so. */
function nearest(written: string, names: readonly string[]): string[] {
  const low = written.toLowerCase();
  const scored = names.map((name) => ({ name, far: low.length > 1 && (name.startsWith(low) || low.startsWith(name)) ? 0 : distance(low, name) }));
  return scored
    .filter((s) => s.far <= Math.min(2, Math.floor(low.length / 2)))
    .sort((a, b) => a.far - b.far)
    .slice(0, 3)
    .map((s) => s.name);
}

const listOf = (names: readonly string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? ""));

class Refused extends Error {
  readonly from: number;
  readonly to: number;
  constructor(message: string, from: number, to: number) {
    super(message);
    this.from = from;
    this.to = to;
  }
}

/** `in:` or `sort:` as it is read, before it is lifted out of the tree. */
type Setting = { kind: "set"; key: "in" | "sort"; values: string[]; from: number; to: number };
type Read = Node | Setting;

/**
 * Reads a query as typed. It never throws: what can't be read is answered as an error that says
 * where. A character that is no syntax is read as the words around it, as it always was, so `C++`
 * and `it's` are words. A word with a colon is a filter when what is before the colon is a filter's
 * name, and an error when it is letters and hyphens alone and names none, unless what follows the
 * colon starts with `/`: so `https://x` and `10:30` are words, and `titel:x` is an error.
 */
export function parse(text: string, scope: Scope): Parsed {
  try {
    if (typeof text !== "string") throw new Refused("A query is text", 0, 0);
    if (text.length > MAX_SEARCH_LENGTH) throw new Refused(`A query is at most ${MAX_SEARCH_LENGTH} characters, and this is ${text.length}`, MAX_SEARCH_LENGTH, text.length);
    const query = read(text, scope);
    // What is written back is longer than what was typed where `#a` is `tag:a` and `-(` is `NOT (`, and it has to be read again.
    const full = print(query).length;
    if (full > MAX_SEARCH_LENGTH) throw new Refused(`Written out in full this query is ${full} characters, and a query is at most ${MAX_SEARCH_LENGTH}`, 0, text.length);
    return { ok: true, query };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: { message: err.message, from: err.from, to: err.to } };
    return { ok: false, error: { message: "This query can't be read", from: 0, to: typeof text === "string" ? text.length : 0 } };
  }
}

function read(text: string, scope: Scope): Query {
  let at = 0;
  let terms = 0;
  const query: Query = { where: null, in: [], sort: null };
  const set = (setting: Setting) => {
    if (setting.key === "sort") {
      if (query.sort || setting.values.length > 1) throw new Refused("A query has one sort:", setting.from, setting.to);
      query.sort = setting.values[0] as SortKey;
    } else query.in = (["title", "body"] as const).filter((where) => query.in.includes(where) || setting.values.includes(where));
  };
  const space = () => {
    while (at < text.length && /\s/.test(text[at]!)) at++;
  };
  const term = (from: number, to: number) => {
    if (++terms > MAX_TERMS) throw new Refused(`A query has at most ${MAX_TERMS} terms`, from, to);
  };

  /** A token that isn't quoted: up to a space, a quote, or the `)` that closes a group. A value in quotes right after a filter's colon is part of it. */
  const bare = (depth: number): { written: string; quoted: string | null; valueAt: number } => {
    const from = at;
    while (at < text.length && !/\s/.test(text[at]!) && text[at] !== '"' && !(text[at] === ")" && depth > 0)) at++;
    const written = text.slice(from, at);
    if (text[at] === '"' && /^-?[A-Za-z][A-Za-z-]*:$/.test(written)) {
      const close = text.indexOf('"', at + 1);
      if (close < 0) throw new Refused('This " is never closed', at, text.length);
      const quoted = text.slice(at + 1, close);
      at = close + 1;
      return { written, quoted, valueAt: at - quoted.length - 2 };
    }
    return { written, quoted: null, valueAt: from };
  };

  const checked = (key: Key, value: string, from: number, to: number): string => {
    const { value: kind } = spec(key);
    if (!value) throw new Refused(`${key}: needs a value, such as ${spec(key).example}`, from, to);
    if (kind.type === "day") {
      const low = value.toLowerCase();
      if (!isDay(low) && !isRelative(low)) throw new Refused(`${key}: takes a day written YYYY-MM-DD, or today, yesterday, tomorrow, 7d for seven days ago or +7d for seven days ahead. "${value}" is none of them`, from, to);
      return low;
    }
    if (kind.type === "level") {
      const low = value.toLowerCase();
      const level = /^\d+$/.test(low) ? kind.levels[Number(low)] : kind.levels.find((l) => l === low);
      if (!level) throw new Refused(`${key}: takes ${listOf([...kind.levels].reverse())}, and "${value}" isn't one`, from, to);
      return level;
    }
    if (kind.type === "words") {
      const word = wordOf(key, scope, value);
      if (word) return word.word;
      const elsewhere = SCOPES.find((other) => other !== scope && wordOf(key, other, value));
      if (elsewhere) throw new Refused(`${key}:${wordOf(key, elsewhere, value)!.word} is for ${elsewhere}, and this is a search of ${scope}`, from, to);
      const near = nearest(value, wordsFor(key, scope).map((w) => w.word));
      throw new Refused(`${key}: doesn't take "${value}". ${near.length ? `Did you mean ${listOf(near)}?` : `It takes ${listOf(wordsFor(key, scope).map((w) => w.word))}`}`, from, to);
    }
    if (kind.type === "size") {
      const low = value.toLowerCase();
      if (!SIZE.test(low)) throw new Refused(`${key}: takes a number of bytes, or one with kb, mb or gb after it, such as 1mb. "${value}" is none of them`, from, to);
      return low;
    }
    if (kind.type === "tag") {
      const name = value.replace(/^#/, "");
      if (!isTag(name)) throw new Refused(`"${value}" is not a tag's name: letters, digits, _, - and /, and not digits alone`, from, to);
      return nameKey(name);
    }
    return value;
  };

  const filter = (name: string, raw: string, quoted: boolean, from: number, valueAt: number, to: number, depth: number): Read => {
    const lacks = name === LACKS;
    const key = lacks ? "has" : NAMED.get(name)!;
    const { scopes, compares, top } = spec(key);
    if (!scopes.includes(scope)) throw new Refused(`${key}: is for ${scopes.join(" and ")}, and this is a search of ${scope}`, from, to);
    if (!raw) throw new Refused(`${key}: needs a value, such as ${spec(key).example}`, from, to);
    if (top) {
      if (depth > 0) throw new Refused(`${key}: is for the whole query, so it can't be inside parentheses`, from, to);
      return { kind: "set", key: key as "in" | "sort", values: (quoted ? [raw] : raw.split(",")).map((value) => checked(key, value, valueAt, to)), from, to };
    }
    let cmp: Cmp = "=";
    let value = raw;
    let until: string | undefined;
    if (compares && !quoted) {
      const sign = /^(>=|<=|>|<)/.exec(raw)?.[1] as Cmp | undefined;
      const range = raw.indexOf("..");
      if (sign) {
        cmp = sign;
        value = raw.slice(sign.length);
        valueAt += sign.length;
      } else if (range >= 0) {
        const [low, high] = [raw.slice(0, range), raw.slice(range + 2)];
        if (low === "*" && high === "*") throw new Refused(`${key}:*..* says nothing. Give a day or a number on one side`, valueAt, to);
        if (high === "*") [cmp, value] = [">=", low];
        else if (low === "*") [cmp, value] = ["<=", high];
        else [value, until] = [low, checked(key, high, valueAt + range + 2, to)];
      }
    }
    const node: Filter = { kind: "filter", key: key as FilterKey, cmp, value: checked(key, value, valueAt, to), ...(until !== undefined && { to: until }) };
    return lacks ? negate(node) : node;
  };

  /** One term, or null for one with no words in it, which says nothing. */
  const atom = (depth: number): Read | null => {
    const from = at;
    if (text[at] === "(") {
      if (depth >= MAX_DEPTH) throw new Refused(`Parentheses can be ${MAX_DEPTH} deep at most`, at, at + 1);
      at++;
      space();
      if (text[at] === ")") throw new Refused("These parentheses have nothing in them", from, at + 1);
      const inside = either(depth + 1);
      space();
      if (text[at] !== ")") throw new Refused("This ( is never closed", from, from + 1);
      at++;
      return inside;
    }
    if (text[at] === '"') {
      const close = text.indexOf('"', at + 1);
      // A quote left open is no phrase: the words after it are read one by one.
      if (close < 0) {
        at++;
        return null;
      }
      at = close + 1;
      const words = wordsOf(text.slice(from + 1, close));
      if (!words.length) return null;
      term(from, at);
      return textOf(words, true);
    }
    if (text[at] === "-" && at + 1 < text.length && !/[\s)]/.test(text[at + 1]!)) {
      // Each `-` turns the term after them all around once more.
      let odd = false;
      for (; text[at] === "-" && at + 1 < text.length && !/[\s)]/.test(text[at + 1]!); at++) odd = !odd;
      const negated = atom(depth);
      if (negated?.kind === "set") throw new Refused(`${negated.key}: can't be negated`, from, negated.to);
      return negated && odd ? negate(negated) : negated;
    }
    const { written, quoted, valueAt } = bare(depth);
    if (!written) {
      // Nothing was read: a `)` with no group to close, which is no syntax here.
      at++;
      return null;
    }
    const keyed = /^([A-Za-z][A-Za-z-]*):(.*)$/s.exec(written);
    if (keyed && (NAMED.has(keyed[1]!) || keyed[1] === LACKS)) {
      term(from, at);
      return filter(keyed[1]!, quoted ?? keyed[2]!, quoted !== null, from, quoted === null ? from + keyed[1]!.length + 1 : valueAt, at, depth);
    }
    if (keyed && (keyed[2] || quoted !== null) && !keyed[2]!.startsWith("/")) {
      const near = nearest(keyed[1]!, [...keysFor(scope), LACKS]);
      throw new Refused(`There is no filter "${keyed[1]}:". ${near.length ? `Did you mean ${listOf(near.map((n) => `${n}:`))}? ` : ""}To search for the words, put them in quotes`, from, from + keyed[1]!.length + 1);
    }
    if (written.startsWith("#") && isTag(written.slice(1)) && spec("tag").scopes.includes(scope)) {
      term(from, at);
      return { kind: "filter", key: "tag", cmp: "=", value: nameKey(written.slice(1)) };
    }
    const words = wordsOf(written);
    if (!words.length) return null;
    term(from, at);
    return textOf(words, false);
  };

  const operator = (): string | null => {
    const word = /^(AND|OR|NOT)(?=[\s()]|$)/.exec(text.slice(at, at + 4))?.[1];
    return word ?? null;
  };

  const unary = (depth: number): Read | null => {
    space();
    const from = at;
    let nots = 0;
    for (let notAt = at; operator() === "NOT"; notAt = at) {
      at += 3;
      space();
      if (at >= text.length || text[at] === ")" || operator() === "AND" || operator() === "OR") throw new Refused("NOT needs a term after it", notAt, notAt + 3);
      nots++;
    }
    const read = atom(depth);
    if (nots && read?.kind === "set") throw new Refused(`${read.key}: can't be negated`, from, read.to);
    // Each NOT turns the term after them all around once more.
    return read && read.kind !== "set" && nots % 2 ? negate(read) : read;
  };

  const all = (depth: number): Node | null => {
    const of: Node[] = [];
    let needs: { word: string; from: number } | null = null;
    for (;;) {
      space();
      if (at >= text.length || (text[at] === ")" && depth > 0)) break;
      const word = operator();
      if (word === "OR") break;
      if (word === "AND") {
        if (needs || !of.length) throw new Refused("AND needs a term on both sides", at, at + 3);
        needs = { word, from: at };
        at += 3;
        continue;
      }
      const next = unary(depth);
      // `in:` and `sort:` say how the whole query is read, wherever outside a group they are written, and are no term of it.
      if (next?.kind === "set") {
        set(next);
        continue;
      }
      if (next) of.push(next);
      needs = null;
    }
    if (needs) throw new Refused("AND needs a term on both sides", needs.from, needs.from + 3);
    return of.length > 1 ? { kind: "and", of } : (of[0] ?? null);
  };

  function either(depth: number): Node | null {
    const of: Node[] = [];
    let orAt = -1;
    for (;;) {
      space();
      const from = at;
      const side = all(depth);
      space();
      const more = operator() === "OR";
      // A side with nothing typed is an error. One whose characters hold no words, such as `++`, says nothing and is left out.
      if (at === from && (more || orAt >= 0)) throw new Refused("OR needs a term on both sides", more ? at : orAt, (more ? at : orAt) + 2);
      if (side) of.push(side);
      if (!more) break;
      orAt = at;
      at += 2;
    }
    return of.length > 1 ? { kind: "or", of } : (of[0] ?? null);
  }

  query.where = either(0);
  return query;
}

/** A value as it is written after a filter's colon: bare when that reads back as itself, and otherwise in quotes. */
export const written = (value: string) => (/^[^\s"()]+$/.test(value) ? value : `"${value.replace(/"/g, "")}"`);

function printFilter({ key, cmp, value, to }: Filter): string {
  const { compares } = spec(key);
  if (!compares) return `${key}:${written(value)}`;
  return `${key}:${cmp === "=" ? "" : cmp}${value}${to === undefined ? "" : `..${to}`}`;
}

function printText({ words, phrase }: Text): string {
  if (phrase || (words.length === 1 && OPERATORS.has(words[0]!))) return `"${words.join(" ")}"`;
  return words.join("-");
}

function printNode(node: Node, under: "top" | "and" | "or" | "not"): string {
  switch (node.kind) {
    case "text":
      return printText(node);
    case "filter":
      return printFilter(node);
    case "not": {
      const of = node.of;
      if (of.kind === "filter" && of.key === "has") return `${LACKS}:${written(of.value)}`;
      if (of.kind === "filter" || of.kind === "text") return `-${printNode(of, "not")}`;
      return `NOT ${printNode(of, "not")}`;
    }
    case "and": {
      const printed = node.of.map((child) => printNode(child, "and")).join(" ");
      return under === "and" || under === "not" ? `(${printed})` : printed;
    }
    case "or": {
      const printed = node.of.map((child) => printNode(child, "or")).join(" OR ");
      return under === "top" ? printed : `(${printed})`;
    }
  }
}

/** The query as it is written: the one way, which {@link parse} reads back as the same query. */
export function print(query: Query): string {
  return [...(query.where ? [printNode(query.where, "top")] : []), ...query.in.map((where) => `in:${where}`), ...(query.sort ? [`sort:${query.sort}`] : [])].join(" ");
}

/** Every node of a tree, each with whether it is under an odd number of NOTs. */
export function* walk(node: Node | null, negated = false): Generator<{ node: Node; negated: boolean }> {
  if (!node) return;
  yield { node, negated };
  if (node.kind === "not") yield* walk(node.of, !negated);
  else if (node.kind === "and" || node.kind === "or") for (const child of node.of) yield* walk(child, negated);
}

/** Whether a query names `is:word` anywhere, which is what widens it to archived notes, to Trash, or to done todos. */
export const names = (where: Node | null, word: string) => [...walk(where)].some(({ node }) => node.kind === "filter" && node.key === "is" && node.value === word);

/** A tree as it is handed to SQL: each filter with its names looked up, and `note` for the one note a listing is narrowed to. */
export type Bound = { kind: "and" | "or"; of: Bound[] } | { kind: "not"; of: Bound } | Text | (Filter & Given) | { kind: "note"; id: string };

/** The terms as the full-text index is asked for them: each a quoted string of letters and digits, so there is no quote in it to close the string early, with `*` so its last word matches the start of a longer one. */
const termsOf = (terms: readonly Text[]) => terms.map(({ words }) => `"${words.join(" ")}"*`).join(" ");
const COLUMNS = { title: "title", body: "text" } as const;

/** What the index is asked for notes of one workspace with every term, in the title, the text, or either. A workspace's id is letters and digits, so it is one word to the index. */
export function matchOf(workspaceId: string, terms: readonly Text[], where: readonly In[] = []): string {
  const columns = where.length === 1 ? COLUMNS[where[0]!] : "{title text}";
  return `workspace : "${workspaceId.replace(/[^a-z0-9]/g, "")}" AND ${columns} : (${termsOf(terms)})`;
}

const FOUND = (c: Compiling, terms: readonly Text[], where: readonly In[]) =>
  `n.id IN (SELECT r.note_id FROM note_search s JOIN note_search_rows r ON r.id = s.rowid WHERE s.note_search MATCH ${c.bind(matchOf(c.workspaceId, terms, where))})`;

/**
 * Conditions joined by AND or by OR, in halves. SQLite reads `a OR b OR c` as a tree as deep as it is
 * long, and takes an expression a hundred deep: in halves, forty conditions are six deep.
 */
function joined(conditions: readonly string[], by: "AND" | "OR"): string {
  if (conditions.length <= 2) return conditions.join(` ${by} `);
  const half = Math.ceil(conditions.length / 2);
  return `(${joined(conditions.slice(0, half), by)}) ${by} (${joined(conditions.slice(half), by)})`;
}

/**
 * Notes with every one of `terms`. A todo is found by its own line unless the words are asked for in
 * its note's title: the index narrows to the notes with the words, and the line's own words, folded
 * as the index folds them, say which of a note's todos it is.
 */
function textIs(c: Compiling, terms: readonly Text[]): string {
  // An upload is found by its name: each term in it, its words in their order.
  // Words are letters and digits alone, which LIKE reads as themselves.
  if (c.scope === "uploads") return `(${joined(terms.map(({ words }) => `u.name LIKE ${c.bind(`%${words.join("%")}%`)}`), "AND")})`;
  if (c.scope === "notes") return FOUND(c, terms, c.in);
  const title = c.in.includes("title");
  if (title && !c.in.includes("body")) return FOUND(c, terms, ["title"]);
  const found = FOUND(c, terms, [title ? "title" : "body"]);
  const line = joined(terms.map(({ words }) => `t.words LIKE ${c.bind(`% ${folded(words.join(" "))}%`)}`), "AND");
  return title ? `(${found} OR (${line}))` : `(${found} AND (${line}))`;
}

/** The condition a tree is in SQL, over the notes row `n` and, for todos, the todos row `t`. It is never NULL. */
export function conditionOf(node: Bound | null, c: Compiling): string {
  if (!node) return "1";
  switch (node.kind) {
    case "note":
      return `n.id = ${c.bind(node.id)}`;
    case "text":
      return textIs(c, [node]);
    case "filter": {
      const { value } = spec(node.key);
      const made = value.type === "words" ? wordOf(node.key, c.scope, node.value)?.sql : spec(node.key).sql;
      return made ? `IFNULL(${made(c, node)}, 0)` : "0";
    }
    case "not":
      return `NOT (${conditionOf(node.of, c)})`;
    case "or":
      return `(${joined(node.of.map((child) => conditionOf(child, c)), "OR")})`;
    case "and": {
      // The words of one AND are asked of the index together, as one match.
      const terms = node.of.filter((child) => child.kind === "text");
      const rest = node.of.filter((child) => child.kind !== "text");
      return `(${joined([...(terms.length ? [textIs(c, terms)] : []), ...rest.map((child) => conditionOf(child, c))], "AND")})`;
    }
  }
}

/** The words a query looks for that it doesn't negate, and its tags likewise: what a result's lines are marked by. */
export function soughtIn(query: Query): { terms: string[][]; tags: string[] } {
  const found = [...walk(query.where)].filter(({ negated }) => !negated).map(({ node }) => node);
  return {
    terms: found.filter((node) => node.kind === "text").map((node) => node.words),
    tags: found.filter((node) => node.kind === "filter" && node.key === "tag").map((node) => (node as Filter).value),
  };
}

/** The terms a query asks of every result: its own, and those of the AND it is at the top. A search whose order is by its match puts the notes with them in the title first. */
export function topTerms(where: Node | null): Text[] {
  if (where?.kind === "text") return [where];
  return where?.kind === "and" ? where.of.filter((child) => child.kind === "text") : [];
}

/** The order a `sort:` asks for. */
export const orderOf = (sort: SortKey): Order => FILTERS.sort.value.words.find((w) => w.word === sort)!.order;

export interface SyntaxRow {
  form: string;
  means: string;
  example: string;
  /** The heading it is listed under: a field, or null for how terms are written and joined. */
  field: Field | null;
}

/** What is written between and around terms, which no filter is. */
const FORMS: readonly (Omit<SyntaxRow, "field"> & { scopes: readonly Scope[] })[] = [
  { form: "word", means: "Has the word, or one that starts with it, ignoring case and accents", example: "budget", scopes: BOTH },
  { form: "word", means: "Its name has the word in it, ignoring case", example: "report", scopes: UPLOADS },
  { form: '"a phrase"', means: "Has the words together, in that order", example: '"second quarter"', scopes: BOTH },
  { form: '"a phrase"', means: "Its name has the words in that order", example: '"q2 report"', scopes: UPLOADS },
  { form: "a b", means: "Both: a space is AND, which can also be written", example: "budget plan", scopes: BOTH },
  { form: "a b", means: "Both: a space is AND, which can also be written", example: "report type:pdf", scopes: UPLOADS },
  { form: "a OR b", means: "Either. OR, AND and NOT are operators only in capitals", example: "budget OR plan", scopes: BOTH },
  { form: "a OR b", means: "Either. OR, AND and NOT are operators only in capitals", example: "type:image OR type:video", scopes: UPLOADS },
  { form: "-a, NOT a", means: "Not: before a word, a phrase, a filter or a group", example: "budget -plan", scopes: BOTH },
  { form: "-a, NOT a", means: "Not: before a word, a phrase, a filter or a group", example: "-type:image", scopes: UPLOADS },
  { form: "( )", means: `Groups, up to ${MAX_DEPTH} deep. NOT binds first, then AND, then OR`, example: "(budget OR plan) -draft", scopes: BOTH },
  { form: "( )", means: `Groups, up to ${MAX_DEPTH} deep. NOT binds first, then AND, then OR`, example: "(type:pdf OR type:text) used:no", scopes: UPLOADS },
  { form: "key:>DAY, >=, <, <=", means: "After, on or after, before, on or before a day or a number", example: "updated:>2026-10-01", scopes: BOTH },
  { form: "key:>VALUE, >=, <, <=", means: "After, on or after, before, on or before a day; larger, at least, smaller, at most a size", example: "size:>=500kb", scopes: UPLOADS },
  { form: "key:A..B", means: "From A to B, both included. * leaves one side open", example: "created:2026-10-01..*", scopes: BOTH },
  { form: "key:A..B", means: "From A to B, both included. * leaves one side open", example: "size:1mb..5mb", scopes: UPLOADS },
  { form: "today, yesterday, tomorrow, 7d, +7d", means: "A day counted from today: 7d is seven days ago, +7d seven days ahead", example: "updated:>=7d", scopes: BOTH },
  { form: "today, yesterday, tomorrow, 7d, +7d", means: "A day counted from today: 7d is seven days ago, +7d seven days ahead", example: "uploaded:>=7d", scopes: UPLOADS },
  { form: "#NAME", means: "Short for tag:NAME", example: "#money", scopes: BOTH },
  { form: 'key:"a value"', means: "A value with a space in it is written in quotes", example: 'folder:"Common Ink"', scopes: ALL },
];

/** Every form of the language for a scope, each with what it means and an example that reads: the help, the tools' descriptions and the docs are this. */
export function syntax(scope: Scope): SyntaxRow[] {
  const filters = keysFor(scope).flatMap((key): SyntaxRow[] => {
    const { means, example, shown, aliases, value } = spec(key);
    const names = [key, ...aliases].map((name) => `${name}:${shown}`).join(", ");
    if (value.type !== "words") return [{ form: names, means, example, field: key }];
    return [
      ...wordsFor(key, scope).map((w) => ({ form: `${key}:${w.word}`, means: w.means, example: key === "in" ? `budget ${key}:${w.word}` : `${key}:${w.word}`, field: fieldOfWord(key, w) })),
      ...(key === "has" ? [{ form: `${LACKS}:WORD`, means: "Lacks it: the same as -has:WORD", example: `${LACKS}:${wordsFor(key, scope)[0]!.word}`, field: key }] : []),
    ];
  });
  return [...FORMS.filter((form) => form.scopes.includes(scope)).map(({ form, means, example }) => ({ form, means, example, field: null })), ...filters];
}

/** The language in a few lines, for a tool's description. */
export const syntaxText = (scope: Scope) =>
  syntax(scope)
    .map((row) => `${row.form}: ${row.means}`)
    .join("\n");

/** What a todo's line can hold, every rule of `every:` among it, for a model that is to write one unaided. */
const TODO_TOKENS = `A todo is a checkbox line in a note: ${STATES_WRITTEN}. A query that names no state lists only open ones. Its options are tokens on the line: !, !! or !!! right after the checkbox for its priority (Low, Medium, High; none is None), due:YYYY-MM-DD for the day it is due, and [[person:Name]] or [[person:id]] for someone it is assigned to. every:RULE makes it repeat, and each listed todo's recurs says its rule in words. The rules:
${RULE_GRAMMAR}
done:YYYY-MM-DDxN is when a repeating todo was last checked off and how many times, which checking it off writes. A #tag anywhere in a note tags the note. A todo counts as tagged with the tags on its own line and those that cover it: a heading's cover the lines under it up to the next heading at the same or a higher level; a line of nothing but tags covers the rest of its section, or before the first heading the lines up to it; a tag in a list item covers the items nested under it. Each listed todo's tags are the ones it has, and tagsElsewhere says the line each one it has from elsewhere is written on.`;

/** Every form a query of `scope` can take, and for todos what a todo's line can hold: what query_syntax answers and `ink syntax` prints. */
export const queryLanguage = (scope: Scope) =>
  [
    `The query language, where a space is AND and every form can be combined:\n${syntaxText(scope)}\nA query that can't be read is refused, saying which characters and why, and so is a folder: or ${scope === "uploads" ? "an uploader:" : "an editor:"} naming nothing you can see. A word with a colon that is no filter is an error unless it is in quotes.`,
    ...(scope === "todos" ? [TODO_TOKENS] : []),
  ].join("\n\n");

const table = (scope: Scope) => ["| Write | It finds | Example |", "| --- | --- | --- |", ...syntax(scope).map((row) => `| \`${row.form.replace(/\|/g, "\\|")}\` | ${row.means} | \`${row.example}\` |`)].join("\n");

/** The tables of `docs/search.md`, between its marks. */
export const syntaxDocs = () => SCOPES.map((scope) => `### ${scope[0]!.toUpperCase()}${scope.slice(1)}\n\n${table(scope)}`).join("\n\n");

/** What is being typed at `cursor`, for completing it: a filter's name, or the value of one. */
export interface Typing {
  from: number;
  to: number;
  /** The filter whose value is being typed, or null while a name is. */
  key: Key | null;
  typed: string;
  /** What comes before the value where it is put: the sign of a comparison, or nothing. */
  lead: string;
}

export function typingAt(text: string, cursor: number, scope: Scope): Typing | null {
  let from = cursor;
  while (from > 0 && !/[\s(]/.test(text[from - 1]!)) from--;
  let token = text.slice(from, cursor);
  if (cursor < text.length && !/[\s)]/.test(text[cursor]!)) return null;
  if (token.startsWith("-")) {
    from++;
    token = token.slice(1);
  }
  if (token.startsWith("#")) return spec("tag").scopes.includes(scope) && (isTag(token.slice(1)) || token === "#") ? { from, to: cursor, key: "tag", typed: token.slice(1), lead: "#" } : null;
  const keyed = /^([A-Za-z][A-Za-z-]*):(.*)$/s.exec(token);
  if (!keyed) return /^[a-z][a-z-]*$/.test(token) ? { from, to: cursor, key: null, typed: token, lead: "" } : null;
  const key = keyed[1] === LACKS ? "has" : NAMED.get(keyed[1]!);
  if (!key || !spec(key).scopes.includes(scope)) return null;
  const lead = spec(key).compares ? (/^(>=|<=|>|<)/.exec(keyed[2]!)?.[1] ?? "") : "";
  const typed = keyed[2]!.slice(lead.length).replace(/^"/, "");
  return { from: from + keyed[1]!.length + 1 + lead.length, to: cursor, key, typed, lead };
}

/** The names a filter's name being typed could be, for a scope. */
export const keysStarting = (typed: string, scope: Scope): string[] => [...keysFor(scope).flatMap((key) => [key, ...spec(key).aliases]), ...(spec("has").scopes.includes(scope) ? [LACKS] : [])].filter((name) => name.startsWith(typed)).sort();

/** A filter as the table says it, for whoever draws a picker or a help from it. */
export const filterOf = (key: Key): Pick<Spec, "means" | "example" | "compares" | "value" | "shown" | "top"> => spec(key);
