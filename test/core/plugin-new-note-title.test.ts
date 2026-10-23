import { expect, it } from "vitest";
import { newTitle } from "../../src/web/plugins/links/creating.ts";

const TITLES = ["Seed order", "Road map"];

it("@ offers to create a note titled with the words typed, spaces made one", () => {
  expect(newTitle("garden  beds", TITLES)).toBe("garden beds");
  expect(newTitle("Seed", TITLES)).toBe("Seed");
});

it("@ offers no note a listed note is already titled, ignoring case, spaces and how its letters are encoded", () => {
  expect(newTitle("seed ORDER", TITLES)).toBeNull();
  expect(newTitle("seed order", ["Seed  order "])).toBeNull();
  expect(newTitle("José", ["Jose\u0301"])).toBeNull();
});

it("@ offers no note for what can't be a name: nothing, no letter, a bracket, or prose", () => {
  expect(["", "  ", "2026", "[[x", "a|b", "one two three four five"].map((typed) => newTitle(typed, TITLES))).toEqual([null, null, null, null, null, null]);
});
