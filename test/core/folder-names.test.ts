import { describe, expect, it } from "vitest";
import { atPath, nameKey, pathsOf } from "../../src/core/folder-names.ts";

const folders = [
  { id: "a", name: "Projects", parentId: null },
  { id: "b", name: "Skills", parentId: "a" },
  { id: "c", name: "Deep", parentId: "b" },
  { id: "d", name: "Shared", parentId: "hidden" },
];

describe("a folder's path", () => {
  it("is its name after those of the folders it is in, as far up as the folders given", () => {
    expect(Object.fromEntries(pathsOf(folders))).toEqual({ a: "Projects", b: "Projects/Skills", c: "Projects/Skills/Deep", d: "Shared" });
  });

  it("stops at a folder that is inside itself, rather than going round", () => {
    expect(Object.fromEntries(pathsOf([{ id: "x", name: "X", parentId: "y" }, { id: "y", name: "Y", parentId: "x" }])).x).toMatch(/^[XY/]+$/);
  });

  it("matches as written first, then ignoring case, then ignoring accents", () => {
    const placed = [
      { id: "1", path: "Café" },
      { id: "2", path: "cafe" },
      { id: "3", path: "Notes/Ölmalerei" },
    ];
    expect(atPath(placed, "Café").map((f) => f.id)).toEqual(["1"]);
    expect(atPath(placed, "CAFÉ").map((f) => f.id)).toEqual(["1"]);
    expect(atPath(placed, "cafe").map((f) => f.id)).toEqual(["2"]);
    expect(atPath(placed, "CAFE").map((f) => f.id)).toEqual(["2"]);
    expect(atPath(placed, "notes/olmalerei").map((f) => f.id)).toEqual(["3"]);
    expect(atPath(placed, "Café/")).toHaveLength(1);
    expect(atPath(placed, "")).toEqual([]);
  });

  it("tells names apart ignoring case in every script, and composed accents from separate ones not at all", () => {
    expect(nameKey("ÉCOLES")).toBe(nameKey("écoles"));
    expect(nameKey("Ωmega")).toBe(nameKey("ωMEGA"));
    expect(nameKey("écoles")).toBe(nameKey("écoles"));
    expect(nameKey("Ecoles")).not.toBe(nameKey("Écoles"));
  });
});
