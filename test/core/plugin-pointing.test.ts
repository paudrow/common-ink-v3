import { describe, expect, it } from "vitest";
import { namable, pointed } from "../../src/web/plugins/lib/pointing.ts";

const TITLES = ["Weekly planning", "Plan", "Road map", "Airplane notes", "Café plans", "older-harbour.png"];

describe("what @ finds of one kind", () => {
  it("is what has a word starting with each word typed, what starts with all of it first, ignoring case and accents", () => {
    expect(pointed(TITLES, "plan", (t) => t)).toEqual(["Plan", "Weekly planning", "Café plans"]);
    expect(pointed(TITLES, "cafe", (t) => t)).toEqual(["Café plans"]);
    expect(pointed(TITLES, "map ro", (t) => t)).toEqual(["Road map"]);
    expect(pointed(TITLES, "harb", (t) => t)).toEqual(["older-harbour.png"]);
    expect(pointed(TITLES, "lane", (t) => t)).toEqual([]);
  });

  it("is nothing for no word typed, or for what can't be a name", () => {
    expect(pointed(TITLES, "", (t) => t)).toEqual([]);
    expect(pointed(TITLES, "-", (t) => t)).toEqual([]);
    expect(pointed(TITLES, "-pl", (t) => t)).toEqual(["Weekly planning", "Plan", "Café plans"]);
    expect(pointed(TITLES, "plan it out with the team", (t) => t)).toEqual([]);
    expect(pointed(TITLES, "[[plan", (t) => t)).toEqual([]);
  });

  it("takes a few words with no bracket or bar as a name", () => {
    expect([namable(""), namable("ada l"), namable("one two three four"), namable("one two three four five"), namable("a|b"), namable("[[x")]).toEqual([true, true, true, false, false, false]);
  });
});
