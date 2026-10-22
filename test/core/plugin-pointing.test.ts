import { describe, expect, it } from "vitest";
import { folderTree } from "../../src/web/folders.ts";
import type { ListedFolder } from "../../src/web/plugin-api.ts";
import { foldersAt } from "../../src/web/plugins/links/folderPaths.ts";
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

describe("the folders @ finds", () => {
  const listed = [
    { id: "p", name: "Projects", parentId: null },
    { id: "g", name: "Garden", parentId: "p" },
    { id: "b", name: "Beds", parentId: "g" },
    { id: "h", name: "Garden ideas", parentId: null },
    { id: "w", name: "Work", parentId: null },
  ] as ListedFolder[];
  const folders = folderTree({ unsortedId: null, folders: listed });
  const found = (typed: string) => foldersAt(typed, folders).map((f) => folders.pathName(f.id));

  it("by name without a slash, as notes are found", () => {
    expect(found("gar")).toEqual(["Projects / Garden", "Garden ideas"]);
    expect(found("")).toEqual([]);
  });

  it("by path with one: the last part the folder's name, each part before it a folder it is in, in order", () => {
    expect(found("proj/gar")).toEqual(["Projects / Garden"]);
    expect(found("proj/beds")).toEqual(["Projects / Garden / Beds"]);
    expect(found("proj/gar/be")).toEqual(["Projects / Garden / Beds"]);
    expect(found("gar/proj")).toEqual([]);
    expect(found("work/gar")).toEqual([]);
  });

  it("every folder inside, for a path that ends in a slash", () => {
    expect(found("proj/")).toEqual(["Projects / Garden", "Projects / Garden / Beds"]);
  });
});
