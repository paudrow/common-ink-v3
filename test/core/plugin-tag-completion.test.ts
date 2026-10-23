import { describe, expect, it } from "vitest";
import type { ListedTag } from "../../src/web/plugin-api.ts";
import { tagAt, tagItems } from "../../src/web/plugins/tags/completing.ts";

const TAGS: ListedTag[] = [
  { name: "reading", notes: 2 },
  { name: "work", notes: 9, description: "Anything for the day job" },
  { name: "work/2026-q4", notes: 3 },
  { name: "Recipes", notes: 5 },
];
const labels = (typed: string, tags = TAGS) => tagItems(typed, tags).map((item) => item.label);

describe("what # offers", () => {
  it("alone, the tags on the most notes first", () => {
    expect(labels("")).toEqual(["#work", "#Recipes", "#work/2026-q4", "#reading"]);
  });

  it("narrows to the tags with a word starting with what was typed, those starting with all of it first", () => {
    expect(labels("re")).toEqual(["#Recipes", "#reading", "Create #re"]);
    expect(labels("q4")).toEqual(["#work/2026-q4", "Create #q4"]);
    expect(labels("work/20")).toEqual(["#work/2026-q4", "Create #work/20"]);
  });

  it("writes the tag and shows its description", () => {
    expect(tagItems("wor", TAGS)[0]).toEqual({ label: "#work", description: "Anything for the day job", insert: "#work", tone: "accent" });
  });

  it("offers to create the tag typed, last and waiting, unless a tag is named that ignoring case", () => {
    expect(tagItems("garden", TAGS)).toEqual([{ kind: "new", label: "Create #garden", description: "New tag", insert: "#garden" }]);
    expect(labels("work")).toEqual(["#work", "#work/2026-q4"]);
    expect(labels("recipes")).toEqual(["#Recipes"]);
  });

  it("puts the tag named what was typed first, however few notes have it", () => {
    expect(labels("work", [{ name: "workshop", notes: 20 }, { name: "work", notes: 1 }])).toEqual(["#work", "#workshop"]);
  });

  it("offers nothing once what was typed can't be a tag, as with a full stop after one, so Enter there is a new line", () => {
    expect(labels("12")).toEqual([]);
    expect(labels("a.b")).toEqual([]);
    expect(labels("work.")).toEqual([]);
    expect(labels("work)")).toEqual([]);
    expect(labels("")).not.toContain("Create #");
  });
});

describe("what @ offers of the tags", () => {
  it("is to create the tag typed, written as a tag", () => {
    expect(tagAt("compost", TAGS)).toEqual([{ kind: "new", label: "Create tag #compost", description: "New tag", insert: "#compost" }]);
    expect(tagAt("garden/beds", TAGS).map((item) => item.label)).toEqual(["Create tag #garden/beds"]);
  });

  it("is nothing for a tag that is there, ignoring case, nothing typed, or what can't be a tag's name", () => {
    expect(["recipes", "WORK", "", "12", "Zelda Fitz", "a.b"].flatMap((typed) => tagAt(typed, TAGS))).toEqual([]);
  });
});
