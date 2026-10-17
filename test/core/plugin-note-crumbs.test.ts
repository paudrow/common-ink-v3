import { describe, expect, it } from "vitest";
import type { ListedFolder, NoteSummary } from "../../src/core/protocol.ts";
import { folderTree } from "../../src/web/folders.ts";
import { ALL_NOTES, SHARED_WITH_ME } from "../../src/web/plugin-api.ts";
import { crumbsOf, entriesOf, goLabel } from "../../src/web/plugins/noteCrumbs.ts";

const folder = (id: string, parentId: string | null, name = id): ListedFolder => ({ id, name, parentId, access: "edit" }) as ListedFolder;
const note = (id: string, folderId: string | null, title: string, state: NoteSummary["state"] = "live") => ({ id, folderId, title, state }) as NoteSummary;

const tree = folderTree({
  unsortedId: "unsorted",
  folders: [folder("unsorted", null, "Unsorted"), folder("projects", null, "Projects"), folder("engines", "projects", "Engines"), folder("analytical", "engines", "Analytical"), folder("journal", null, "Journal")],
});
const notes = [
  note("n1", "projects", "Plan"),
  note("n2", "projects", "Budget"),
  note("n3", "projects", "Old plan", "archived"),
  note("n4", "projects", "Binned", "trashed"),
  note("n5", "engines", "Notes"),
  note("n6", null, "Shared one"),
  note("n7", "projects", ""),
];

describe("the crumbs of an open note", () => {
  it("are the workspace, then each folder from the top down to the note's own", () => {
    const crumbs = crumbsOf(tree, { folderId: "analytical" }, "Lovelace Co");
    expect(crumbs.map((c) => c.name)).toEqual(["Lovelace Co", "Projects", "Engines", "Analytical"]);
    expect(crumbs.map((c) => c.folderId)).toEqual([ALL_NOTES, "projects", "engines", "analytical"]);
  });

  it("put a note shared with a guest, which is in no folder, under Shared with me", () => {
    const crumbs = crumbsOf(tree, { folderId: null }, "Lovelace Co");
    expect(crumbs.map((c) => [c.folderId, c.name])).toEqual([
      [ALL_NOTES, "Lovelace Co"],
      [SHARED_WITH_ME, "Shared with me"],
    ]);
  });

  it("say what Go to folder goes to", () => {
    const [workspace, projects] = crumbsOf(tree, { folderId: "projects" }, "W");
    expect(goLabel(workspace!)).toBe("Go to all notes");
    expect(goLabel(projects!)).toBe("Go to folder");
  });
});

describe("what a crumb's list holds", () => {
  const crumbs = crumbsOf(tree, { folderId: "analytical" }, "W");

  it("is a folder's subfolders and then its live notes by title, with none archived or in Trash", () => {
    expect(entriesOf(tree, notes, crumbs[1]!).map((e) => [e.kind, e.label])).toEqual([
      ["folder", "Engines"],
      ["note", "Budget"],
      ["note", "Plan"],
      ["note", "Untitled"],
    ]);
    expect(entriesOf(tree, notes, crumbs[2]!).map((e) => e.label)).toEqual(["Analytical", "Notes"]);
    expect(entriesOf(tree, notes, crumbs[3]!)).toEqual([]);
  });

  it("is the top-level folders alone for the workspace, Unsorted first", () => {
    expect(entriesOf(tree, notes, crumbs[0]!).map((e) => e.label)).toEqual(["Unsorted", "Projects", "Journal"]);
  });

  it("is only the notes shared with a guest under Shared with me, and holds only the notes it is given", () => {
    const [, shared] = crumbsOf(tree, { folderId: null }, "W");
    expect(entriesOf(tree, notes, shared!)).toEqual([{ id: "n6", kind: "note", label: "Shared one" }]);
    expect(entriesOf(tree, [], crumbs[1]!).map((e) => e.kind)).toEqual(["folder"]);
  });
});
