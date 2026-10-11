import { describe, expect, it } from "vitest";
import { editorReducer, isEditorLayout, type EditorLayout } from "../../src/web/plugins/tabs/editorLayout.ts";

const one = (tabs: [string, boolean][], active: string | null = tabs.at(-1)?.[0] ?? null): EditorLayout => ({
  groups: [{ id: "1", tabs: tabs.map(([noteId, preview]) => ({ noteId, preview })), activeNoteId: active }],
  focusedGroupId: "1",
});

describe("opening a note", () => {
  it("as a preview replaces the group's preview tab in place", () => {
    const layout = one([["a", false], ["b", true], ["c", false]], "c");

    expect(editorReducer(layout, { type: "open", noteId: "d", preview: true })).toEqual(one([["a", false], ["d", true], ["c", false]], "d"));
  });

  it("as a preview with no preview tab adds one after the active tab", () => {
    const layout = one([["a", false], ["b", false]], "a");

    expect(editorReducer(layout, { type: "open", noteId: "c", preview: true })).toEqual(one([["a", false], ["c", true], ["b", false]], "c"));
  });

  it("pinned keeps the preview tab and adds its own after the active tab", () => {
    const layout = one([["a", true]], "a");

    expect(editorReducer(layout, { type: "open", noteId: "b", preview: false })).toEqual(one([["a", true], ["b", false]], "b"));
  });

  it("that already has a tab activates it, and opening it pinned pins it", () => {
    const layout = one([["a", true], ["b", false]], "b");

    expect(editorReducer(layout, { type: "open", noteId: "a", preview: true })).toEqual(one([["a", true], ["b", false]], "a"));
    expect(editorReducer(layout, { type: "open", noteId: "a", preview: false })).toEqual(one([["a", false], ["b", false]], "a"));
    expect(editorReducer(one([["a", false]]), { type: "open", noteId: "a", preview: true })).toEqual(one([["a", false]]));
  });

  it("goes into the focused group", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: true }], activeNoteId: "a" },
        { id: "2", tabs: [], activeNoteId: null },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(layout, { type: "open", noteId: "b", preview: true }).groups).toEqual([
      { id: "1", tabs: [{ noteId: "a", preview: true }], activeNoteId: "a" },
      { id: "2", tabs: [{ noteId: "b", preview: true }], activeNoteId: "b" },
    ]);
  });
});

describe("opening a note that has a tab in another group", () => {
  it("shows it there and focuses that group, so one note never has two editors", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: true }, { noteId: "b", preview: false }], activeNoteId: "b" },
        { id: "2", tabs: [{ noteId: "c", preview: false }], activeNoteId: "c" },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(layout, { type: "open", noteId: "a", preview: false })).toEqual({
      groups: [{ id: "1", tabs: [{ noteId: "a", preview: false }, { noteId: "b", preview: false }], activeNoteId: "a" }, layout.groups[1]],
      focusedGroupId: "1",
    });
  });
});

describe("closing tabs", () => {
  const abcd = one([["a", false], ["b", false], ["c", false], ["d", false]], "b");
  const close = (scope: "tab" | "others" | "all" | "left" | "right", noteId: string, layout = abcd) =>
    editorReducer(layout, { type: "close", scope, groupId: "1", noteId });

  it("closes one tab, and closing the active one activates the tab to its right, or else its left", () => {
    expect(close("tab", "c")).toEqual(one([["a", false], ["b", false], ["d", false]], "b"));
    expect(close("tab", "b")).toEqual(one([["a", false], ["c", false], ["d", false]], "c"));
    expect(close("tab", "d", one([["a", false], ["d", false]], "d"))).toEqual(one([["a", false]], "a"));
  });

  it("closes the others", () => {
    expect(close("others", "c")).toEqual(one([["c", false]], "c"));
  });

  it("closes all of them", () => {
    expect(close("all", "c")).toEqual(one([], null));
  });

  it("closes those to the left, activating the clicked tab when the active one goes", () => {
    expect(close("left", "c")).toEqual(one([["c", false], ["d", false]], "c"));
    expect(close("left", "b")).toEqual(one([["b", false], ["c", false], ["d", false]], "b"));
  });

  it("closes those to the right, keeping the active tab when it stays", () => {
    expect(close("right", "c")).toEqual(one([["a", false], ["b", false], ["c", false]], "b"));
    expect(close("right", "a")).toEqual(one([["a", false]], "a"));
  });

  it("removes a group left with no tabs and focuses the group to its left, or else its right", () => {
    const two: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" },
        { id: "2", tabs: [{ noteId: "b", preview: false }], activeNoteId: "b" },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(two, { type: "close", scope: "tab", groupId: "2", noteId: "b" })).toEqual({ groups: [two.groups[0]], focusedGroupId: "1" });
    expect(editorReducer(two, { type: "close", scope: "all", groupId: "1", noteId: "a" })).toEqual({ groups: [two.groups[1]], focusedGroupId: "2" });
    expect(editorReducer({ ...two, focusedGroupId: "1" }, { type: "close", scope: "tab", groupId: "2", noteId: "b" })).toEqual({
      groups: [two.groups[0]],
      focusedGroupId: "1",
    });
  });
});

describe("splitting", () => {
  const layout: EditorLayout = {
    groups: [
      { id: "1", tabs: [{ noteId: "a", preview: true }], activeNoteId: "a" },
      { id: "3", tabs: [{ noteId: "b", preview: false }], activeNoteId: "b" },
    ],
    focusedGroupId: "1",
  };

  it("puts the note pinned in a new focused group on the side asked for", () => {
    expect(editorReducer(layout, { type: "split", groupId: "1", side: "right", noteId: "c" })).toEqual({
      groups: [layout.groups[0], { id: "4", tabs: [{ noteId: "c", preview: false }], activeNoteId: "c" }, layout.groups[1]],
      focusedGroupId: "4",
    });
    expect(editorReducer(layout, { type: "split", groupId: "3", side: "left", noteId: "c" })).toEqual({
      groups: [layout.groups[0], { id: "4", tabs: [{ noteId: "c", preview: false }], activeNoteId: "c" }, layout.groups[1]],
      focusedGroupId: "4",
    });
  });

  it("moves a note that already has a tab, and the group it empties goes", () => {
    const ab: EditorLayout = { groups: [{ id: "1", tabs: [{ noteId: "a", preview: false }, { noteId: "b", preview: true }], activeNoteId: "b" }], focusedGroupId: "1" };

    expect(editorReducer(ab, { type: "split", groupId: "1", side: "right", noteId: "b" })).toEqual({
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" },
        { id: "2", tabs: [{ noteId: "b", preview: false }], activeNoteId: "b" },
      ],
      focusedGroupId: "2",
    });
    expect(editorReducer(layout, { type: "split", groupId: "1", side: "left", noteId: "b" })).toEqual({
      groups: [{ id: "4", tabs: [{ noteId: "b", preview: false }], activeNoteId: "b" }, layout.groups[0]],
      focusedGroupId: "4",
    });
  });

  it("from a workspace with nothing open leaves one group", () => {
    const empty: EditorLayout = { groups: [{ id: "1", tabs: [], activeNoteId: null }], focusedGroupId: "1" };

    expect(editorReducer(empty, { type: "split", groupId: "1", side: "right", noteId: "a" })).toEqual({
      groups: [{ id: "2", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" }],
      focusedGroupId: "2",
    });
  });
});

describe("dropping a note on a tab bar", () => {
  const layout: EditorLayout = {
    groups: [
      { id: "1", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" },
      { id: "2", tabs: [{ noteId: "b", preview: false }, { noteId: "c", preview: true }, { noteId: "d", preview: false }], activeNoteId: "b" },
    ],
    focusedGroupId: "1",
  };
  const drop = (noteId: string, index: number) => editorReducer(layout, { type: "drop", groupId: "2", index, noteId });

  it("adds it pinned at that spot, active in a focused group", () => {
    expect(drop("x", 1)).toEqual({
      groups: [layout.groups[0], { id: "2", tabs: [{ noteId: "b", preview: false }, { noteId: "x", preview: false }, { noteId: "c", preview: true }, { noteId: "d", preview: false }], activeNoteId: "x" }],
      focusedGroupId: "2",
    });
  });

  it("moves a tab the group already has to that spot and pins it", () => {
    expect(drop("c", 0).groups[1]!.tabs).toEqual([{ noteId: "c", preview: false }, { noteId: "b", preview: false }, { noteId: "d", preview: false }]);
    expect(drop("b", 3).groups[1]!.tabs).toEqual([{ noteId: "c", preview: true }, { noteId: "d", preview: false }, { noteId: "b", preview: false }]);
  });
});

describe("dropping a tab from another group on a tab bar", () => {
  it("moves it, and the group it empties goes", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" },
        { id: "2", tabs: [{ noteId: "b", preview: false }], activeNoteId: "b" },
      ],
      focusedGroupId: "1",
    };

    expect(editorReducer(layout, { type: "drop", groupId: "2", index: 1, noteId: "a" })).toEqual({
      groups: [{ id: "2", tabs: [{ noteId: "b", preview: false }, { noteId: "a", preview: false }], activeNoteId: "a" }],
      focusedGroupId: "2",
    });
  });
});

describe("activating a tab", () => {
  it("shows it and focuses its group", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: false }], activeNoteId: "a" },
        { id: "2", tabs: [{ noteId: "b", preview: false }, { noteId: "c", preview: false }], activeNoteId: "b" },
      ],
      focusedGroupId: "1",
    };

    expect(editorReducer(layout, { type: "activate", groupId: "2", noteId: "c" })).toEqual({
      groups: [layout.groups[0], { ...layout.groups[1], activeNoteId: "c" }],
      focusedGroupId: "2",
    });
    expect(editorReducer(layout, { type: "focus", groupId: "2" })).toEqual({ ...layout, focusedGroupId: "2" });
  });
});

describe("a stored layout", () => {
  it("is used only when its focused group and active tabs exist", () => {
    expect(isEditorLayout(one([["a", true]]))).toBe(true);
    expect(isEditorLayout(one([], null))).toBe(true);
    expect(isEditorLayout({ ...one([["a", true]]), focusedGroupId: "2" })).toBe(false);
    expect(isEditorLayout(one([["a", true]], "b"))).toBe(false);
    expect(isEditorLayout(one([["a", true], ["a", false]]))).toBe(false);
    expect(isEditorLayout({ groups: [], focusedGroupId: "1" })).toBe(false);
    expect(isEditorLayout({ groups: [{ id: "1", tabs: [{ noteId: 7 }], activeNoteId: null }], focusedGroupId: "1" })).toBe(false);
  });
});

describe("pinning a tab", () => {
  it("keeps it from being replaced", () => {
    const pinned = editorReducer(one([["a", true]]), { type: "pin", groupId: "1", noteId: "a" });

    expect(pinned).toEqual(one([["a", false]]));
    expect(editorReducer(pinned, { type: "open", noteId: "b", preview: true })).toEqual(one([["a", false], ["b", true]]));
  });

  it("leaves a pinned tab's layout as it was, so typing doesn't redraw it", () => {
    const layout = one([["a", false]]);

    expect(editorReducer(layout, { type: "pin", groupId: "1", noteId: "a" })).toBe(layout);
  });
});
