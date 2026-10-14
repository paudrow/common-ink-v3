import { describe, expect, it } from "vitest";
import { linksIn } from "../../src/core/links.ts";
import { summarize } from "../../src/core/markdown.ts";
import { mentionIndex, mentionsIn, rementioned, writtenMention } from "../../src/core/mentions.ts";
import { parseTodo, rewriteTodo, tagsOn } from "../../src/core/todos.ts";

const ADA = "k3j5h8d9f0a1";
const found = (text: string) => mentionsIn(text).map((m) => [text.slice(m.from, m.to), m.target, m.label]);

describe("how a note writes a mention", () => {
  it("reads a member by id with their name, and anyone else by name", () => {
    expect(found(`Ask @[[${ADA}|Ada Lovelace]] and @[[Sam Okafor]], then (@[[${ADA}]]).`)).toEqual([
      [`@[[${ADA}|Ada Lovelace]]`, ADA, "Ada Lovelace"],
      ["@[[Sam Okafor]]", "Sam Okafor", null],
      [`@[[${ADA}]]`, ADA, null],
    ]);
  });

  it("takes nothing else that has an @ in it for one", () => {
    const prose = [
      "Write to ada@example.com or ada@[[Sam]].",
      "Follow @audrow and @ada_l on the bird site, at 5 @ the cafe.",
      "See https://example.com/@ada/posts and `@[[Sam Okafor]]` in code.",
      "@@[[Sam]] and @[[]] and @[Sam] and @[[Sam]",
      "```\n@[[Sam Okafor]]\n```",
    ].join("\n");
    expect(found(prose)).toEqual([]);
  });

  it("leaves the brackets to a link wherever the @ before them starts no mention", () => {
    const text = `mail@[[${ADA}]] a_@[[Plan]] 9@[[Plan]] @@[[Plan|p]] (@[[Sam]]) @[[Sam]]`;
    expect(linksIn(text).map((l) => text.slice(l.from, l.to))).toEqual([`[[${ADA}]]`, "[[Plan]]", "[[Plan]]", "[[Plan|p]]"]);
    expect(found(text).map(([written]) => written)).toEqual(["@[[Sam]]", "@[[Sam]]"]);
  });

  it("is not read inside a markdown link's address", () => {
    expect(found("[site](https://example.com/ @[[Sam]]) and [x](@[[Sam]]) but @[[Lin Wei]]").map(([written]) => written)).toEqual(["@[[Lin Wei]]"]);
  });

  it("holds no character that doesn't show: a name of nothing else is no mention, and none is ever written", () => {
    expect(found("@[[\u200b]] @[[\u202e\u2066]] @[[aaaaaaaaaaaa|\u200d]]").map(([, target, label]) => [target, label])).toEqual([["aaaaaaaaaaaa", null]]);
    expect(found("@[[\u202eSam\u200b Okafor]]").map(([, target]) => target)).toEqual(["Sam Okafor"]);
    expect(mentionIndex("- [ ] x @[[\u200b]] @[[\u202eSam Okafor]]")).toEqual([[0, "sam okafor", "Sam Okafor"]]);
    expect(writtenMention({ name: "\u202eSam\u200b Okafor\u2069" })).toBe("@[[Sam Okafor]]");
    expect(writtenMention({ name: "\u200b\u200d" })).toBe("");
    expect(writtenMention({ id: ADA, name: "\u202e" })).toBe(`@[[${ADA}]]`);
  });

  it("is not a link to a note, and a link is not a mention", () => {
    const text = `@[[${ADA}|Ada]] wrote [[${ADA}|the plan]] with @[[Plan]]`;
    expect(linksIn(text).map((l) => text.slice(l.from, l.to))).toEqual([`[[${ADA}|the plan]]`]);
    expect(found(text).map(([written]) => written)).toEqual([`@[[${ADA}|Ada]]`, "@[[Plan]]"]);
  });

  it("writes a name without what would end the mention early", () => {
    expect(writtenMention({ id: ADA, name: "Ada [the] Countess|\nLovelace" })).toBe(`@[[${ADA}|Ada the Countess Lovelace]]`);
    expect(writtenMention({ name: "  Sam   Okafor " })).toBe("@[[Sam Okafor]]");
    expect(writtenMention({ id: ADA, name: "" })).toBe(`@[[${ADA}]]`);
    expect(writtenMention({ name: " ]] " })).toBe("");
  });

  it("rewrites only the mentions it is answered for, and leaves every other character", () => {
    const text = `a @[[Sam]]  b\t@[[${ADA}|Ada]]\n\`@[[Sam]]\` c`;
    expect(rementioned(text, (m) => (m.target === "Sam" ? "@[[Samuel]]" : undefined))).toBe(`a @[[Samuel]]  b\t@[[${ADA}|Ada]]\n\`@[[Sam]]\` c`);
    expect(rementioned(text, () => undefined)).toBe(text);
  });

  it("indexes who each line mentions once, a member by id and anyone else by their name in lower case", () => {
    expect(mentionIndex(`# Plan\n@[[${ADA}|Ada]] and @[[${ADA}|A. Lovelace]] and @[[Sam Okafor]]\n\n- [ ] call @[[SAM OKAFOR]]`)).toEqual([
      [1, ADA, "Ada"],
      [1, "sam okafor", "Sam Okafor"],
      [3, "sam okafor", "SAM OKAFOR"],
    ]);
  });

  it("reads as the name in a snippet", () => {
    expect(summarize(`# Plan\n\nAsk @[[${ADA}|Ada Lovelace]] or @[[Sam Okafor]].`).snippet).toBe("Ask @Ada Lovelace or @Sam Okafor.");
  });
});

describe("a todo's assignees", () => {
  const line = `- [ ] ! Call the bank @[[${ADA}|Ada Lovelace]] due:2026-10-14 @[[Sam Okafor]] +Home`;

  it("are the people mentioned on its line, and are not among its words", () => {
    const todo = parseTodo(line)!;
    expect(todo.assignees.map((a) => [line.slice(a.from, a.to), a.target, a.label])).toEqual([
      [`@[[${ADA}|Ada Lovelace]]`, ADA, "Ada Lovelace"],
      ["@[[Sam Okafor]]", "Sam Okafor", null],
    ]);
    expect(todo.words).toBe("Call the bank +Home");
    expect(todo.due?.date).toBe("2026-10-14");
  });

  it("holds no token of its own: a name that reads as a due date or a tag is still a name", () => {
    const todo = parseTodo("- [ ] Ring @[[Sam #home due:2026-10-14]]")!;
    expect([todo.due, tagsOn("- [ ] Ring @[[Sam #home due:2026-10-14]]"), todo.assignees.map((a) => a.target)]).toEqual([null, [], ["Sam #home due:2026-10-14"]]);
  });

  it("are assigned at the end of the line, once, and taken away with the space before", () => {
    const bare = "- [ ] Call the bank";
    const assigned = rewriteTodo(bare, { assign: { id: ADA, name: "Ada Lovelace" } });
    expect(assigned).toBe(`- [ ] Call the bank @[[${ADA}|Ada Lovelace]]`);
    expect(rewriteTodo(assigned, { assign: { id: ADA, name: "Ada L." } })).toBe(assigned);
    expect(rewriteTodo(assigned, { assign: { name: "Sam Okafor" } })).toBe(`${assigned} @[[Sam Okafor]]`);
    expect(rewriteTodo(`${assigned} @[[Sam Okafor]] +Home`, { unassign: "sam okafor" })).toBe(`${assigned} +Home`);
    expect(rewriteTodo(assigned, { unassign: ADA })).toBe(bare);
    expect(rewriteTodo(assigned, { unassign: ADA, assign: { name: "Sam Okafor" } })).toBe(`${bare} @[[Sam Okafor]]`);
    expect(() => rewriteTodo(bare, { assign: { name: "]]" } })).toThrow(RangeError);
  });
});
