import { describe, expect, it } from "vitest";
import { kindOf, linkedEvent, linkedFolder, linkedPerson, linksIn, namesKind, writtenEventLink } from "../../src/core/links.ts";
import { summarize } from "../../src/core/markdown.ts";
import { mentionIndex, mentionsIn, rementioned, writtenMention } from "../../src/core/mentions.ts";
import { parseTodo, rewriteTodo, tagsOn } from "../../src/core/todos.ts";

const ADA = "k3j5h8d9f0a1";
const found = (text: string) => mentionsIn(text).map((m) => [text.slice(m.from, m.to), m.target, m.label]);

describe("what a link is to", () => {
  it("is named by its kind for a folder, an event and a person, and a note's id or a title has none", () => {
    expect([`folder:${ADA}`, `event:${ADA}`, `person:${ADA}`, "person:Sam Okafor", ADA, "Plans", "2026-10-23"].map(kindOf)).toEqual([
      { kind: "folder", to: ADA },
      { kind: "event", to: ADA },
      { kind: "person", to: ADA },
      { kind: "person", to: "Sam Okafor" },
      null,
      null,
      null,
    ]);
  });

  it("names a folder or an event by an id alone, and nothing that isn't one of the kinds", () => {
    expect([kindOf("folder:Plans"), kindOf("event:Lunch with Sam"), kindOf("person: "), kindOf("place:Paris"), kindOf("Person:Ada")]).toEqual([null, null, null, null, null]);
    expect([namesKind("event:Lunch with Sam"), namesKind("folder:Plans"), namesKind("place:Paris"), namesKind("Plans")]).toEqual([true, true, false, false]);
    expect([linkedFolder(`folder:${ADA}`), linkedEvent(`event:${ADA}`), linkedPerson(`person:${ADA}`), linkedPerson(`event:${ADA}`)]).toEqual([ADA, ADA, ADA, null]);
  });

  it("is written with words of its own after a |", () => {
    expect([writtenEventLink(ADA), writtenEventLink(ADA, "the lunch")]).toEqual([`[[event:${ADA}]]`, `[[event:${ADA}|the lunch]]`]);
    const text = `[[person:${ADA}|Sammy]] [[2026-10-23|the trip]] [[folder:${ADA}|that folder]] [[event:${ADA}]]`;
    expect(linksIn(text).map((l) => [l.target, l.display])).toEqual([
      [`person:${ADA}`, "Sammy"],
      ["2026-10-23", "the trip"],
      [`folder:${ADA}`, "that folder"],
      [`event:${ADA}`, null],
    ]);
  });
});

describe("how a note writes a mention", () => {
  it("reads a member by id and anyone else by name, each with words of its own after a |", () => {
    expect(found(`Ask [[person:${ADA}]] and [[person:Sam Okafor]], then ([[person:${ADA}|the Countess]]).`)).toEqual([
      [`[[person:${ADA}]]`, ADA, null],
      ["[[person:Sam Okafor]]", "Sam Okafor", null],
      [`[[person:${ADA}|the Countess]]`, ADA, "the Countess"],
    ]);
  });

  it("takes nothing else for one: no @, no address, nothing in code, no other kind of link", () => {
    const prose = [
      "Write to ada@example.com, follow @audrow, and see https://example.com/@ada/posts.",
      "Old forms are words now: @[[Sam Okafor]] is an @ and a link to a note titled Sam Okafor.",
      "`[[person:Sam Okafor]]` in code, [[person:]] with nobody, [[person: ]] too, and [[people:Sam]].",
      "```\n[[person:Sam Okafor]]\n```",
    ].join("\n");
    expect(found(prose)).toEqual([]);
  });

  it("is not read inside a markdown link's address", () => {
    expect(found("[site](https://example.com/[[person:Sam]]) and [x]([[person:Sam]]) but [[person:Lin Wei]]").map(([written]) => written)).toEqual(["[[person:Lin Wei]]"]);
  });

  it("holds no character that doesn't show: a name of nothing else is no mention, and none is ever written", () => {
    expect(found(`[[person:​]] [[person:‮⁦]] [[person:${ADA}|‍]]`).map(([, target, label]) => [target, label])).toEqual([[ADA, null]]);
    expect(found("[[person:‮Sam​ Okafor]]").map(([, target]) => target)).toEqual(["Sam Okafor"]);
    expect(mentionIndex("- [ ] x [[person:​]] [[person:‮Sam Okafor]]")).toEqual([[0, "sam okafor", "Sam Okafor"]]);
    expect(writtenMention({ name: "‮Sam​ Okafor⁩" })).toBe("[[person:Sam Okafor]]");
    expect(writtenMention({ name: "​‍" })).toBe("");
    expect(writtenMention({ id: ADA, name: "‮" })).toBe(`[[person:${ADA}]]`);
  });

  it("is a link of its own kind: a link to a note is no mention", () => {
    const text = `[[person:${ADA}]] wrote [[${ADA}|the plan]] in [[folder:${ADA}]]`;
    expect(linksIn(text).map((l) => text.slice(l.from, l.to))).toEqual([`[[person:${ADA}]]`, `[[${ADA}|the plan]]`, `[[folder:${ADA}]]`]);
    expect(found(text).map(([written]) => written)).toEqual([`[[person:${ADA}]]`]);
  });

  it("writes a member by id alone, and a name or its own words without what would end the link early", () => {
    expect(writtenMention({ id: ADA, name: "Ada Lovelace" })).toBe(`[[person:${ADA}]]`);
    expect(writtenMention({ id: ADA, name: "Ada" }, "the [Countess]|\nof Lovelace")).toBe(`[[person:${ADA}|the Countess of Lovelace]]`);
    expect(writtenMention({ name: "  Sam   Okafor " })).toBe("[[person:Sam Okafor]]");
    expect(writtenMention({ name: " ]] " })).toBe("");
  });

  it("rewrites only the mentions it is answered for, and leaves every other character", () => {
    const text = `a [[person:Sam]]  b\t[[person:${ADA}|Ada]]\n\`[[person:Sam]]\` c`;
    expect(rementioned(text, (m) => (m.target === "Sam" ? "[[person:Samuel]]" : undefined))).toBe(`a [[person:Samuel]]  b\t[[person:${ADA}|Ada]]\n\`[[person:Sam]]\` c`);
    expect(rementioned(text, () => undefined)).toBe(text);
  });

  it("indexes who each line mentions once, a member by id and anyone else by their name in lower case, with the name it is by", () => {
    expect(mentionIndex(`# Plan\n[[person:${ADA}]] and [[person:${ADA}|A. Lovelace]] and [[person:Sam Okafor|Sammy]]\n\n- [ ] call [[person:SAM OKAFOR]]`)).toEqual([
      [1, ADA, ""],
      [1, "sam okafor", "Sam Okafor"],
      [3, "sam okafor", "SAM OKAFOR"],
    ]);
  });

  it("reads in a snippet as its own words or the name it is by, and a member's id alone as nothing", () => {
    expect(summarize(`# Plan\n\nAsk [[person:${ADA}]], [[person:${ADA}|the Countess]] or [[person:Sam Okafor]].`).snippet).toBe("Ask, @the Countess or @Sam Okafor.");
  });
});

describe("a todo's assignees", () => {
  const line = `- [ ] ! Call the bank [[person:${ADA}]] due:2026-10-14 [[person:Sam Okafor|Sam]] +Home`;

  it("are the people mentioned on its line, and are not among its words", () => {
    const todo = parseTodo(line)!;
    expect(todo.assignees.map((a) => [line.slice(a.from, a.to), a.target, a.label])).toEqual([
      [`[[person:${ADA}]]`, ADA, null],
      ["[[person:Sam Okafor|Sam]]", "Sam Okafor", "Sam"],
    ]);
    expect(todo.words).toBe("Call the bank +Home");
    expect(todo.due?.date).toBe("2026-10-14");
  });

  it("holds no token of its own: a name that reads as a due date or a tag is still a name", () => {
    const todo = parseTodo("- [ ] Ring [[person:Sam #home due:2026-10-14]]")!;
    expect([todo.due, tagsOn("- [ ] Ring [[person:Sam #home due:2026-10-14]]"), todo.assignees.map((a) => a.target)]).toEqual([null, [], ["Sam #home due:2026-10-14"]]);
  });

  it("are assigned at the end of the line, once, and taken away with the space before", () => {
    const bare = "- [ ] Call the bank";
    const assigned = rewriteTodo(bare, { assign: { id: ADA, name: "Ada Lovelace" } });
    expect(assigned).toBe(`- [ ] Call the bank [[person:${ADA}]]`);
    expect(rewriteTodo(assigned, { assign: { id: ADA, name: "Ada L." } })).toBe(assigned);
    expect(rewriteTodo(assigned, { assign: { name: "Sam Okafor" } })).toBe(`${assigned} [[person:Sam Okafor]]`);
    expect(rewriteTodo(`${assigned} [[person:Sam Okafor]] +Home`, { unassign: "sam okafor" })).toBe(`${assigned} +Home`);
    expect(rewriteTodo(assigned, { unassign: ADA })).toBe(bare);
    expect(rewriteTodo(assigned, { unassign: ADA, assign: { name: "Sam Okafor" } })).toBe(`${bare} [[person:Sam Okafor]]`);
    expect(() => rewriteTodo(bare, { assign: { name: "]]" } })).toThrow(RangeError);
  });
});
