import { describe, expect, it } from "vitest";
import type { ListedFolder } from "../../src/core/protocol.ts";
import { folderTree } from "../../src/web/folders.ts";
import { canMove, movable, placesFor } from "../../src/web/plugins/lib/folderMoves.ts";

const folder = (id: string, parentId: string | null, access: "view" | "edit" = "edit"): ListedFolder => ({ id, name: id, parentId, noteCount: 0, uploadCount: 0, access });

/**
 * unsorted
 * projects
 *   app
 *     bugs
 *   house
 * reference (view only)
 *   recipes
 */
const tree = folderTree({
  unsortedId: "unsorted",
  folders: [folder("unsorted", null), folder("projects", null), folder("app", "projects"), folder("bugs", "app"), folder("house", "projects"), folder("reference", null, "view"), folder("recipes", "reference")],
});

describe("where a folder can be moved", () => {
  it("is into any folder the member can edit, other than itself, one inside it, or the one it is in", () => {
    expect(placesFor(tree, "app", true)).toEqual([null, "unsorted", "house", "recipes"]);
    expect(placesFor(tree, "house", true)).toEqual([null, "unsorted", "app", "bugs", "recipes"]);
    expect(placesFor(tree, "bugs", true)).toEqual([null, "unsorted", "projects", "house", "recipes"]);
  });

  it("is to the top only for a member who has it, and from it for nobody without it", () => {
    expect(canMove(tree, "app", null, true)).toBe(true);
    expect(canMove(tree, "app", null, false)).toBe(false);
    expect(canMove(tree, "projects", null, true)).toBe(false);
    expect(placesFor(tree, "app", false)).toEqual(["unsorted", "house", "recipes"]);
    expect(placesFor(tree, "projects", false)).toEqual([]);
  });

  it("is nowhere for Unsorted, a folder the member can only read or that is in one, or one that isn't there", () => {
    expect(placesFor(tree, "unsorted", true)).toEqual([]);
    expect(placesFor(tree, "reference", true)).toEqual([]);
    expect(placesFor(tree, "recipes", true)).toEqual([]);
    expect(placesFor(tree, "gone", true)).toEqual([]);
    expect(canMove(tree, "app", "reference", true)).toBe(false);
    expect(canMove(tree, "app", "gone", true)).toBe(false);
  });

  it("names, in tree order, the folders that can go somewhere", () => {
    expect(movable(tree, true)).toEqual(["projects", "app", "bugs", "house"]);
    expect(movable(tree, false)).toEqual(["app", "bugs", "house"]);
  });
});
