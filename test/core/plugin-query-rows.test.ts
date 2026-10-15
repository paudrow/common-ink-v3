import { describe, expect, it } from "vitest";
import { fieldName, fieldsOf, keysFor, parseQuery, querySyntax, wordsIn, type QueryScope } from "../../src/web/plugin-api.ts";
import { builderReducer, builtOf, filled, readBuilder, termOf, withField, type BuilderEvent, type Row } from "../../src/web/plugins/lib/queryRows.ts";

const row = (field: Row["field"], value: string, more: Partial<Row> = {}): Row => ({ field, not: false, cmp: "=", value, ...more });
const read = (text: string, scope: QueryScope = "notes") => {
  const parsed = parseQuery(text, scope);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return builtOf(parsed.query);
};
const after = (text: string, events: BuilderEvent[], scope: QueryScope = "notes") => events.reduce(builderReducer, readBuilder(scope, text));

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
    expect(read("due:<today importance:>=2", "todos")?.rows).toEqual([row("due", "today", { cmp: "<" }), row("priority", "medium", { cmp: ">=" })]);
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
    expect(after("", [{ type: "set", at: 0, row: row("has", "todo", { not: true }) }]).text).toBe("no:todo");
    expect(after("", [{ type: "set", at: 0, row: row("text", "second quarter") }]).text).toBe('"second quarter"');
  });

  it("hold a value the language can't read as a row still being filled in, and never write it", () => {
    expect(filled(row("updated", "2026-10"), "notes")).toBe(false);
    expect(filled(row("updated", "2026-10-01"), "notes")).toBe(true);
    expect(filled(row("updated", "2026-10-01", { to: "" }), "notes")).toBe(false);
    expect(filled(row("priority", "urgent"), "todos")).toBe(false);
    expect(filled(row("due", "today"), "notes")).toBe(false);
    expect(filled(row("tag", "not a tag"), "notes")).toBe(false);
    expect(filled(row("text", "+++"), "notes")).toBe(false);
    const builder = after("budget", [{ type: "add" }, { type: "set", at: 1, row: row("updated", "2026-1", { cmp: ">=" }) }]);
    expect(builder.text).toBe("budget");
    expect(builderReducer(builder, { type: "set", at: 1, row: row("updated", "2026-10-01", { cmp: ">=" }) }).text).toBe("budget updated:>=2026-10-01");
  });

  it("read a row's value as the language reads it typed: a tag or a day in capitals, a tag with its #, a word that is an operator's", () => {
    const set = (to: Row, scope: "notes" | "todos" = "notes") => after("", [{ type: "set", at: 0, row: to }], scope);
    expect(set(row("tag", "Money")).text).toBe("tag:money");
    expect(set(row("tag", "#Money")).text).toBe("tag:money");
    expect(set(row("tag", "#money", { not: true })).text).toBe("-tag:money");
    expect(set(row("due", "Today", { cmp: "<" }), "todos").text).toBe("due:<today");
    expect(set(row("updated", "YESTERDAY", { to: "Today" })).text).toBe("updated:yesterday..today");
    expect(set(row("priority", "02"), "todos").text).toBe("priority:medium");
    expect(set(row("priority", "High"), "todos").text).toBe("priority:high");
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
    expect(termOf(row("priority", "9"), "todos")).toEqual({ why: 'priority: takes high, medium, low or none, and "9" isn\'t one' });
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
    expect(builderReducer(builder, { type: "read", text: "" })).toMatchObject({ built: { rows: [row("text", "")] }, unshown: null });
  });

  it("open on a first row ready to fill in when the query has none, which adds nothing to the query, and keep one when the last is removed", () => {
    expect(readBuilder("notes", "").built!.rows).toEqual([row("text", "")]);
    expect(readBuilder("notes", "sort:title-asc")).toMatchObject({ text: "sort:title-asc", built: { rows: [row("text", "")], sort: "title-asc" } });
    expect(readBuilder("notes", "budget").built!.rows).toEqual([row("text", "budget")]);
    let builder = after("", [{ type: "match", match: "any" }]);
    expect(builder.text).toBe("");
    expect(builder.built!.rows).toEqual([row("text", "")]);
    builder = after("budget", [{ type: "remove", at: 0 }]);
    expect(builder.text).toBe("");
    expect(builder.built!.rows).toEqual([row("text", "")]);
    // A row being filled in when the text is cleared is the one row: no second empty one joins it.
    builder = after("budget", [{ type: "add" }, { type: "set", at: 1, row: row("tag", "") }, { type: "read", text: "" }]);
    expect(builder.built!.rows).toEqual([row("tag", "")]);
  });

  it("put Shared and Private under Visibility, apart from the states, and write both as is:", () => {
    expect(read("is:shared -is:private is:archived")?.rows).toEqual([row("visibility", "shared"), row("visibility", "private", { not: true }), row("is", "archived")]);
    expect(after("", [{ type: "set", at: 0, row: row("visibility", "private") }]).text).toBe("is:private");
    expect(after("", [{ type: "set", at: 0, row: row("visibility", "shared", { not: true }) }], "todos").text).toBe("-is:shared");
    // A word of the other field is no Visibility: it is said why, and kept out of the query.
    expect(termOf(row("visibility", "archived"), "notes")).toEqual({ why: "This isn't one is: as the query language reads it" });
    expect(termOf(row("is", "shared"), "notes")).toEqual({ why: "This isn't one is: as the query language reads it" });
  });
});

describe("the builder's rows for uploads", () => {
  it("lay out every filter uploads are found by, with Visibility apart from State, and none that is a note's", () => {
    expect(read('report type:image -used:yes uploader:@me size:>1mb uploaded:2026-10-01..2026-10-14 name:"Q2 plan" folder:Pictures is:private sort:size-desc', "uploads")).toEqual({
      rows: [
        row("text", "report"),
        row("type", "image"),
        row("used", "yes", { not: true }),
        row("uploader", "@me"),
        row("size", "1mb", { cmp: ">" }),
        row("uploaded", "2026-10-01", { to: "2026-10-14" }),
        row("name", "Q2 plan"),
        row("folder", "Pictures"),
        row("visibility", "private"),
      ],
      match: "all",
      in: [],
      sort: "size-desc",
    });
    expect(read("type:pdf OR type:text OR kind:other", "uploads")?.match).toBe("any");
    expect(keysFor("uploads").flatMap((key) => fieldsOf(key, "uploads"))).toEqual(["folder", "name", "type", "uploader", "used", "size", "uploaded", "is", "visibility", "sort"]);
    expect(wordsIn("is", "uploads").map((w) => w.word)).toEqual(["open", "archived", "trashed"]);
    expect(wordsIn("type", "uploads").map((w) => w.word)).toEqual(["image", "video", "audio", "pdf", "text", "other"]);
  });

  it("write each row as the bar reads it, and keep one the language can't read for uploads out of the query", () => {
    const set = (to: Row) => after("", [{ type: "set", at: 0, row: to }], "uploads").text;
    expect(set(row("size", "1MB", { cmp: ">=" }))).toBe("size:>=1mb");
    expect(set(row("size", "100kb", { to: "1.5mb" }))).toBe("size:100kb..1.5mb");
    expect(set(row("name", "Q2 report"))).toBe('name:"Q2 report"');
    expect(set(row("type", "pdf", { not: true }))).toBe("-type:pdf");
    expect(set(row("used", "no"))).toBe("used:no");
    expect(set(row("uploader", "Ada Lovelace"))).toBe('uploader:"Ada Lovelace"');
    expect(set(row("uploaded", "7d", { cmp: ">=" }))).toBe("uploaded:>=7d");
    expect(set(row("visibility", "shared"))).toBe("is:shared");
    expect(set(row("text", "q2 report"))).toBe('"q2 report"');
    expect(filled(row("size", "big"), "uploads")).toBe(false);
    expect(filled(row("size", "1.5gb"), "uploads")).toBe(true);
    expect(termOf(row("size", "lots"), "uploads")).toEqual({ why: 'size: takes a number of bytes, or one with kb, mb or gb after it, such as 1mb. "lots" is none of them' });
    expect(termOf(row("type", "spreadsheet"), "uploads")).toEqual({ why: 'type: doesn\'t take "spreadsheet". It takes image, video, audio, pdf, text or other' });
    expect(termOf(row("tag", "money"), "uploads")).toEqual({ why: "tag: is for notes and todos, and this is a search of uploads" });
    // A size is compared as a day is: a field that compares keeps its comparison, one that doesn't is set to is.
    expect(withField(row("uploaded", "", { cmp: ">" }), "size")).toEqual(row("size", "", { cmp: ">" }));
    expect(withField(row("size", "1mb", { cmp: ">" }), "type")).toEqual(row("type", ""));
    let builder = after("type:image", [{ type: "add" }, { type: "set", at: 1, row: row("size", "1m") }], "uploads");
    expect(builder.text).toBe("type:image");
    builder = builderReducer(builder, { type: "set", at: 1, row: row("size", "1mb", { cmp: "<" }) });
    expect(builder.text).toBe("type:image size:<1mb");
    builder = builderReducer(builder, { type: "sort", sort: "name-asc" });
    expect(builder.text).toBe("type:image size:<1mb sort:name-asc");
  });

  it("are helped by the language's own table for uploads: every heading is a field of the builder, or how a query is written", () => {
    const headings = [...new Set(querySyntax("uploads").map((r) => (r.field === null ? "Writing a query" : fieldName(r.field))))];
    expect(headings).toEqual(["Writing a query", "Folder", "Name", "Type", "Uploader", "Used", "Size", "Uploaded", "State", "Visibility", "Sort"]);
    expect(querySyntax("uploads").find((r) => r.form === "type:text")?.means).toBe("Text to read, by its name's ending: txt, md, markdown, csv, tsv, json, log, yaml, yml, toml, xml, html, css, js, ts, py, sh, sql");
    expect(querySyntax("uploads").some((r) => r.form.startsWith("#") || r.form.startsWith("tag:") || r.form.startsWith("in:"))).toBe(false);
  });
});
