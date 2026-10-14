import { describe, expect, it } from "vitest";
import { FILTERS, KEYS, MAX_DEPTH, MAX_SEARCH_LENGTH, MAX_TERMS, conditionOf, dayOf, filterOf, folded, keysFor, keysStarting, parse, print, shift, syntax, syntaxDocs, typingAt, wordsFor, type Bound, type Compiling, type Filter, type Node, type Query, type Scope } from "../../src/core/query.ts";

import docs from "../../docs/search.md?raw";

const text = (written: string, phrase = false): Node => ({ kind: "text", words: written.split(" "), phrase });
const filter = (key: Filter["key"], value: string, cmp: Filter["cmp"] = "=", to?: string): Filter => ({ kind: "filter", key, cmp, value, ...(to !== undefined && { to }) });
const and = (...of: Node[]): Node => ({ kind: "and", of });
const or = (...of: Node[]): Node => ({ kind: "or", of });
const not = (of: Node): Node => ({ kind: "not", of });
const q = (where: Node | null, more: Partial<Query> = {}): Query => ({ where, in: [], sort: null, ...more });

/** What is typed, the query it is, and how that query is written back. */
const READS: [typed: string, scope: Scope, query: Query, printed: string][] = [
  ["", "notes", q(null), ""],
  ["   ", "notes", q(null), ""],
  ["budget", "notes", q(text("budget")), "budget"],
  ["budget plan", "notes", q(and(text("budget"), text("plan"))), "budget plan"],
  ["budget AND plan", "notes", q(and(text("budget"), text("plan"))), "budget plan"],
  ['"second quarter"', "notes", q(text("second quarter", true)), '"second quarter"'],
  ['"one"', "notes", q(text("one", true)), '"one"'],
  ["budget OR plan", "notes", q(or(text("budget"), text("plan"))), "budget OR plan"],
  ["a b OR c d", "notes", q(or(and(text("a"), text("b")), and(text("c"), text("d")))), "a b OR c d"],
  ["a (b OR c)", "notes", q(and(text("a"), or(text("b"), text("c")))), "a (b OR c)"],
  ["(a b) c", "notes", q(and(and(text("a"), text("b")), text("c"))), "(a b) c"],
  ["a OR (b OR c)", "notes", q(or(text("a"), or(text("b"), text("c")))), "a OR (b OR c)"],
  ["(a)", "notes", q(text("a")), "a"],
  ["-draft", "notes", q(not(text("draft"))), "-draft"],
  ["NOT draft", "notes", q(not(text("draft"))), "-draft"],
  ['-"first draft"', "notes", q(not(text("first draft", true))), '-"first draft"'],
  ["NOT (a OR b)", "notes", q(not(or(text("a"), text("b")))), "NOT (a OR b)"],
  ["-(a b)", "notes", q(not(and(text("a"), text("b")))), "NOT (a b)"],
  ["NOT NOT a", "notes", q(text("a")), "a"],
  ["NOT a b OR c", "notes", q(or(and(not(text("a")), text("b")), text("c"))), "-a b OR c"],
  ["or and not", "notes", q(and(text("or"), text("and"), text("not"))), "or and not"],
  ['"OR"', "notes", q(text("OR", true)), '"OR"'],
  ["ORANGE NOTE ANDROID", "notes", q(and(text("ORANGE"), text("NOTE"), text("ANDROID"))), "ORANGE NOTE ANDROID"],

  ["folder:Projects", "notes", q(filter("folder", "Projects")), "folder:Projects"],
  ['folder:"Common Ink"', "notes", q(filter("folder", "Common Ink")), 'folder:"Common Ink"'],
  ["-folder:Projects", "notes", q(not(filter("folder", "Projects"))), "-folder:Projects"],
  ["folder:>x", "notes", q(filter("folder", ">x")), "folder:>x"],
  ["tag:Money", "notes", q(filter("tag", "money")), "tag:money"],
  ["#Money", "notes", q(filter("tag", "money")), "tag:money"],
  ["-#money", "notes", q(not(filter("tag", "money"))), "-tag:money"],
  ["tag:#work/home", "todos", q(filter("tag", "work/home")), "tag:work/home"],
  ["updated:2026-10-01", "notes", q(filter("updated", "2026-10-01")), "updated:2026-10-01"],
  ["updated:>2026-10-01", "notes", q(filter("updated", "2026-10-01", ">")), "updated:>2026-10-01"],
  ["updated:>=2026-10-01", "notes", q(filter("updated", "2026-10-01", ">=")), "updated:>=2026-10-01"],
  ["created:<2026-10-01", "notes", q(filter("created", "2026-10-01", "<")), "created:<2026-10-01"],
  ["created:<=2026-10-01", "todos", q(filter("created", "2026-10-01", "<=")), "created:<=2026-10-01"],
  ["updated:2026-10-01..2026-10-14", "notes", q(filter("updated", "2026-10-01", "=", "2026-10-14")), "updated:2026-10-01..2026-10-14"],
  ["updated:2026-10-01..*", "notes", q(filter("updated", "2026-10-01", ">=")), "updated:>=2026-10-01"],
  ["updated:*..2026-10-14", "notes", q(filter("updated", "2026-10-14", "<=")), "updated:<=2026-10-14"],
  ["updated:Today", "notes", q(filter("updated", "today")), "updated:today"],
  ["updated:>=7d", "notes", q(filter("updated", "7d", ">=")), "updated:>=7d"],
  ["due:today..+7d", "todos", q(filter("due", "today", "=", "+7d")), "due:today..+7d"],
  ["due:<today", "todos", q(filter("due", "today", "<")), "due:<today"],
  ["editor:@me", "notes", q(filter("editor", "@me")), "editor:@me"],
  ['edited-by:"Ada Lovelace"', "notes", q(filter("editor", "Ada Lovelace")), 'editor:"Ada Lovelace"'],
  ["author:Scribe", "todos", q(filter("author", "Scribe")), "author:Scribe"],
  ["is:archived", "notes", q(filter("is", "archived")), "is:archived"],
  ["is:open", "notes", q(filter("is", "open")), "is:open"],
  ["is:trashed is:shared is:private", "notes", q(and(filter("is", "trashed"), filter("is", "shared"), filter("is", "private"))), "is:trashed is:shared is:private"],
  ["is:done", "todos", q(filter("is", "done")), "is:done"],
  ["is:open OR is:done", "todos", q(or(filter("is", "open"), filter("is", "done"))), "is:open OR is:done"],
  ["has:todo has:open-todo has:link has:backlink has:tag", "notes", q(and(filter("has", "todo"), filter("has", "open-todo"), filter("has", "link"), filter("has", "backlink"), filter("has", "tag"))), "has:todo has:open-todo has:link has:backlink has:tag"],
  ["has:task has:open-task", "notes", q(and(filter("has", "todo"), filter("has", "open-todo"))), "has:todo has:open-todo"],
  ["no:todo", "notes", q(not(filter("has", "todo"))), "no:todo"],
  ["-has:todo", "notes", q(not(filter("has", "todo"))), "no:todo"],
  ["-no:link", "notes", q(filter("has", "link")), "has:link"],
  ["has:due no:repeat", "todos", q(and(filter("has", "due"), not(filter("has", "repeat")))), "has:due no:repeat"],
  ["has:recurrence no:recurrence", "todos", q(and(filter("has", "repeat"), not(filter("has", "repeat")))), "has:repeat no:repeat"],
  ["importance:>=2", "todos", q(filter("importance", "2", ">=")), "importance:>=2"],
  ["importance:1..3", "todos", q(filter("importance", "1", "=", "3")), "importance:1..3"],
  ["importance:03", "todos", q(filter("importance", "3")), "importance:3"],
  ["budget in:title", "notes", q(text("budget"), { in: ["title"] }), "budget in:title"],
  ["in:body in:title budget", "notes", q(text("budget"), { in: ["title", "body"] }), "budget in:title in:body"],
  ["in:title,body budget", "notes", q(text("budget"), { in: ["title", "body"] }), "budget in:title in:body"],
  ["sort:title-asc", "notes", q(null, { sort: "title-asc" }), "sort:title-asc"],
  ["sort:due-desc call", "todos", q(text("call"), { sort: "due-desc" }), "call sort:due-desc"],
  ["a OR b in:title", "notes", q(or(text("a"), text("b")), { in: ["title"] }), "a OR b in:title"],
  ["sort:title-asc a OR in:body b", "notes", q(or(text("a"), text("b")), { in: ["body"], sort: "title-asc" }), "a OR b in:body sort:title-asc"],
  ["a sort:updated-asc (b OR c)", "notes", q(and(text("a"), or(text("b"), text("c"))), { sort: "updated-asc" }), "a (b OR c) sort:updated-asc"],

  // What was typed before there was a language reads as it did.
  ["foo-bar it's C++ a#b", "notes", q(and(text("foo bar"), text("it s"), text("C"), text("a b"))), "foo-bar it-s C a-b"],
  ['"left open', "notes", q(and(text("left"), text("open"))), "left open"],
  ['  "" # + * ) : ^ -  ', "notes", q(null), ""],
  ["+Home #12 f(x)", "notes", q(and(text("Home"), text("12"), text("f x"))), "Home 12 f-x"],
  ["https://example.com/a 10:30 re: :)", "notes", q(and(text("https example com a"), text("10 30"), text("re"))), "https-example-com-a 10-30 re"],
  ["a OR ++", "notes", q(text("a")), "a"],
  ["a -- b - c", "notes", q(and(text("a"), text("b"), text("c"))), "a b c"],
  ["a ) b", "notes", q(and(text("a"), text("b"))), "a b"],
];

/** What can't be read, and the part of it the error points at. */
const REFUSED: [typed: string, scope: Scope, at: string, says: RegExp][] = [
  ["titel:budget", "notes", "titel:", /no filter "titel:"/],
  ["folders:Home", "notes", "folders:", /Did you mean folder:\?/],
  ["edtor:@me x", "notes", "edtor:", /Did you mean editor:\?/],
  ["a C:\\temp", "notes", "C:", /put them in quotes/],
  ["is:opne", "notes", "opne", /Did you mean open\?/],
  ["is:done", "notes", "done", /is:done is for todos/],
  ["has:todo", "todos", "todo", /has:todo is for notes/],
  ["due:today", "notes", "due:today", /due: is for todos/],
  ["a folder:", "notes", "folder:", /folder: needs a value/],
  ["updated:soon", "notes", "soon", /takes a day/],
  ["updated:2026-02-30", "notes", "2026-02-30", /takes a day/],
  ["updated:2026-10-01..never", "notes", "never", /takes a day/],
  ["updated:*..*", "notes", "*..*", /says nothing/],
  ["importance:4", "todos", "4", /from 0 to 3/],
  ["importance:>high", "todos", "high", /from 0 to 3/],
  ["tag:12", "notes", "12", /not a tag's name/],
  ['folder:"Common Ink', "notes", '"Common Ink', /never closed/],
  ["(a b", "notes", "(", /never closed/],
  ["a OR", "notes", "OR", /OR needs a term on both sides/],
  ["OR a", "notes", "OR", /OR needs a term on both sides/],
  ["a OR OR b", "notes", "OR", /OR needs a term on both sides/],
  ["(a OR ) b", "notes", "OR", /OR needs a term on both sides/],
  ["a AND", "notes", "AND", /AND needs a term on both sides/],
  ["AND a", "notes", "AND", /AND needs a term on both sides/],
  ["a NOT", "notes", "NOT", /NOT needs a term after it/],
  ["NOT OR a", "notes", "NOT", /NOT needs a term after it/],
  ["(a in:title)", "notes", "in:title", /can't be inside parentheses/],
  ["-in:title a", "notes", "-in:title", /can't be negated/],
  ["NOT sort:title-asc", "notes", "NOT sort:title-asc", /can't be negated/],
  ["sort:title-asc sort:title-desc", "notes", "sort:title-desc", /one sort:/],
  ["sort:due-asc", "notes", "due-asc", /sort:due-asc is for todos/],
  ["sort:newest", "notes", "newest", /doesn't take "newest"/],
  ["in:heading x", "notes", "heading", /doesn't take "heading"/],
];

describe("a query as typed", () => {
  it.each(READS)("%j is read, and written back the one way", (typed, scope, query, printed) => {
    expect(parse(typed, scope)).toEqual({ ok: true, query });
    expect(print(query)).toBe(printed);
    expect(parse(printed, scope)).toEqual({ ok: true, query });
  });

  it.each(REFUSED)("%j is refused, saying where", (typed, scope, at, says) => {
    const parsed = parse(typed, scope);
    if (parsed.ok) throw new Error(`read as ${JSON.stringify(parsed.query)}`);
    expect(typed.slice(parsed.error.from, parsed.error.to)).toBe(at);
    expect(parsed.error.message).toMatch(says);
  });

  it("has a row above for every filter and every word one takes", () => {
    const forms = (node: Node | null): string[] => {
      if (!node || node.kind === "text") return [];
      if (node.kind === "filter") return [FILTERS[node.key].value.type === "words" ? `${node.key}:${node.value}` : node.key];
      return (node.kind === "not" ? [node.of] : node.of).flatMap(forms);
    };
    const read = new Set(READS.flatMap(([, , query]) => [...forms(query.where), ...query.in.map((where) => `in:${where}`), ...(query.sort ? ["sort"] : [])]));
    const said = (["notes", "todos"] as const).flatMap((scope) => keysFor(scope).flatMap((key) => (FILTERS[key].value.type === "words" && key !== "sort" ? wordsFor(key, scope).map((w) => `${key}:${w.word}`) : [key])));
    expect(said.filter((form) => !read.has(form))).toEqual([]);
  });

  it("limits how deep, how many and how long, each said where", () => {
    const deep = (n: number) => `${"(".repeat(n)}a${")".repeat(n)}`;
    expect(parse(deep(MAX_DEPTH), "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(parse(deep(MAX_DEPTH + 1), "notes")).toEqual({ ok: false, error: { message: `Parentheses can be ${MAX_DEPTH} deep at most`, from: MAX_DEPTH, to: MAX_DEPTH + 1 } });
    const many = (n: number) => Array.from({ length: n }, () => "a").join(" ");
    expect(parse(many(MAX_TERMS), "notes").ok).toBe(true);
    expect(parse(many(MAX_TERMS + 1), "notes")).toEqual({ ok: false, error: { message: `A query has at most ${MAX_TERMS} terms`, from: MAX_TERMS * 2, to: MAX_TERMS * 2 + 1 } });
    expect(parse("a".repeat(MAX_SEARCH_LENGTH), "notes").ok).toBe(true);
    expect(parse("a".repeat(MAX_SEARCH_LENGTH + 5), "notes")).toMatchObject({ ok: false, error: { from: MAX_SEARCH_LENGTH, to: MAX_SEARCH_LENGTH + 5 } });
  });

  it("reads a NOT of a NOT as what is under both, however many there are", () => {
    expect(parse("--a", "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(parse("---a", "notes")).toEqual({ ok: true, query: q(not(text("a"))) });
    expect(parse("NOT NOT a", "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(parse("NOT -a", "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(parse("NOT (-a)", "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(parse("-no:link", "notes")).toEqual(parse("has:link", "notes"));
    expect(parse(`${"-".repeat(120)}x`, "notes")).toEqual({ ok: true, query: q(text("x")) });
    expect(parse(`${"NOT ".repeat(49)}x`, "notes")).toEqual({ ok: true, query: q(not(text("x"))) });
  });

  it("refuses a query that written out in full is over the length, so what is written back is always read", () => {
    const tags = Array.from({ length: MAX_TERMS }, (_, i) => `#t${i}`).join(" ");
    expect(parse(tags.slice(0, 120), "notes").ok).toBe(true);
    expect(parse(tags, "notes")).toEqual({ ok: false, error: { message: `Written out in full this query is ${tags.replaceAll("#", "tag:").length} characters, and a query is at most ${MAX_SEARCH_LENGTH}`, from: 0, to: tags.length } });
    for (const typed of [`${"-".repeat(191)}x`, `${"NOT(a b)".repeat(20)}`, `${Array.from({ length: 19 }, () => "-(a b)").join("")} in:title,body`]) {
      const read = parse(typed, "notes");
      if (read.ok) expect(print(read.query).length, typed).toBeLessThanOrEqual(MAX_SEARCH_LENGTH);
    }
  });

  it("refuses parentheses with nothing in them, and reads a day at the calendar's end", () => {
    expect(parse("()", "notes")).toEqual({ ok: false, error: { message: "These parentheses have nothing in them", from: 0, to: 2 } });
    expect(parse("a OR ( )", "notes")).toEqual({ ok: false, error: { message: "These parentheses have nothing in them", from: 5, to: 8 } });
    expect(parse("a (++)", "notes")).toEqual({ ok: true, query: q(text("a")) });
    expect(shift("9999-12-31", 1)).toBe("9999-12-31");
    expect(shift("9999-12-30", 1)).toBe("9999-12-31");
    expect(shift("1850-05-05", 1)).toBe("1850-05-06");
    expect(shift("0001-01-01", -1)).toBe("0001-01-01");
    expect(dayOf("+9999d", "9999-01-01")).toBe("9999-12-31");
  });

  it("reads a lone AND, OR or NOT that is no operator as the phrase it is written back as", () => {
    for (const typed of ["AND-", "-NOT", "OR.", '"AND"']) {
      const read = parse(typed, "notes");
      expect(read.ok && parse(print(read.query), "notes"), typed).toEqual(read);
    }
    expect(parse("AND-", "notes")).toEqual({ ok: true, query: q(text("AND", true)) });
  });
});

/** A small generator of numbers that is the same each run. */
function seeded(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % below;
  };
}

describe("a query written back", () => {
  const WORDS = ["a", "budget", "Ünïcode", "2026", "x1", "plan", "or", "and", "not", "名前", "AND", "NOT"];
  const DAYS = ["2026-10-01", "2026-12-31", "today", "yesterday", "tomorrow", "7d", "+30d"];
  const NAMES = ["Projects", "Common Ink", "@me", "a..b", ">x", "it's", "(group)", "é", "x:y", "-dash", "AND", "#hash"];
  const CMPS = ["=", ">", ">=", "<", "<="] as const;

  function generate(scope: Scope, pick: (below: number) => number): Query {
    const one = <T,>(of: readonly T[]) => of[pick(of.length)]!;
    const keys = keysFor(scope).filter((key) => !filterOf(key).top) as Filter["key"][];
    const leaf = (): Node => {
      if (pick(3) === 0) {
        const words = Array.from({ length: 1 + pick(3) }, () => one(WORDS));
        // A lone AND or NOT is a word only in quotes, so it is always the phrase.
        return { kind: "text", words, phrase: pick(2) === 0 || (words.length === 1 && /^[A-Z]+$/.test(words[0]!)) };
      }
      const key = one(keys);
      const { value, compares } = FILTERS[key];
      const range = compares && pick(4) === 0;
      const cmp = compares && !range ? one(CMPS) : "=";
      const made = (): string => (value.type === "day" ? one(DAYS) : value.type === "number" ? String(pick(4)) : value.type === "words" ? one(wordsFor(key, scope)).word : value.type === "tag" ? one(["money", "work/home", "a_b", "x-1"]) : one(NAMES));
      return { kind: "filter", key, cmp, value: made(), ...(range && { to: made() }) };
    };
    const node = (depth: number): Node => {
      const kind = depth >= 4 ? 0 : pick(6);
      if (kind <= 2) return leaf();
      if (kind === 3) {
        // A NOT of a NOT is read as what is under both, so no tree has one.
        const of = node(depth + 1);
        return of.kind === "not" ? of.of : { kind: "not", of };
      }
      return { kind: kind === 4 ? "and" : "or", of: Array.from({ length: 2 + pick(2) }, () => node(depth + 1)) };
    };
    const sorts = wordsFor("sort", scope).map((w) => w.word) as NonNullable<Query["sort"]>[];
    return { where: pick(10) === 0 ? null : node(0), in: [[], ["title"], ["body"], ["title", "body"]][pick(4)] as Query["in"], sort: pick(3) === 0 ? one(sorts) : null };
  }

  it("is read back as the same query, for two thousand made-up queries", () => {
    const pick = seeded(47);
    for (let i = 0; i < 2000; i++) {
      const scope = pick(2) === 0 ? "notes" : "todos";
      const query = generate(scope, pick);
      const printed = print(query);
      if (printed.length > MAX_SEARCH_LENGTH) continue;
      const again = parse(printed, scope);
      expect(again, printed).toEqual({ ok: true, query });
      expect(print((again as { query: Query }).query)).toBe(printed);
    }
  });
});

describe("a query nobody meant well", () => {
  const HOSTILE = [
    '"',
    '"""',
    '"a "b" c"',
    "(((",
    ")))",
    "(()",
    "a".repeat(10_000),
    `${"(".repeat(1000)}a${")".repeat(1000)}`,
    "(".repeat(150),
    "NOT ".repeat(50),
    "-".repeat(200),
    "a OR ".repeat(40),
    "\0",
    "a\0b folder:\0 \u0001\u001f\u007f",
    "\u202Eevil\u202C مرحبا שלום",
    "e\u0301\u0301\u0301 a\u0300b n\u0303:x",
    "'; DROP TABLE notes;--",
    '") OR 1=1 --',
    'folder:"x") OR 1=1 --"',
    "folder:'; DROP TABLE notes;--",
    "tag:x' OR '1'='1",
    "NEAR(a b) a* ^a a:b {title}:x",
    '"NEAR(a b, 5)" "a*" "^a" "title : x" "a AND b"',
    "title:a text:b workspace:c",
    "is:",
    "no:",
    "::::",
    "a:b:c:d",
    "-:x",
    "#",
    "##a",
    "folder:\"\"",
    "sort: in:",
    "updated:..",
    "updated:>",
    "updated:>=..<=",
    "importance:99999999999999999999",
    "\ud83d\ude00 \ud83d",
    String.fromCharCode(...Array.from({ length: 150 }, (_, i) => i)),
  ];

  it.each(HOSTILE.map((typed) => [typed]))("%j is answered, never thrown", (typed) => {
    for (const scope of ["notes", "todos"] as const) {
      const parsed = parse(typed, scope);
      if (parsed.ok) expect(parse(print(parsed.query), scope)).toEqual(parsed);
      else {
        expect(parsed.error.message).toBeTruthy();
        expect(parsed.error.from).toBeGreaterThanOrEqual(0);
        expect(parsed.error.to).toBeGreaterThanOrEqual(parsed.error.from);
        expect(parsed.error.to).toBeLessThanOrEqual(typed.length);
      }
    }
    // @ts-expect-error what isn't text is refused the same way
    expect(parse(null, "notes").ok).toBe(false);
  });

  /** Every value is handed over through `bind`, so the SQL holds what the table wrote and nothing typed. */
  const compiled = (typed: string, scope: Scope) => {
    const parsed = parse(typed, scope);
    if (!parsed.ok) return null;
    const binds: (string | number)[] = [];
    const c: Compiling = { scope, workspaceId: "abc123", in: parsed.query.in, bind: (value) => `?${binds.push(value)}`, seen: (alias) => `SEEN(${alias})`, dayStart: () => 1, dayEnd: () => 2 };
    const resolved = JSON.parse(JSON.stringify(parsed.query.where), (_, value: unknown) => (typeof value === "object" && value !== null && (value as Node).kind === "filter" ? { ...value, ids: ["x"] } : value)) as Bound | null;
    return { sql: conditionOf(resolved, c), binds };
  };

  it("puts nothing that was typed into the SQL: every value is bound", () => {
    for (const typed of [...HOSTILE, 'zqzq "zqzq zqzq" folder:zqzq tag:zqzq editor:zqzq author:zqzq -zqzq (zqzq OR #zqzq)', "is:archived has:link updated:2026-10-01 created:>7d"]) {
      for (const scope of ["notes", "todos"] as const) {
        const made = compiled(typed.replace(/7d/, "2026-10-02"), scope);
        if (!made) continue;
        expect(made.sql).not.toMatch(/zqzq|DROP|1=1|NEAR|evil|--|;/);
        expect(made.sql.match(/\?\d+/g)?.length ?? 0).toBe(made.binds.length);
      }
    }
  });

  it("asks the index for quoted strings of letters and digits alone, whatever was typed", () => {
    const asked = (typed: string) => compiled(typed, "notes")!.binds.filter((bind) => typeof bind === "string" && bind.startsWith("workspace"));
    expect(asked('budget "second quarter"')).toEqual(['workspace : "abc123" AND {title text} : ("budget"* "second quarter"*)']);
    expect(asked('a" OR "b NEAR(c) NOT e* {x} ^f')).toEqual(['workspace : "abc123" AND {title text} : ("a"* "OR"* "b"* "NEAR c"* "x"* "f"*)', 'workspace : "abc123" AND {title text} : ("e"*)']);
    for (const bind of asked('x" OR "y 10:30 (c) -d "NEAR(e f)" g* ^h {i} j:// k"l')) expect(bind).toMatch(/^workspace : "abc123" AND \{title text\} : \(("[\p{L}\p{N} ]+"\*( |(?=\))))+\)$/u);
    expect(asked("budget in:title")).toEqual(['workspace : "abc123" AND title : ("budget"*)']);
    expect(asked("budget in:body")).toEqual(['workspace : "abc123" AND text : ("budget"*)']);
  });

  it("binds at most two values a term, for the largest query the limits allow with no word of it said twice", () => {
    const WORDS = [..."abcdefghijklmnopqrstuvwxyz0123456789αβγδ"];
    expect(WORDS.length).toBe(MAX_TERMS);
    const largest = [WORDS.join(" OR "), WORDS.join(" "), WORDS.map((word) => `-${word}`).join(" "), `${WORDS.slice(0, 36).join(" OR ")} in:title in:body`, `${WORDS.slice(0, 38).map((word) => `-${word}`).join(" ")} in:title in:body`];
    for (const typed of largest) {
      for (const scope of ["notes", "todos"] as const) {
        const made = compiled(typed, scope)!;
        expect(made.binds.length, `${scope}: ${typed}`).toBeLessThanOrEqual(2 * MAX_TERMS);
      }
    }
    expect(compiled(WORDS.map((word) => `-${word}`).join(" "), "todos")!.binds.length).toBe(2 * MAX_TERMS);
    const days = Array.from({ length: 7 }, () => "due:2026-10-01..2026-10-02").join(" ");
    expect(days.length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH);
    expect(compiled(days, "todos")!.binds.length).toBe(14);
  });

  it("finds a todo's words by their starts in its folded line, as the index finds a note's", () => {
    expect(folded("Buy Éclair, and CAFÉ-au-lait!")).toBe("buy eclair and cafe au lait");
    expect(folded("İstanbul e\u0301te\u0301")).toBe("istanbul ete");
    expect(compiled('Éclair "Au Lait"', "todos")!.binds).toEqual(['workspace : "abc123" AND text : ("Éclair"* "Au Lait"*)', "% eclair%", "% au lait%"]);
    expect(compiled("Éclair in:title in:body", "todos")!.binds).toEqual(['workspace : "abc123" AND title : ("Éclair"*)', "% eclair%"]);
  });
});

describe("what is said of the language", () => {
  it("is all read from the one table: every example reads, in the scope it is shown for", () => {
    for (const scope of ["notes", "todos"] as const) {
      for (const row of syntax(scope)) expect(parse(row.example, scope), `${scope}: ${row.example}`).toMatchObject({ ok: true });
      for (const key of keysFor(scope)) expect(syntax(scope).some((row) => row.form.startsWith(`${key}:`)), key).toBe(true);
    }
    expect(KEYS).toEqual(["folder", "tag", "updated", "created", "editor", "author", "is", "has", "due", "importance", "in", "sort"]);
  });

  it("is what docs/search.md says, between its marks: run `node scripts/query-docs.ts` after changing a filter", () => {
    const [, between] = /<!-- syntax -->\n([\s\S]*)\n<!-- \/syntax -->/.exec(docs) ?? [];
    expect(between).toBe(syntaxDocs());
  });

  it("knows what is being typed, to complete it", () => {
    expect(typingAt("budget fo", 9, "notes")).toEqual({ from: 7, to: 9, key: null, typed: "fo", lead: "" });
    expect(keysStarting("fo", "notes")).toEqual(["folder"]);
    expect(keysStarting("e", "notes")).toEqual(["edited-by", "editor"]);
    expect(keysStarting("d", "notes")).toEqual([]);
    expect(keysStarting("d", "todos")).toEqual(["due"]);
    expect(typingAt("is:ar", 5, "notes")).toEqual({ from: 3, to: 5, key: "is", typed: "ar", lead: "" });
    expect(typingAt("(-folder:Pro", 12, "notes")).toEqual({ from: 9, to: 12, key: "folder", typed: "Pro", lead: "" });
    expect(typingAt('folder:"Com', 11, "notes")).toEqual({ from: 7, to: 11, key: "folder", typed: "Com", lead: "" });
    expect(typingAt("due:>=to", 8, "todos")).toEqual({ from: 6, to: 8, key: "due", typed: "to", lead: ">=" });
    expect(typingAt("#mo", 3, "notes")).toEqual({ from: 0, to: 3, key: "tag", typed: "mo", lead: "#" });
    expect(typingAt("no:t", 4, "notes")).toEqual({ from: 3, to: 4, key: "has", typed: "t", lead: "" });
    expect(typingAt("budget", 3, "notes")).toBeNull();
    expect(typingAt("Budget", 6, "notes")).toBeNull();
    expect(typingAt("due:x", 5, "notes")).toBeNull();
  });

  it("counts a day from today", () => {
    expect(["today", "yesterday", "tomorrow", "7d", "+7d", "2026-01-01"].map((day) => dayOf(day, "2026-03-01"))).toEqual(["2026-03-01", "2026-02-28", "2026-03-02", "2026-02-22", "2026-03-08", "2026-01-01"]);
  });
});
