import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { binder, perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import { MAX_DEPTH, MAX_TERMS, parse, walk } from "../../src/core/query.ts";
import { addMember, newMember } from "./members.ts";

/*
 * Each filter of the query language, asked of real notes through `search` and `todo.list`: what it
 * finds, in what order, and what it is refused for. Who may be told what is access-matrix.test.ts's.
 */

const at = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
type More<K extends "search" | "todo.list"> = Omit<Partial<Extract<OpInput, { type: K }>>, "type" | "query">;
const titles = async (by: Actor, query: string, more: More<"search"> = {}) => (await perform(env.DB, by, { type: "search", query, limit: 50, ...more })).results.map((r) => r.note.title);
const todos = async (by: Actor, query: string, more: More<"todo.list"> = {}) => (await perform(env.DB, by, { type: "todo.list", query, ...more })).todos.map((t) => t.words);
const refusal = (run: Promise<unknown>) => run.then(() => "answered", (err: unknown) => (err instanceof OpError ? `${err.code}: ${err.message}` : Promise.reject(err)));

async function library() {
  const ada = await newMember("Ada Lovelace");
  const grace = await addMember(ada, "editor", "Grace Hopper");
  const scribe = await connectAgent(env.DB, ada.personId, "Scribe");
  const asScribe: Actor = { kind: "agent", agentId: scribe.agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
  const folder = async (name: string, parentId?: string) => (await perform(env.DB, ada, { type: "folder.create", name, parentId })).id;
  const work = await folder("Common Ink");
  const plans = await folder("Plans", work);
  const home = await folder("Home");
  const note = (by: Actor, folderId: string | undefined, text: string, day: string, time?: string) => perform(env.DB, by, { type: "note.create", folderId, text }, at(day, time));
  const budget = await note(ada, work, "# Budget\n\nThe second quarter #money\n\n- [ ] !! Call the bank due:2026-10-05 #urgent\n- [x] File taxes due:2026-09-01", "2026-10-01", "23:30");
  const roadmap = await note(ada, plans, `# Roadmap\n\nSee [[${budget.id}]] for the budget plan.\n\n- [ ] !!! Ship the plan due:2026-10-20 every:1w\n- [ ] Tidy the roadmap`, "2026-10-02", "00:30");
  const recipes = await note(grace, home, "# Recipes\n\nA quarter cup of milk #food\n\n- [x] Buy milk", "2026-10-03");
  const diary = await note(asScribe, home, "# Diary\n\nNothing planned.", "2026-10-04");
  const old = await note(ada, undefined, "# Old budget\n\nLast year's second budget.\n\n- [ ] ! Shred it", "2026-10-05");
  const gone = await note(ada, undefined, "# Scrapped budget\n\nNever mind.", "2026-10-06");
  await perform(env.DB, grace, { type: "note.write", id: budget.id, baseRevision: 1, text: `${budget.text}\n\nGrace's line.` }, at("2026-10-10"));
  await perform(env.DB, asScribe, { type: "note.write", id: recipes.id, baseRevision: 1, text: `${recipes.text}\n\nScribe's line.` }, at("2026-10-11"));
  await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
  await perform(env.DB, ada, { type: "note.trash", id: gone.id });
  await perform(env.DB, ada, { type: "note.setPrivate", id: diary.id, private: true }).catch(() => undefined);
  await perform(env.DB, ada, { type: "grant.link", noteId: roadmap.id, link: "public" });
  return { ada, grace, asScribe, work, plans, home, budget, roadmap, recipes, diary, old, gone };
}

/** Eight groups, each the first term of the one around it, by turns a NOT of an AND and an OR: forty terms, filters and words. */
const DEEPEST = [..."abcdefgh"].reduce((inner, name, level) => {
  if (level % 2) return `(${inner}${inner && " OR "}${name} OR 9)`;
  return `-(${inner} #${name} #${name}a #${name}b ${name} 5 6 7 8)`;
}, "");

describe("search, by each filter", () => {
  it("narrows by folder with the folders inside it, by tag, and by who changed or first wrote a note", async () => {
    const w = await library();
    const { ada } = w;
    expect((await titles(ada, 'folder:"Common Ink"')).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, 'folder:"common ink" -folder:Plans')).toEqual(["Budget"]);
    expect(await titles(ada, `folder:${w.plans}`)).toEqual(["Roadmap"]);
    expect(await titles(ada, "folder:Unsorted is:archived")).toEqual(["Old budget"]);
    expect((await titles(ada, "folder:Home OR folder:Plans")).sort()).toEqual(["Diary", "Recipes", "Roadmap"]);
    // The old field is the folder's own notes; the query's filter takes in the folders under it. Together they are both.
    expect(await titles(ada, 'folder:"Common Ink"', { folderId: w.plans })).toEqual(["Roadmap"]);
    expect(await titles(ada, "budget", { folderId: w.work })).toEqual(["Budget"]);
    expect(await refusal(titles(ada, "folder:Nowhere"))).toBe('invalid: No folder named "Nowhere"');
    // Two folders of one name are both meant.
    const other = (await perform(env.DB, ada, { type: "folder.create", name: "Plans", parentId: w.home })).id;
    await perform(env.DB, ada, { type: "note.create", folderId: other, text: "# Holiday" });
    expect((await titles(ada, "folder:Plans")).sort()).toEqual(["Holiday", "Roadmap"]);

    expect(await titles(ada, "tag:money")).toEqual(["Budget"]);
    expect((await titles(ada, "#FOOD OR #urgent")).sort()).toEqual(["Budget", "Recipes"]);
    expect((await titles(ada, "has:tag")).sort()).toEqual(["Budget", "Recipes"]);

    expect((await titles(ada, 'editor:"Grace Hopper"')).sort()).toEqual(["Budget", "Recipes"]);
    expect(await titles(ada, 'author:"grace hopper"')).toEqual(["Recipes"]);
    expect((await titles(ada, "editor:Scribe")).sort()).toEqual(["Diary", "Recipes"]);
    expect(await titles(ada, "author:Scribe")).toEqual(["Diary"]);
    expect((await titles(ada, "editor:@me")).sort()).toEqual(["Budget", "Holiday", "Roadmap"]);
    expect((await titles(w.asScribe, "edited-by:@me")).sort()).toEqual(["Diary", "Recipes"]);
    expect((await titles(w.grace, "author:@me -editor:Scribe"))).toEqual([]);
    expect(await titles(ada, 'editor:"Grace Hopper" -author:"Ada Lovelace"')).toEqual(["Recipes"]);
    expect(await refusal(titles(ada, "editor:Nobody"))).toBe('invalid: Nobody named "Nobody" has changed a note you can see');
  });

  it("reads a day where the asker says they are, and counts one from the today they say", async () => {
    const { ada } = await library();
    // Budget was made at 23:30 UTC on the 1st and Roadmap an hour later: one day apart in UTC, the same day east and west of it.
    expect(await titles(ada, "created:2026-10-01")).toEqual(["Budget"]);
    expect(await titles(ada, "created:2026-10-01", { zone: "UTC" })).toEqual(["Budget"]);
    expect((await titles(ada, "created:2026-10-01", { zone: "America/New_York" })).sort()).toEqual(["Budget", "Roadmap"]);
    expect((await titles(ada, "created:2026-10-02", { zone: "Asia/Tokyo" })).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "created:2026-10-01", { zone: "Asia/Tokyo" })).toEqual([]);
    // With no zone said, it is the one the member's settings name.
    await perform(env.DB, ada, { type: "settings.write", text: JSON.stringify({ "daily.timeZone": "Asia/Tokyo" }), baseRevision: 0 });
    expect((await titles(ada, "created:2026-10-02")).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "created:2026-10-02", { zone: "UTC" })).toEqual(["Roadmap"]);

    const utc = { zone: "UTC" } as const;
    expect((await titles(ada, "created:>2026-10-02", utc)).sort()).toEqual(["Diary", "Recipes"]);
    expect((await titles(ada, "created:>=2026-10-02", utc)).sort()).toEqual(["Diary", "Recipes", "Roadmap"]);
    expect(await titles(ada, "created:<2026-10-02", utc)).toEqual(["Budget"]);
    expect((await titles(ada, "created:<=2026-10-02", utc)).sort()).toEqual(["Budget", "Roadmap"]);
    expect((await titles(ada, "created:2026-10-02..2026-10-03", utc)).sort()).toEqual(["Recipes", "Roadmap"]);
    expect((await titles(ada, "created:*..2026-10-02", utc)).sort()).toEqual(["Budget", "Roadmap"]);
    expect((await titles(ada, "updated:>=2026-10-10", utc)).sort()).toEqual(["Budget", "Recipes"]);
    expect(await titles(ada, "updated:2026-10-10 created:2026-10-01", utc)).toEqual(["Budget"]);
    expect((await titles(ada, "-updated:>=2026-10-10", utc)).sort()).toEqual(["Diary", "Roadmap"]);

    const today = { ...utc, today: "2026-10-11" };
    expect(await titles(ada, "updated:today", today)).toEqual(["Recipes"]);
    expect(await titles(ada, "updated:yesterday", today)).toEqual(["Budget"]);
    expect((await titles(ada, "updated:>=1d", today)).sort()).toEqual(["Budget", "Recipes"]);
    expect((await titles(ada, "created:>=9d created:<tomorrow", today)).sort()).toEqual(["Diary", "Recipes", "Roadmap"]);
    expect(await titles(ada, "created:+1d..+7d", today)).toEqual([]);
    expect(await refusal(titles(ada, "updated:today"))).toBe('invalid: "today" is counted from today, and the server doesn\'t know your day: pass today, as YYYY-MM-DD');
    expect(await refusal(titles(ada, "updated:2026-10-01..7d"))).toMatch(/^invalid: "7d" is counted from today/);
    expect(await refusal(perform(env.DB, ada, { type: "search", query: "a", zone: "Mars/Olympus" }))).toMatch(/^invalid: .*not a time zone/s);
    expect(await refusal(perform(env.DB, ada, { type: "search", query: "a", today: "tomorrow" }))).toMatch(/^invalid: .*not a date/s);
  });

  it("narrows by state, and covers archived notes and Trash only when the query names them", async () => {
    const w = await library();
    const { ada } = w;
    expect((await titles(ada, "budget")).sort()).toEqual(["Budget", "Roadmap"]);
    expect((await titles(ada, "budget is:open")).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "budget is:archived")).toEqual(["Old budget"]);
    expect((await titles(ada, "budget (is:open OR is:archived)")).sort()).toEqual(["Budget", "Old budget", "Roadmap"]);
    expect((await titles(ada, "budget -is:archived")).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "budget is:trashed")).toEqual(["Scrapped budget"]);
    expect((await titles(ada, "budget -is:trashed")).sort()).toEqual(["Budget", "Old budget", "Roadmap"]);
    // The old field says the same as the query, and both together are both.
    expect((await titles(ada, "budget", { includeArchived: true })).sort()).toEqual(["Budget", "Old budget", "Roadmap"]);
    expect(await titles(ada, "budget", { includeArchived: "only" })).toEqual(["Old budget"]);
    expect(await titles(ada, "budget is:open", { includeArchived: "only" })).toEqual([]);

    expect(await titles(ada, "is:shared")).toEqual(["Roadmap"]);
    expect(await titles(w.asScribe, "is:shared")).toEqual([]);
    expect((await titles(ada, "is:private")).length).toBeLessThanOrEqual(1);
    expect((await titles(ada, "has:todo")).sort()).toEqual(["Budget", "Recipes", "Roadmap"]);
    expect((await titles(ada, "has:open-todo")).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "has:todo no:open-todo")).toEqual(["Recipes"]);
    expect(await titles(ada, "no:todo")).toEqual(["Diary"]);
    expect(await titles(ada, "has:link")).toEqual(["Roadmap"]);
    expect(await titles(ada, "has:backlink")).toEqual(["Budget"]);
    expect((await titles(ada, "no:link no:backlink")).sort()).toEqual(["Diary", "Recipes"]);
    expect((await titles(ada, "quarter", { hasTodos: true }))).toEqual(["Budget"]);
  });

  it("combines words and filters with OR, NOT and groups, looks where in: says, and orders as sort: says", async () => {
    const { ada } = await library();
    expect((await titles(ada, "milk OR bank")).sort()).toEqual(["Budget", "Recipes"]);
    expect(await titles(ada, "quarter -milk")).toEqual(["Budget"]);
    expect(await titles(ada, "quarter NOT milk")).toEqual(["Budget"]);
    expect((await titles(ada, "(milk OR bank) quarter")).sort()).toEqual(["Budget", "Recipes"]);
    expect(await titles(ada, "(milk OR bank) -(quarter cup)")).toEqual(["Budget"]);
    expect(await titles(ada, 'NOT (milk OR bank OR "nothing planned")')).toEqual(["Roadmap"]);
    expect(await titles(ada, "milk OR bank #food")).toEqual(["Recipes"]);
    expect(await titles(ada, "milk OR (bank #food)")).toEqual(["Recipes"]);
    expect(await titles(ada, "(milk OR bank) #food")).toEqual(["Recipes"]);

    expect((await titles(ada, "budget in:title")).sort()).toEqual(["Budget"]);
    // The note's text has its heading in it, so a word of the title is in the body too.
    expect((await titles(ada, "budget in:body")).sort()).toEqual(["Budget", "Roadmap"]);
    expect(await titles(ada, "plan in:body")).toEqual(["Diary", "Roadmap"]);
    expect(await titles(ada, "plan in:title")).toEqual([]);
    expect((await titles(ada, "budget OR roadmap in:title in:body")).sort()).toEqual(["Budget", "Roadmap"]);

    // By its match: a title's match first, then the latest changed. The query's own sort: wins over the old field.
    expect(await titles(ada, "quarter OR roadmap OR diary")).toEqual(["Recipes", "Budget", "Diary", "Roadmap"]);
    expect(await titles(ada, "plan")).toEqual(["Diary", "Roadmap"]);
    expect(await titles(ada, "roadmap OR tidy")).toEqual(["Roadmap"]);
    expect(await titles(ada, "second")).toEqual(["Budget"]);
    expect(await titles(ada, "is:open sort:title-asc")).toEqual(["Budget", "Diary", "Recipes", "Roadmap"]);
    expect(await titles(ada, "is:open sort:title-desc")).toEqual(["Roadmap", "Recipes", "Diary", "Budget"]);
    expect(await titles(ada, "is:open sort:created-asc")).toEqual(["Budget", "Roadmap", "Recipes", "Diary"]);
    expect(await titles(ada, "is:open sort:created-desc")).toEqual(["Diary", "Recipes", "Roadmap", "Budget"]);
    expect(await titles(ada, "is:open sort:updated-desc")).toEqual(["Recipes", "Budget", "Diary", "Roadmap"]);
    expect(await titles(ada, "is:open sort:updated-asc")).toEqual(["Roadmap", "Diary", "Budget", "Recipes"]);
    expect(await titles(ada, "is:open sort:title-desc", { sort: "created" })).toEqual(["Roadmap", "Recipes", "Diary", "Budget"]);
    expect(await titles(ada, "is:open", { sort: "title" })).toEqual(["Budget", "Diary", "Recipes", "Roadmap"]);

    // A page at a time, in the order asked for.
    const first = await perform(env.DB, ada, { type: "search", query: "is:open sort:title-asc", limit: 3 });
    expect([first.results.map((r) => r.note.title), first.next]).toEqual([["Budget", "Diary", "Recipes"], 3]);
    const second = await perform(env.DB, ada, { type: "search", query: "is:open sort:title-asc", limit: 3, offset: 3 });
    expect([second.results.map((r) => r.note.title), second.next]).toEqual([["Roadmap"], null]);
    // Nothing asked finds nothing, as it always has: a list of every note is note.list's.
    expect(await titles(ada, "sort:title-asc")).toEqual([]);
    expect(await titles(ada, "", { hasTodos: true })).toEqual([]);
  });

  it("answers the largest query it reads, and says where one it can't read goes wrong", async () => {
    const w = await library();
    const { ada } = w;
    const many = (word: string, between: string) => Array.from({ length: MAX_TERMS }, () => word).join(between);
    expect((await titles(ada, many("q", " OR "))).sort()).toEqual(["Budget", "Recipes"]);
    expect((await titles(ada, many("q", " "))).sort()).toEqual(["Budget", "Recipes"]);
    expect((await titles(ada, many("-z", " "))).sort()).toEqual(["Budget", "Diary", "Recipes", "Roadmap"]);
    expect((await titles(ada, `${Array.from({ length: 6 }, () => "updated:2026-10-01..2026-10-30").join(" ")} b`, { hasTodos: true, includeArchived: true, zone: "UTC" })).sort()).toEqual(["Budget", "Old budget", "Roadmap"]);
    expect(await todos(ada, many("t", " OR "), { includeCompleted: true, includeArchived: true, tag: "money", dueFrom: "2026-01-01", dueTo: "2026-12-31", importance: [0, 1, 2, 3], noDue: false })).toEqual(["Call the bank #urgent", "File taxes"]);
    expect(await todos(ada, Array.from({ length: 7 }, () => "due:2026-10-01..2026-10-30").join(" "))).toEqual(["Call the bank #urgent", "Ship the plan"]);

    // No word said twice, so no value is bound once for two of them, with every old field of each listing set.
    const WORDS = [..."abcdefghijklmnopqrstuvwxyz0123456789αβγδ"];
    const { work, budget } = w;
    const every = { folderId: work, tag: "money", dueFrom: "2026-01-01", dueTo: "2026-12-31", importance: [0, 1, 2, 3] as (0 | 1 | 2 | 3)[], noteId: budget.id, includeCompleted: true, includeArchived: true } as const;
    for (const typed of [`${WORDS.slice(0, 36).join(" OR ")} in:title in:body`, WORDS.join(" OR "), WORDS.map((word) => `-${word}`).join(" "), `${WORDS.slice(0, 38).map((word) => `-${word}`).join(" ")} in:title in:body`]) {
      expect(await refusal(todos(ada, typed, every)), typed).toBe("answered");
      expect(await refusal(titles(ada, typed, { folderId: work, hasTodos: true, includeArchived: true, sort: "match" })), typed).toBe("answered");
    }
    expect(await todos(ada, `${WORDS.slice(0, 36).join(" OR ")} in:title in:body`, every)).toEqual(["Call the bank #urgent", "File taxes"]);
    expect(await titles(ada, WORDS.join(" OR "), { folderId: work, hasTodos: true, includeArchived: true, sort: "match" })).toEqual(["Budget"]);

    // The deepest tree the limits allow, forty terms of it: SQLite takes an expression a hundred deep.
    const deepest = DEEPEST;
    const read = parse(DEEPEST, "todos");
    expect(read.ok && [...walk(read.query.where)].filter(({ node }) => node.kind === "text" || node.kind === "filter").length).toBe(MAX_TERMS);
    expect(DEEPEST.match(/\(/g)!.length).toBe(MAX_DEPTH);
    expect(await refusal(titles(ada, deepest))).toBe("answered");
    expect(await refusal(todos(ada, deepest, every))).toBe("answered");
    expect((await titles(ada, deepest)).sort()).toEqual(["Budget", "Diary", "Recipes", "Roadmap"]);
    for (const typed of [`${"-".repeat(120)}budget`, `${"NOT ".repeat(48)}budget`]) expect((await titles(ada, typed)).sort(), typed).toEqual(["Budget", "Roadmap"]);
    expect(await todos(ada, `${"-".repeat(121)}bank`)).toEqual(["Ship the plan", "Tidy the roadmap"]);

    const bind = binder([1, 2]);
    expect([bind("a"), bind("b"), bind("a"), bind(2), bind("2")]).toEqual(["?3", "?4", "?3", "?2", "?5"]);
    for (let i = 0; i < 95; i++) bind(`v${i}`);
    expect(bind("a")).toBe("?3");
    expect(() => bind("one more")).toThrow(new OpError("invalid", "This query asks for more than the 100 values a search can take: say it in fewer terms"));

    expect(await refusal(titles(ada, "created:>9999-12-31", { zone: "UTC" }))).toBe("answered");
    expect(await titles(ada, "created:>9999-12-31", { zone: "UTC" })).toEqual([]);
    expect((await titles(ada, "created:<=9999-12-31", { zone: "UTC" })).length).toBe(4);
    expect(await refusal(titles(ada, "budget OR ()"))).toBe("invalid: These parentheses have nothing in them (characters 11 to 12 of the query: ())");

    expect(await refusal(titles(ada, "budget titel:x"))).toBe('invalid: There is no filter "titel:". To search for the words, put them in quotes (characters 8 to 13 of the query: titel:)');
    expect(await refusal(titles(ada, "is:opne"))).toBe('invalid: is: doesn\'t take "opne". Did you mean open? (characters 4 to 7 of the query: opne)');
    expect(await refusal(titles(ada, "due:today"))).toBe("invalid: due: is for todos, and this is a search of notes (characters 1 to 9 of the query: due:today)");
    expect(await refusal(todos(ada, "has:todo"))).toBe("invalid: has:todo is for notes, and this is a search of todos (characters 5 to 8 of the query: todo)");
    expect(await refusal(todos(ada, "(a"))).toBe("invalid: This ( is never closed (characters 1 to 1 of the query: ()");
  });
});

describe("todo.list, by each filter", () => {
  it("lists open todos until the query names done ones, and narrows by what a todo is", async () => {
    const w = await library();
    const { ada } = w;
    const OPEN = ["Call the bank #urgent", "Ship the plan", "Tidy the roadmap"];
    expect(await todos(ada, "")).toEqual(OPEN);
    expect(await todos(ada, "is:open")).toEqual(OPEN);
    expect(await todos(ada, "is:done")).toEqual(["File taxes", "Buy milk"]);
    expect(await todos(ada, "is:open OR is:done")).toEqual([...OPEN, "File taxes", "Buy milk"]);
    expect(await todos(ada, "-is:done")).toEqual([...OPEN]);
    // Only a query that says nothing of whether a todo is done is of the open ones alone.
    expect(await todos(ada, "-is:open")).toEqual(["File taxes", "Buy milk"]);
    expect(await todos(ada, "NOT is:open")).toEqual(["File taxes", "Buy milk"]);
    expect(await todos(ada, "-is:open is:archived")).toEqual([]);
    expect(await todos(ada, "", { includeCompleted: true })).toEqual([...OPEN, "File taxes", "Buy milk"]);
    expect(await todos(ada, "is:done", { includeCompleted: true })).toEqual(["File taxes", "Buy milk"]);
    expect(await todos(ada, "is:archived")).toEqual(["Shred it"]);
    expect(await todos(ada, "", { includeArchived: true })).toEqual(["Call the bank #urgent", "Ship the plan", "Shred it", "Tidy the roadmap"]);

    const today = { today: "2026-10-10" };
    expect(await todos(ada, "due:<today", today)).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "due:<today is:open OR is:done due:<today", today)).toEqual(["Call the bank #urgent", "File taxes"]);
    expect(await todos(ada, "due:>=today", today)).toEqual(["Ship the plan"]);
    expect(await todos(ada, "due:today..+10d", today)).toEqual(["Ship the plan"]);
    expect(await todos(ada, "due:2026-10-05")).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "due:5d", today)).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "due:2026-10-05..2026-10-20")).toEqual(["Call the bank #urgent", "Ship the plan"]);
    expect(await todos(ada, "due:>2026-10-05")).toEqual(["Ship the plan"]);
    expect(await todos(ada, "due:<=2026-10-05")).toEqual(["Call the bank #urgent"]);
    // What is not overdue takes in what has no due date.
    expect(await todos(ada, "-due:<today", today)).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "has:due")).toEqual(["Call the bank #urgent", "Ship the plan"]);
    expect(await todos(ada, "no:due")).toEqual(["Tidy the roadmap"]);
    expect(await todos(ada, "-has:due is:archived")).toEqual(["Shred it"]);
    expect(await refusal(todos(ada, "due:<today"))).toMatch(/^invalid: "today" is counted from today/);

    expect(await todos(ada, "importance:>=2")).toEqual(["Call the bank #urgent", "Ship the plan"]);
    expect(await todos(ada, "importance:3")).toEqual(["Ship the plan"]);
    expect(await todos(ada, "importance:0")).toEqual(["Tidy the roadmap"]);
    expect(await todos(ada, "importance:<2")).toEqual(["Tidy the roadmap"]);
    expect(await todos(ada, "importance:1..2 (is:archived OR is:open)")).toEqual(["Call the bank #urgent", "Shred it"]);
    expect(await todos(ada, "has:repeat")).toEqual(["Ship the plan"]);
    expect(await todos(ada, "no:repeat")).toEqual(["Call the bank #urgent", "Tidy the roadmap"]);
  });

  it("looks for words in the todo's own line, or with in:title in its note's title, and narrows by what its note is", async () => {
    const w = await library();
    const { ada } = w;
    expect(await todos(ada, "bank")).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "roadmap")).toEqual(["Tidy the roadmap"]);
    // A word of the note that isn't on the todo's line doesn't find the todo.
    expect(await todos(ada, "quarter")).toEqual([]);
    expect(await todos(ada, "budget")).toEqual([]);
    expect(await todos(ada, "budget in:title")).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "roadmap in:title")).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "plan OR bank")).toEqual(["Call the bank #urgent", "Ship the plan"]);
    expect(await todos(ada, "-plan -bank")).toEqual(["Tidy the roadmap"]);
    expect(await todos(ada, '"the plan"')).toEqual(["Ship the plan"]);
    expect(await todos(ada, "ship plan -bank")).toEqual(["Ship the plan"]);

    expect(await todos(ada, 'folder:"Common Ink"')).toEqual(["Call the bank #urgent", "Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "folder:Plans")).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "", { folderId: w.work })).toEqual(["Call the bank #urgent", "Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "folder:Plans", { folderId: w.work })).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "tag:money")).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "#food is:done")).toEqual(["Buy milk"]);
    expect(await todos(ada, 'editor:"Grace Hopper"')).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "author:@me has:link")).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "has:backlink")).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "is:shared")).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "created:2026-10-01", { zone: "UTC" })).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "", { noteId: w.roadmap.id })).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "plan", { noteId: w.roadmap.id })).toEqual(["Ship the plan"]);
    expect(await todos(ada, "", { importance: [2] })).toEqual(["Call the bank #urgent"]);
    expect(await todos(ada, "", { importance: [0, 3] })).toEqual(["Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "", { noDue: true })).toEqual(["Tidy the roadmap"]);

    expect(await todos(ada, "sort:due-desc")).toEqual(["Ship the plan", "Call the bank #urgent", "Tidy the roadmap"]);
    expect(await todos(ada, "sort:due-asc")).toEqual(["Call the bank #urgent", "Ship the plan", "Tidy the roadmap"]);
    expect(await todos(ada, "sort:importance-desc")).toEqual(["Ship the plan", "Call the bank #urgent", "Tidy the roadmap"]);
    expect(await todos(ada, "sort:title-desc")).toEqual(["Ship the plan", "Tidy the roadmap", "Call the bank #urgent"]);
    const first = await perform(env.DB, ada, { type: "todo.list", query: "sort:due-asc", limit: 2 });
    expect([first.todos.map((t) => t.words), first.next]).toEqual([["Call the bank #urgent", "Ship the plan"], 2]);

    // A todo's words are found as a note's are: by their starts, whatever their case or accents.
    await perform(env.DB, ada, { type: "note.create", text: "# Shopping\n\n- [ ] Buy Éclair and café\n- [ ] Replant\n- [ ] Plant B" });
    for (const typed of ["éclair", "eclair", "ECLAIR", "cafe", "Café", "ecl", "buy eclair", '"éclair and"', "eclair in:title in:body"]) expect(await todos(ada, typed), typed).toEqual(["Buy Éclair and café"]);
    expect(await titles(ada, "eclair cafe")).toEqual(["Shopping"]);
    expect(await todos(ada, "lair")).toEqual([]);
    expect(await todos(ada, "plant")).toEqual(["Plant B"]);
    expect(await todos(ada, "-eclair (replant OR plant)")).toEqual(["Replant", "Plant B"]);
  });

  it("knows which todos recur from the index, and of a note indexed before it could say so once the note is read in again", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Chores\n\n- [ ] Water plants every:3d\n- [ ] Read the docs on `every:2w`\n- [ ] Sweep" });
    expect(await todos(ada, "has:repeat")).toEqual(["Water plants"]);
    // As the migration leaves a line it can't read the rule of: marked by the look of it, until the note is read in again.
    await env.DB.batch([env.DB.prepare("UPDATE todos SET recurs = text LIKE '% every:%' WHERE note_id = ?").bind(note.id), env.DB.prepare("UPDATE notes SET indexed = 3 WHERE id = ?").bind(note.id)]);
    expect(await todos(ada, "has:repeat")).toEqual(["Water plants"]);
    expect((await env.DB.prepare("SELECT indexed FROM notes WHERE id = ?").bind(note.id).first<{ indexed: number }>())!.indexed).toBe(4);
    await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 4, text: "- [ ] Sweep", every: "1w" });
    expect((await todos(ada, "has:repeat")).sort()).toEqual(["Sweep", "Water plants"]);

    // And a line's words, which the migration can only put in small letters: an accent is found once the note is read in again.
    const menu = await perform(env.DB, ada, { type: "note.create", text: "# Menu\n\n- [ ] Order Crème brûlée" });
    await env.DB.batch([env.DB.prepare("UPDATE todos SET words = ' ' || lower(text) WHERE note_id = ?").bind(menu.id), env.DB.prepare("UPDATE notes SET indexed = 3 WHERE id = ?").bind(menu.id)]);
    expect(await todos(ada, "creme brulee")).toEqual(["Order Crème brûlée"]);
    expect((await env.DB.prepare("SELECT words FROM todos WHERE note_id = ?").bind(menu.id).first<{ words: string }>())!.words).toBe(" order creme brulee");
  });
});
