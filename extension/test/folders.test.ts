import { describe, expect, it } from "vitest";
import { defaultFolder, filterFolders, type FolderList } from "../src/clip/folders.ts";

const list: FolderList = {
  unsortedId: "unsorted0001",
  folders: [
    { id: "projects0001", name: "Projects", parentId: null, path: "Projects", access: "edit", noteCount: 1, uploadCount: 0 },
    { id: "cafe00000001", name: "Café", parentId: "projects0001", path: "Projects/Café", access: "edit", noteCount: 0, uploadCount: 0 },
    { id: "unsorted0001", name: "Unsorted", parentId: null, path: "Unsorted", access: "edit", noteCount: 2, uploadCount: 0 },
    { id: "archive00001", name: "Archive", parentId: null, path: "Archive", access: "view", noteCount: 3, uploadCount: 0 },
  ],
};

describe("folders", () => {
  it("hides folders the agent cannot edit and lists Unsorted first", () => {
    expect(filterFolders(list, "").map((folder) => folder.path)).toEqual(["Unsorted", "Projects", "Projects/Café"]);
  });

  it("matches a path ignoring case and accents", () => {
    expect(filterFolders(list, "cafe").map((folder) => folder.id)).toEqual(["cafe00000001"]);
  });

  it("defaults to the last folder, then Unsorted, then nothing", () => {
    expect(defaultFolder(list, { workspaceId: "w", folderId: "projects0001" }, "w")).toBe("projects0001");
    expect(defaultFolder(list, { workspaceId: "other", folderId: "projects0001" }, "w")).toBe("unsorted0001");
    expect(defaultFolder({ unsortedId: null, folders: list.folders.filter((folder) => folder.access === "view") }, null, "w")).toBeNull();
  });
});
