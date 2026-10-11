import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, type Actor } from "../../src/core/operations.ts";
import { matchOf, matchesIn, parseQuery } from "../../src/core/search.ts";
import { addMember, newMember } from "./members.ts";

const create = (by: Actor, text: string, now?: number) => perform(env.DB, by, { type: "note.create", text }, now);
const found = async (by: Actor, query: string, more: { includeArchived?: boolean } = {}) => (await perform(env.DB, by, { type: "search", query, ...more })).results.map((r) => r.note.title);

describe("a search as typed", () => {
  it("reads words, quoted phrases, tags and projects, and nothing else", () => {
    expect(parseQuery('budget "second quarter" #Money +Home')).toEqual({ terms: [["budget"], ["second", "quarter"]], tags: ["money"], projects: ["home"] });
    expect(parseQuery("foo-bar it's C++ a#b")).toEqual({ terms: [["foo", "bar"], ["it", "s"], ["C"], ["a", "b"]], tags: [], projects: [] });
    expect(parseQuery('"left open')).toEqual({ terms: [["left"], ["open"]], tags: [], projects: [] });
    expect(parseQuery('  "" # + * ( ) : ^ -  ')).toEqual({ terms: [], tags: [], projects: [] });
  });

  it("asks the index for quoted strings alone, whatever was typed", () => {
    const asked = (typed: string) => matchOf("abc123def456", parseQuery(typed).terms).replace('workspace : "abc123def456" AND {title text} : (', "").slice(0, -1);
    expect(matchOf('x" OR "y', [["a"]])).toBe('workspace : "xy" AND {title text} : ("a"*)');
    expect(asked('budget "second quarter"')).toBe('"budget"* "second quarter"*');
    expect(asked('a" OR "b NEAR(c) title:d NOT e* {x} ^f')).toBe('"a"* "OR"* "b"* "NEAR c"* "title d"* "NOT"* "e"* "x"* "f"*');
  });

  it("marks where each match is in a line, and cuts a long line around the first", () => {
    const query = parseQuery('milk "second quarter" #money +home');
    expect(matchesIn("# Budget\n\nBuy Milk and milkshakes\nthe second  quarter\n- [ ] pay +Home #money\nnothing", query)).toEqual([
      { line: 2, text: "Buy Milk and milkshakes", marks: [[4, 8], [13, 17]] },
      { line: 3, text: "the second  quarter", marks: [[4, 19]] },
      { line: 4, text: "- [ ] pay +Home #money", marks: [[10, 15], [16, 22]] },
    ]);
    const [long] = matchesIn(`${"x ".repeat(300)}milk ${"y ".repeat(300)}`, query);
    expect(long!.text).toHaveLength(200);
    expect(long!.text.slice(long!.marks[0]![0], long!.marks[0]![1])).toBe("milk");
  });
});

describe("search", () => {
  it("finds notes by words of their text, of a todo, of a tag and of a project, and by #tag and +project", async () => {
    const ada = await newMember();
    await create(ada, "# Budget\n\nThe second quarter was fine.\n\n- [ ] Call the bank +Finances #money");
    await create(ada, "# Recipes\n\nA quarter cup of milk, second to none.");

    expect(await found(ada, "quarter")).toEqual(["Recipes", "Budget"]);
    expect(await found(ada, "bank call")).toEqual(["Budget"]);
    expect(await found(ada, "money")).toEqual(["Budget"]);
    expect(await found(ada, "finances")).toEqual(["Budget"]);
    expect(await found(ada, "#money")).toEqual(["Budget"]);
    expect(await found(ada, "+finances")).toEqual(["Budget"]);
    expect(await found(ada, "quarter #money")).toEqual(["Budget"]);
    expect(await found(ada, "#money +nothing")).toEqual([]);
    expect(await found(ada, '"second quarter"')).toEqual(["Budget"]);
    expect(await found(ada, "quart mil")).toEqual(["Recipes"]);
    expect(await found(ada, "uarter")).toEqual([]);
    expect(await found(ada, "")).toEqual([]);
  });

  it("ignores case and accents, and answers each note with the lines that matched", async () => {
    const ada = await newMember();
    await create(ada, "# Café\n\nMeet at the CAFÉ on Main");

    expect(await found(ada, "cafe")).toEqual(["Café"]);
    const { results } = await perform(env.DB, ada, { type: "search", query: "MAIN meet" });
    expect(results).toMatchObject([{ note: { title: "Café", state: "live", access: "edit" }, matches: [{ line: 2, text: "Meet at the CAFÉ on Main", marks: [[0, 4], [20, 24]] }] }]);
  });

  it("puts notes whose title matches first, then the latest changed", async () => {
    const ada = await newMember();
    await create(ada, "# Plan for the garden\n\nbeds", 1000);
    await create(ada, "# Shopping\n\nfor the garden plan", 2000);
    await create(ada, "# Garden\n\nno p-word here, only a plan in the text", 3000);
    await create(ada, "# The plan\n\ngarden", 4000);

    expect(await found(ada, "plan")).toEqual(["The plan", "Plan for the garden", "Garden", "Shopping"]);
    expect(await found(ada, "garden plan")).toEqual(["Plan for the garden", "The plan", "Garden", "Shopping"]);
  });

  it("is never thrown by what is typed", async () => {
    const ada = await newMember();
    await create(ada, "# Note\n\nAND OR NOT NEAR title");
    for (const query of ['"', '""', "*", "a*", "(", "a AND", "NEAR(a b)", "title:x", "{title}: a", "^a", "a OR", '"a" OR "', "-a", "a:b", "#", "+", "#a#b", "\u0000", "'; DROP TABLE notes; --"]) {
      await expect(perform(env.DB, ada, { type: "search", query }), query).resolves.toBeDefined();
    }
    expect(await found(ada, "a AND")).toEqual(["Note"]);
    expect(await found(ada, "nothing OR note")).toEqual([]);
  });

  it("says nothing of a note the asker can't see: not in the results, their order, or how many there are", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const titled = (n: number) => `# Quarterly ${String(n).padStart(2, "0")}`;
    for (let i = 0; i < 3; i++) await create(ada, `${titled(i)}\n\nreport`, 1000 + i);
    const before = await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2 });

    for (let i = 0; i < 30; i++) {
      const secret = await create(eve, `# Quarterly report ${i}\n\nquarterly report quarterly report #hidden`, 5000 + i);
      await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
    }

    expect(await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2 })).toEqual(before);
    expect(before.results.map((r) => r.note.title)).toEqual(["Quarterly 02", "Quarterly 01"]);
    expect(before.next).toBe(2);
    expect((await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2, offset: 2 })).results.map((r) => r.note.title)).toEqual(["Quarterly 00"]);
    expect(await found(ada, "#hidden")).toEqual([]);
    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([]);
    expect((await perform(env.DB, eve, { type: "search", query: "#hidden", limit: 50 })).results).toHaveLength(30);
    expect((await perform(env.DB, eve, { type: "tag.list" })).tags).toEqual([{ name: "hidden", notes: 30 }]);
  });

  it("follows a note as its text changes, and finds notes written before there was anything to search", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Draft\n\nabout herons");
    expect(await found(ada, "herons")).toEqual(["Draft"]);

    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Draft\n\nabout egrets" });
    expect(await found(ada, "herons")).toEqual([]);
    expect(await found(ada, "egrets")).toEqual(["Draft"]);

    // As a note is that was last written before this was deployed: indexed for links and todos, and not for search.
    await env.DB.batch([env.DB.prepare("DELETE FROM note_search"), env.DB.prepare("DELETE FROM note_search_rows"), env.DB.prepare("UPDATE notes SET indexed = 1")]);
    expect(await found(ada, "egrets")).toEqual(["Draft"]);
    await perform(env.DB, ada, { type: "links.rebuild" });
    expect(await found(ada, "egrets")).toEqual(["Draft"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM note_search WHERE note_search MATCH 'egrets'").first()).toEqual({ n: 1 });
  });

  it("finds nothing of another workspace's notes, whose words and whose workspace id it is asked for", async () => {
    const ada = await newMember();
    const bob = await newMember("Bob");
    await create(bob, `# Bob's herons\n\n${ada.workspaceId} herons`);
    await create(ada, "# Ada's herons\n\nherons");

    expect(await found(ada, "herons")).toEqual(["Ada's herons"]);
    expect(await found(ada, ada.workspaceId)).toEqual([]);
    expect(await found(ada, bob.workspaceId)).toEqual([]);
    expect(await found(bob, "herons")).toEqual(["Bob's herons"]);
  });

  it("says so while a large workspace is still being read into the index, and reads more each time it is asked", async () => {
    const ada = await newMember();
    for (let i = 0; i < 310; i++) await create(ada, `# Note ${i}\n\nherons #bird`);
    await env.DB.batch([env.DB.prepare("DELETE FROM note_search"), env.DB.prepare("DELETE FROM note_tags"), env.DB.prepare("UPDATE notes SET indexed = 1")]);
    const search = () => perform(env.DB, ada, { type: "search", query: "herons", limit: 1 });

    expect(await search()).toMatchObject({ indexing: true });
    expect(await perform(env.DB, ada, { type: "tag.list" })).toEqual({ tags: [{ name: "bird", notes: 310 }], indexing: false });
    expect(await search()).toMatchObject({ indexing: false, next: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM note_search").first()).toEqual({ n: 310 });
  });

  it("lists the notes under a tag, ignoring case, and counts each tag once a note", async () => {
    const ada = await newMember();
    await create(ada, "# One\n\n#Money and #money again\n- [ ] pay #bills");
    await create(ada, "# Two\n\n#money");

    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([{ name: "bills", notes: 1 }, { name: "Money", notes: 2 }]);
    expect((await perform(env.DB, ada, { type: "note.list", tag: "MONEY" })).map((n) => n.title).sort()).toEqual(["One", "Two"]);
    expect((await perform(env.DB, ada, { type: "note.list", tag: "bills" })).map((n) => n.title)).toEqual(["One"]);
    expect(await perform(env.DB, ada, { type: "note.list", tag: "none" })).toEqual([]);
  });
});
