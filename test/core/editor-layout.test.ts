import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT, editorReducer, focused, isEditorLayout, keptLayout, type EditorAction, type EditorLayout, type Opened } from "../../src/web/editorLayout.ts";

const note = (id: string) => ({ kind: "note" as const, id });
const folder = (id: string) => ({ kind: "folder" as const, id });

const one = (tabs: [string, boolean][], active: string | null = tabs.at(-1)?.[0] ?? null): EditorLayout => ({
  groups: [{ id: "1", tabs: tabs.map(([id, preview]) => ({ kind: "note", id, preview })), active: active === null ? null : note(active) }],
  focusedGroupId: "1",
});

describe("opening a note", () => {
  it("as a preview replaces the group's preview tab in place", () => {
    const layout = one([["a", false], ["b", true], ["c", false]], "c");

    expect(editorReducer(layout, { type: "open", tab: note("d"), preview: true })).toEqual(one([["a", false], ["d", true], ["c", false]], "d"));
  });

  it("as a preview with no preview tab adds one after the active tab", () => {
    const layout = one([["a", false], ["b", false]], "a");

    expect(editorReducer(layout, { type: "open", tab: note("c"), preview: true })).toEqual(one([["a", false], ["c", true], ["b", false]], "c"));
  });

  it("pinned keeps the preview tab and adds its own after the active tab", () => {
    const layout = one([["a", true]], "a");

    expect(editorReducer(layout, { type: "open", tab: note("b"), preview: false })).toEqual(one([["a", true], ["b", false]], "b"));
  });

  it("that already has a tab activates it, and opening it pinned pins it", () => {
    const layout = one([["a", true], ["b", false]], "b");

    expect(editorReducer(layout, { type: "open", tab: note("a"), preview: true })).toEqual(one([["a", true], ["b", false]], "a"));
    expect(editorReducer(layout, { type: "open", tab: note("a"), preview: false })).toEqual(one([["a", false], ["b", false]], "a"));
    expect(editorReducer(one([["a", false]]), { type: "open", tab: note("a"), preview: true })).toEqual(one([["a", false]]));
  });

  it("goes into the focused group", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: true }], active: note("a") },
        { id: "2", tabs: [], active: null },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(layout, { type: "open", tab: note("b"), preview: true }).groups).toEqual([
      { id: "1", tabs: [{ kind: "note", id: "a", preview: true }], active: note("a") },
      { id: "2", tabs: [{ kind: "note", id: "b", preview: true }], active: note("b") },
    ]);
  });
});

describe("opening a note that has a tab in another group", () => {
  it("shows it there and focuses that group, so one note never has two editors", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: true }, { kind: "note", id: "b", preview: false }], active: note("b") },
        { id: "2", tabs: [{ kind: "note", id: "c", preview: false }], active: note("c") },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(layout, { type: "open", tab: note("a"), preview: false })).toEqual({
      groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { kind: "note", id: "b", preview: false }], active: note("a") }, layout.groups[1]],
      focusedGroupId: "1",
    });
  });
});

describe("closing tabs", () => {
  const abcd = one([["a", false], ["b", false], ["c", false], ["d", false]], "b");
  const close = (scope: "tab" | "others" | "all" | "left" | "right", noteId: string, layout = abcd) =>
    editorReducer(layout, { type: "close", scope, groupId: "1", tab: note(noteId) });

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
        { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") },
        { id: "2", tabs: [{ kind: "note", id: "b", preview: false }], active: note("b") },
      ],
      focusedGroupId: "2",
    };

    expect(editorReducer(two, { type: "close", scope: "tab", groupId: "2", tab: note("b") })).toEqual({ groups: [two.groups[0]], focusedGroupId: "1" });
    expect(editorReducer(two, { type: "close", scope: "all", groupId: "1", tab: note("a") })).toEqual({ groups: [two.groups[1]], focusedGroupId: "2" });
    expect(editorReducer({ ...two, focusedGroupId: "1" }, { type: "close", scope: "tab", groupId: "2", tab: note("b") })).toEqual({
      groups: [two.groups[0]],
      focusedGroupId: "1",
    });
  });
});

describe("splitting", () => {
  const layout: EditorLayout = {
    groups: [
      { id: "1", tabs: [{ kind: "note", id: "a", preview: true }], active: note("a") },
      { id: "3", tabs: [{ kind: "note", id: "b", preview: false }], active: note("b") },
    ],
    focusedGroupId: "1",
  };

  it("puts the note pinned in a new focused group on the side asked for", () => {
    expect(editorReducer(layout, { type: "split", groupId: "1", side: "right", tab: note("c") })).toEqual({
      groups: [layout.groups[0], { id: "4", tabs: [{ kind: "note", id: "c", preview: false }], active: note("c") }, layout.groups[1]],
      focusedGroupId: "4",
    });
    expect(editorReducer(layout, { type: "split", groupId: "3", side: "left", tab: note("c") })).toEqual({
      groups: [layout.groups[0], { id: "4", tabs: [{ kind: "note", id: "c", preview: false }], active: note("c") }, layout.groups[1]],
      focusedGroupId: "4",
    });
  });

  it("moves a note that already has a tab, and the group it empties goes", () => {
    const ab: EditorLayout = { groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { kind: "note", id: "b", preview: true }], active: note("b") }], focusedGroupId: "1" };

    expect(editorReducer(ab, { type: "split", groupId: "1", side: "right", tab: note("b") })).toEqual({
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") },
        { id: "2", tabs: [{ kind: "note", id: "b", preview: false }], active: note("b") },
      ],
      focusedGroupId: "2",
    });
    expect(editorReducer(layout, { type: "split", groupId: "1", side: "left", tab: note("b") })).toEqual({
      groups: [{ id: "4", tabs: [{ kind: "note", id: "b", preview: false }], active: note("b") }, layout.groups[0]],
      focusedGroupId: "4",
    });
  });

  it("from a workspace with nothing open leaves one group", () => {
    const empty: EditorLayout = { groups: [{ id: "1", tabs: [], active: null }], focusedGroupId: "1" };

    expect(editorReducer(empty, { type: "split", groupId: "1", side: "right", tab: note("a") })).toEqual({
      groups: [{ id: "2", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") }],
      focusedGroupId: "2",
    });
  });
});

describe("dropping a note on a tab bar", () => {
  const layout: EditorLayout = {
    groups: [
      { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") },
      { id: "2", tabs: [{ kind: "note", id: "b", preview: false }, { kind: "note", id: "c", preview: true }, { kind: "note", id: "d", preview: false }], active: note("b") },
    ],
    focusedGroupId: "1",
  };
  const drop = (noteId: string, index: number) => editorReducer(layout, { type: "drop", groupId: "2", index, tab: note(noteId) });

  it("adds it pinned at that spot, active in a focused group", () => {
    expect(drop("x", 1)).toEqual({
      groups: [layout.groups[0], { id: "2", tabs: [{ kind: "note", id: "b", preview: false }, { kind: "note", id: "x", preview: false }, { kind: "note", id: "c", preview: true }, { kind: "note", id: "d", preview: false }], active: note("x") }],
      focusedGroupId: "2",
    });
  });

  it("moves a tab the group already has to that spot and pins it", () => {
    expect(drop("c", 0).groups[1]!.tabs).toEqual([{ kind: "note", id: "c", preview: false }, { kind: "note", id: "b", preview: false }, { kind: "note", id: "d", preview: false }]);
    expect(drop("b", 3).groups[1]!.tabs).toEqual([{ kind: "note", id: "c", preview: true }, { kind: "note", id: "d", preview: false }, { kind: "note", id: "b", preview: false }]);
  });
});

describe("dropping a tab from another group on a tab bar", () => {
  it("moves it, and the group it empties goes", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") },
        { id: "2", tabs: [{ kind: "note", id: "b", preview: false }], active: note("b") },
      ],
      focusedGroupId: "1",
    };

    expect(editorReducer(layout, { type: "drop", groupId: "2", index: 1, tab: note("a") })).toEqual({
      groups: [{ id: "2", tabs: [{ kind: "note", id: "b", preview: false }, { kind: "note", id: "a", preview: false }], active: note("a") }],
      focusedGroupId: "2",
    });
  });
});

describe("activating a tab", () => {
  it("shows it and focuses its group", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") },
        { id: "2", tabs: [{ kind: "note", id: "b", preview: false }, { kind: "note", id: "c", preview: false }], active: note("b") },
      ],
      focusedGroupId: "1",
    };

    expect(editorReducer(layout, { type: "activate", groupId: "2", tab: note("c") })).toEqual({
      groups: [layout.groups[0], { ...layout.groups[1], active: note("c") }],
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
    expect(isEditorLayout({ groups: [{ id: "1", tabs: [{ noteId: 7 }], active: null }], focusedGroupId: "1" })).toBe(false);
  });
});

describe("pinning a tab", () => {
  it("keeps it from being replaced", () => {
    const pinned = editorReducer(one([["a", true]]), { type: "pin", groupId: "1", tab: note("a") });

    expect(pinned).toEqual(one([["a", false]]));
    expect(editorReducer(pinned, { type: "open", tab: note("b"), preview: true })).toEqual(one([["a", false], ["b", true]]));
  });

  it("leaves a pinned tab's layout as it was, so typing doesn't redraw it", () => {
    const layout = one([["a", false]]);

    expect(editorReducer(layout, { type: "pin", groupId: "1", tab: note("a") })).toBe(layout);
  });
});

describe("a folder's tab", () => {
  const group = (tabs: [Opened, boolean][], active: Opened): EditorLayout => ({ groups: [{ id: "1", tabs: tabs.map(([tab, preview]) => ({ ...tab, preview })), active }], focusedGroupId: "1" });
  const previews = (layout: EditorLayout) => layout.groups.map((g) => g.tabs.filter((t) => t.preview).length);

  it("is kept when a note is previewed from it, and the note is then the group's one preview", () => {
    const list = group([[folder("f"), true]], folder("f"));
    const opened = editorReducer(list, { type: "open", tab: note("a"), preview: true });
    expect(opened).toEqual(group([[folder("f"), false], [note("a"), true]], note("a")));

    // The next note looked at from the list takes the first one's place, and the list stays.
    const back = editorReducer(opened, { type: "activate", groupId: "1", tab: folder("f") });
    expect(editorReducer(back, { type: "open", tab: note("b"), preview: true })).toEqual(group([[folder("f"), false], [note("b"), true]], note("b")));
  });

  it("as a preview takes the place of the group's preview whatever that is of, and gives its own to the next thing previewed from anywhere else", () => {
    const reading = group([[folder("f"), false], [note("a"), true]], note("a"));
    expect(editorReducer(reading, { type: "open", tab: folder("g"), preview: true })).toEqual(group([[folder("f"), false], [folder("g"), true]], folder("g")));
    expect(editorReducer(reading, { type: "open", tab: note("b"), preview: true })).toEqual(group([[folder("f"), false], [note("b"), true]], note("b")));

    const list = group([[folder("f"), true], [note("k"), false]], folder("f"));
    expect(editorReducer(list, { type: "open", tab: folder("g"), preview: true })).toEqual(group([[folder("g"), true], [note("k"), false]], folder("g")));
    // A list previewed and left behind another tab isn't where the note was opened from, so it gives way.
    const behind = group([[folder("f"), true], [note("k"), false]], note("k"));
    expect(editorReducer(behind, { type: "open", tab: note("b"), preview: true })).toEqual(group([[note("b"), true], [note("k"), false]], note("b")));
  });

  it("never leaves a group with two previews, whatever is opened in whatever order", () => {
    const things = [folder("f"), folder("g"), note("a"), note("b"), note("c")];
    let layout: EditorLayout = EMPTY_LAYOUT;
    for (let step = 0; step < 400; step++) {
      const tab = things[(step * 7 + (step >> 2)) % things.length]!;
      const action: EditorAction =
        step % 11 === 5
          ? { type: "split", groupId: layout.focusedGroupId, side: "right", tab }
          : step % 13 === 6
            ? { type: "activate", groupId: layout.focusedGroupId, tab: layout.groups.find((g) => g.id === layout.focusedGroupId)!.tabs[0] ?? tab }
            : { type: "open", tab, preview: step % 5 !== 0, background: step % 9 === 4 };
      layout = editorReducer(layout, action);
      expect(Math.max(...previews(layout)), `step ${step}`).toBeLessThanOrEqual(1);
    }
    expect(layout.groups.length).toBeGreaterThan(1);
  });

  it("has one preview in each group of a split: a preview opened in one leaves the other's alone", () => {
    const split: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "folder", id: "f", preview: true }], active: folder("f") },
        { id: "2", tabs: [{ kind: "note", id: "k", preview: false }, { kind: "note", id: "a", preview: true }], active: note("a") },
      ],
      focusedGroupId: "2",
    };
    const opened = editorReducer(split, { type: "open", tab: folder("g"), preview: true });
    expect(opened.groups).toEqual([split.groups[0], { id: "2", tabs: [{ kind: "note", id: "k", preview: false }, { kind: "folder", id: "g", preview: true }], active: folder("g") }]);
    expect(previews(editorReducer({ ...opened, focusedGroupId: "1" }, { type: "open", tab: note("b"), preview: true }))).toEqual([1, 1]);
  });

  it("opened behind is a kept tab, and the group's preview is as it was", () => {
    const list = group([[folder("f"), true]], folder("f"));
    expect(editorReducer(list, { type: "open", tab: note("a"), preview: false, background: true })).toEqual(group([[folder("f"), true], [note("a"), false]], folder("f")));
  });

  it("is kept when opened pinned, and the next folder previewed gets a tab of its own", () => {
    const kept = editorReducer(group([[folder("f"), true], [note("a"), false]], note("a")), { type: "open", tab: folder("f"), preview: false });

    expect(kept.groups[0]!.tabs[0]).toEqual({ kind: "folder", id: "f", preview: false });
    expect(editorReducer(kept, { type: "open", tab: folder("g"), preview: true }).groups[0]!.tabs).toEqual([
      { kind: "folder", id: "f", preview: false },
      { kind: "note", id: "a", preview: false },
      { kind: "folder", id: "g", preview: true },
    ]);
  });

  it("is a different tab from a note with the same id, and closes, splits and drops as a note's does", () => {
    const both: EditorLayout = { groups: [{ id: "1", tabs: [{ kind: "folder", id: "x", preview: false }, { kind: "note", id: "x", preview: false }], active: note("x") }], focusedGroupId: "1" };

    expect(isEditorLayout(both)).toBe(true);
    expect(editorReducer(both, { type: "close", scope: "tab", groupId: "1", tab: note("x") }).groups[0]).toEqual({ id: "1", tabs: [{ kind: "folder", id: "x", preview: false }], active: folder("x") });
    const split = editorReducer(both, { type: "split", groupId: "1", side: "left", tab: folder("x") });
    expect(split).toEqual({
      groups: [
        { id: "2", tabs: [{ kind: "folder", id: "x", preview: false }], active: folder("x") },
        { id: "1", tabs: [{ kind: "note", id: "x", preview: false }], active: note("x") },
      ],
      focusedGroupId: "2",
    });
    expect(focused(split)).toEqual(folder("x"));
    expect(editorReducer(split, { type: "drop", groupId: "1", index: 1, tab: folder("x") })).toEqual({
      groups: [{ id: "1", tabs: [{ kind: "note", id: "x", preview: false }, { kind: "folder", id: "x", preview: false }], active: folder("x") }],
      focusedGroupId: "1",
    });
  });
});

describe("opening a note in the background", () => {
  it("adds a kept tab, and what was showing stays showing", () => {
    const layout: EditorLayout = { groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { kind: "note", id: "c", preview: false }], active: note("a") }], focusedGroupId: "1" };

    expect(editorReducer(layout, { type: "open", tab: note("b"), preview: false, background: true })).toEqual({
      groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { kind: "note", id: "b", preview: false }, { kind: "note", id: "c", preview: false }], active: note("a") }],
      focusedGroupId: "1",
    });
  });
});

describe("opening from a folder's list", () => {
  const listFirst: EditorLayout = { groups: [{ id: "1", tabs: [{ kind: "folder", id: "f", preview: true }, { kind: "note", id: "a", preview: false }], active: folder("f") }], focusedGroupId: "1" };

  it("puts each new tab last, so notes opened one after another stand in the order they were opened", () => {
    const behind = editorReducer(listFirst, { type: "open", tab: note("b"), preview: false, background: true });
    expect(behind.groups[0]!.tabs.map((t) => t.id)).toEqual(["f", "a", "b"]);
    expect(behind.groups[0]!.active).toEqual(folder("f"));

    const inFront = editorReducer(listFirst, { type: "open", tab: note("b"), preview: false });
    expect(inFront.groups[0]!.tabs.map((t) => t.id)).toEqual(["f", "a", "b"]);
    expect(inFront.groups[0]!.active).toEqual(note("b"));
  });

  it("keeps the tab of a note that already has one, in whichever group, and changes nothing else", () => {
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "folder", id: "f", preview: true }], active: folder("f") },
        { id: "2", tabs: [{ kind: "note", id: "a", preview: true }], active: note("a") },
      ],
      focusedGroupId: "1",
    };

    const kept = editorReducer(layout, { type: "open", tab: note("a"), preview: false, background: true });
    expect(kept).toEqual({ groups: [layout.groups[0], { id: "2", tabs: [{ kind: "note", id: "a", preview: false }], active: note("a") }], focusedGroupId: "1" });
    expect(editorReducer(kept, { type: "open", tab: note("a"), preview: false, background: true })).toBe(kept);
  });
});

describe("a layout kept before folders had tabs", () => {
  it("is read with every tab a note's", () => {
    const old = {
      groups: [
        { id: "1", tabs: [{ noteId: "a", preview: true }, { noteId: "b", preview: false }], activeNoteId: "b" },
        { id: "3", tabs: [], activeNoteId: null },
      ],
      focusedGroupId: "3",
    };

    expect(keptLayout(old)).toEqual({
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: true }, { kind: "note", id: "b", preview: false }], active: note("b") },
        { id: "3", tabs: [], active: null },
      ],
      focusedGroupId: "3",
    });
  });

  it("kept when a group could have a preview of each kind has one a group: the tab showing, and the other is a kept tab", () => {
    const two = (active: Opened) => ({
      groups: [
        { id: "1", tabs: [{ kind: "folder", id: "f", preview: true }, { kind: "note", id: "k", preview: false }, { kind: "note", id: "a", preview: true }], active },
        { id: "2", tabs: [{ kind: "note", id: "b", preview: true }], active: note("b") },
      ],
      focusedGroupId: "1",
    });
    const tabs = (layout: EditorLayout) => layout.groups[0]!.tabs.map((t) => [t.id, t.preview]);

    expect(tabs(keptLayout(two(folder("f"))))).toEqual([["f", true], ["k", false], ["a", false]]);
    expect(tabs(keptLayout(two(note("a"))))).toEqual([["f", false], ["k", false], ["a", true]]);
    // With neither showing, the one opened last is the preview.
    expect(tabs(keptLayout(two(note("k"))))).toEqual([["f", false], ["k", false], ["a", true]]);
    expect(keptLayout(two(note("a"))).groups[1]).toEqual(two(note("a")).groups[1]);
    expect(keptLayout(two(note("a"))).groups[0]!.active).toEqual(note("a"));
  });

  it("is dropped for the empty layout when it can't be used in either shape", () => {
    expect(keptLayout({ groups: [{ id: "1", tabs: [{ noteId: "a", preview: true }], activeNoteId: "b" }], focusedGroupId: "1" })).toBe(EMPTY_LAYOUT);
    expect(keptLayout("nonsense")).toBe(EMPTY_LAYOUT);
    expect(keptLayout(one([["a", true]]))).toEqual(one([["a", true]]));
  });
});
