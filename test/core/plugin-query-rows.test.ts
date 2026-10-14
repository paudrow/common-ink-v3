import { describe, expect, it } from "vitest";
import { parseQuery } from "../../src/web/plugin-api.ts";
import { builderReducer, builtOf, filled, readBuilder, termOf, type BuilderEvent, type Row } from "../../src/web/plugins/lib/queryRows.ts";

const row = (key: Row["key"], value: string, more: Partial<Row> = {}): Row => ({ key, not: false, cmp: "=", value, ...more });
const read = (text: string, scope: "notes" | "todos" = "notes") => {
  const parsed = parseQuery(text, scope);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return builtOf(parsed.query);
};
const after = (text: string, events: BuilderEvent[], scope: "notes" | "todos" = "notes") => events.reduce(builderReducer, readBuilder(scope, text));

describe("the builder's rows", () => {
  it("are a flat query laid out: words and filters, as they are or negated, all of them or any", () => {
    expect(read("")).toEqual({ rows: [], match: "all", in: [], sort: null });
    expect(read('budget "second quarter" -draft')).toEqual({ rows: [row("text", "budget"), row("text", "second quarter"), row("text", "draft", { not: true })], match: "all", in: [], sort: null });
    expect(read("folder:Plans -tag:money no:todo updated:>=7d created:2026-10-01..2026-10-14 sort:title-asc in:title")).toEqual({
      rows: [row("folder", "Plans"), row("tag", "money", { not: true }), row("has", "todo", { not: true }), row("updated", "7d", { cmp: ">=" }), row("created", "2026-10-01", { to: "2026-10-14" })],
      match: "all",
      in: ["title"],
      sort: "title-asc",
    });
    expect(read("is:archived OR #money OR budget")).toEqual({ rows: [row("is", "archived"), row("tag", "money"), row("text", "budget")], match: "any", in: [], sort: null });
    expect(read("due:<today importance:>=2", "todos")?.rows).toEqual([row("due", "today", { cmp: "<" }), row("importance", "2", { cmp: ">=" })]);
  });

  it("can't say a group inside a group, AND with OR, or a NOT of more than one thing", () => {
    for (const text of ["a (b OR c)", "a b OR c", "NOT (a OR b)"]) expect(read(text), text).toBeNull();
    // A NOT of a NOT is what is under both, which is a row.
    expect(read("NOT NOT a -no:link")?.rows).toEqual([row("text", "a"), row("has", "link")]);
  });

  it("write the query's text on every change, and keep a row that isn't filled in yet out of it", () => {
    let builder = after("budget", [{ type: "add" }]);
    expect(builder.text).toBe("budget");
    expect(builder.built!.rows).toEqual([row("text", "budget"), row("text", "")]);
    builder = builderReducer(builder, { type: "set", at: 1, row: row("folder", "") });
    expect(builder.text).toBe("budget");
    builder = builderReducer(builder, { type: "set", at: 1, row: row("folder", "Common Ink") });
    expect(builder.text).toBe('budget folder:"Common Ink"');
    builder = builderReducer(builder, { type: "set", at: 1, row: row("folder", "Common Ink", { not: true }) });
    expect(builder.text).toBe('budget -folder:"Common Ink"');
    builder = builderReducer(builder, { type: "match", match: "any" });
    expect(builder.text).toBe('budget OR -folder:"Common Ink"');
    builder = builderReducer(builder, { type: "sort", sort: "updated-asc" });
    builder = builderReducer(builder, { type: "in", in: ["title"] });
    expect(builder.text).toBe('budget OR -folder:"Common Ink" in:title sort:updated-asc');
    builder = builderReducer(builder, { type: "remove", at: 0 });
    expect(builder.text).toBe('-folder:"Common Ink" in:title sort:updated-asc');
    expect(after("", [{ type: "add" }, { type: "set", at: 0, row: row("has", "todo", { not: true }) }]).text).toBe("no:todo");
    expect(after("", [{ type: "add" }, { type: "set", at: 0, row: row("text", "second quarter") }]).text).toBe('"second quarter"');
  });

  it("hold a value the language can't read as a row still being filled in, and never write it", () => {
    expect(filled(row("updated", "2026-10"), "notes")).toBe(false);
    expect(filled(row("updated", "2026-10-01"), "notes")).toBe(true);
    expect(filled(row("updated", "2026-10-01", { to: "" }), "notes")).toBe(false);
    expect(filled(row("importance", "9"), "todos")).toBe(false);
    expect(filled(row("due", "today"), "notes")).toBe(false);
    expect(filled(row("tag", "not a tag"), "notes")).toBe(false);
    expect(filled(row("text", "+++"), "notes")).toBe(false);
    const builder = after("budget", [{ type: "add" }, { type: "set", at: 1, row: row("updated", "2026-1", { cmp: ">=" }) }]);
    expect(builder.text).toBe("budget");
    expect(builderReducer(builder, { type: "set", at: 1, row: row("updated", "2026-10-01", { cmp: ">=" }) }).text).toBe("budget updated:>=2026-10-01");
  });

  it("read a row's value as the language reads it typed: a tag or a day in capitals, a tag with its #, a word that is an operator's", () => {
    const set = (to: Row, scope: "notes" | "todos" = "notes") => after("", [{ type: "add" }, { type: "set", at: 0, row: to }], scope);
    expect(set(row("tag", "Money")).text).toBe("tag:money");
    expect(set(row("tag", "#Money")).text).toBe("tag:money");
    expect(set(row("tag", "#money", { not: true })).text).toBe("-tag:money");
    expect(set(row("due", "Today", { cmp: "<" }), "todos").text).toBe("due:<today");
    expect(set(row("updated", "YESTERDAY", { to: "Today" })).text).toBe("updated:yesterday..today");
    expect(set(row("importance", "02"), "todos").text).toBe("importance:2");
    expect(set(row("text", "AND")).text).toBe('"AND"');
    expect(set(row("text", "NOT", { not: true })).text).toBe('-"NOT"');
    expect(set(row("text", "or")).text).toBe("or");
    // The row keeps what was typed, and the bar has what it means.
    expect(set(row("tag", "Money")).built!.rows).toEqual([row("tag", "Money")]);
    expect(readBuilder("notes", "tag:money").built!.rows).toEqual([row("tag", "money")]);
  });

  it("say why of a row the language can't read, and nothing of one not filled in yet", () => {
    expect(termOf(row("tag", ""), "notes")).toBeNull();
    expect(termOf(row("text", "  "), "notes")).toBeNull();
    expect(termOf(row("updated", "2026-10-01", { to: "" }), "notes")).toBeNull();
    expect(termOf(row("tag", "Money"), "notes")).toEqual({ node: { kind: "filter", key: "tag", cmp: "=", value: "money" } });
    expect(termOf(row("tag", "not a tag"), "notes")).toEqual({ why: '"not a tag" is not a tag\'s name: letters, digits, _, - and /, and not digits alone' });
    expect(termOf(row("tag", "2026"), "notes")).toEqual({ why: '"2026" is not a tag\'s name: letters, digits, _, - and /, and not digits alone' });
    expect(termOf(row("updated", "2026-10"), "notes")).toEqual({ why: 'updated: takes a day written YYYY-MM-DD, or today, yesterday, tomorrow, 7d for seven days ago or +7d for seven days ahead. "2026-10" is none of them' });
    expect(termOf(row("due", "next week"), "todos")).toEqual({ why: 'due: takes a day written YYYY-MM-DD, or today, yesterday, tomorrow, 7d for seven days ago or +7d for seven days ahead. "next" is none of them' });
    expect(termOf(row("due", "today tomorrow"), "todos")).toEqual({ why: "This isn't one due: as the query language reads it" });
    expect(termOf(row("importance", "9"), "todos")).toEqual({ why: 'importance: takes a number from 0 to 3, and "9" isn\'t one' });
    expect(termOf(row("due", "today"), "notes")).toEqual({ why: "due: is for todos, and this is a search of notes" });
    expect(termOf(row("text", "+++"), "notes")).toEqual({ why: "There are no letters or digits here to look for" });
  });

  it("follow the text as it is typed, keep rows still being filled in through that, and leave a query they can't say exactly as typed", () => {
    let builder = after("budget", [{ type: "add" }, { type: "read", text: "budget #money" }]);
    expect(builder.built!.rows).toEqual([row("text", "budget"), row("tag", "money"), row("text", "")]);
    builder = builderReducer(builder, { type: "read", text: "budget (a OR b)" });
    expect(builder).toMatchObject({ built: null, unshown: "nested", text: "budget (a OR b)" });
    for (const event of [{ type: "add" }, { type: "match", match: "any" }, { type: "sort", sort: "title-asc" }, { type: "remove", at: 0 }] as const) expect(builderReducer(builder, event)).toBe(builder);
    builder = builderReducer(builder, { type: "read", text: "titel:x" });
    expect(builder).toMatchObject({ built: null, unshown: "unread", text: "titel:x" });
    expect(builderReducer(builder, { type: "add" })).toBe(builder);
    expect(builderReducer(builder, { type: "read", text: "" })).toMatchObject({ built: { rows: [] }, unshown: null });
  });
});
