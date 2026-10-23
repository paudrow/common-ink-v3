import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT, editorReducer, isEditorLayout, keptLayout, type EditorAction, type EditorLayout, type Opened, type Side } from "../../src/web/plugins/tabs/editorLayout.ts";

const THINGS: Opened[] = [
  ...["a", "b", "c", "d"].map((id) => ({ kind: "note" as const, id })),
  ...["f", "g", "all"].map((id) => ({ kind: "folder" as const, id })),
  ...["search", "todos"].map((id) => ({ kind: "page" as const, id, path: `/${id}` })),
];
const SIDES: Side[] = ["left", "right", "up", "down"];

/** The same numbers for the same seed, so a run that fails can be run again. */
function numbers(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * below);
  };
}

/** Anything a member can do to the layout, picked from what the layout has just now. */
function anyAction(layout: EditorLayout, pick: (below: number) => number): EditorAction {
  const group = layout.groups[pick(layout.groups.length)]!;
  const tab = THINGS[pick(THINGS.length)]!;
  const held = group.tabs.length ? group.tabs[pick(group.tabs.length)]! : tab;
  // Dragged out of a group, or from outside them all, as a card is.
  const from = () => (pick(2) ? { from: layout.groups[pick(layout.groups.length)]!.id } : {});
  const kinds: (() => EditorAction)[] = [
    () => ({ type: "open", tab, preview: true }),
    () => ({ type: "open", tab, preview: true, here: true }),
    () => ({ type: "open", tab, preview: false }),
    () => ({ type: "open", tab, preview: pick(2) === 0, background: true }),
    () => ({ type: "split", groupId: group.id, side: SIDES[pick(4)]!, tab: pick(2) ? held : tab, keep: pick(2) === 0, ...from() }),
    () => ({ type: "add", groupId: group.id, tab: pick(2) ? held : tab, ...from() }),
    () => ({ type: "drop", groupId: group.id, index: pick(group.tabs.length + 1), tab: pick(2) ? held : tab, ...from() }),
    () => (group.tabs.length ? { type: "activate", groupId: group.id, tab: held } : { type: "focus", groupId: group.id }),
    () => ({ type: "focus", groupId: group.id }),
    () => ({ type: "pin", groupId: group.id, tab: held }),
    () => ({ type: "close", scope: (["tab", "others", "left", "right", "all"] as const)[pick(5)]!, groupId: group.id, tab: held }),
  ];
  return kinds[pick(kinds.length)]!();
}

/** What a member does to say a tab is to stay: keep it, open it kept or behind, or drag it somewhere. Nothing else may turn a preview into a kept tab. */
const keeps = (action: EditorAction) =>
  action.type === "pin" || action.type === "drop" || action.type === "add" || (action.type === "split" && action.keep === true) || (action.type === "open" && (!action.preview || action.background === true));
const keyOf = (tab: Opened) => `${tab.kind} ${tab.id}`;

const previewsIn = (layout: EditorLayout) => layout.groups.flatMap((g) => g.tabs.filter((t) => t.preview).map((tab) => ({ groupId: g.id, tab })));
/** The tab the preview was, after an action: in its group still, or, for a folder or a page, which has one tab only, wherever it went. A note's tab in another group is another tab of it. */
const nowOf = (layout: EditorLayout, was: { groupId: string; tab: Opened }) =>
  layout.groups.find((g) => g.id === was.groupId)?.tabs.find((t) => keyOf(t) === keyOf(was.tab)) ?? (was.tab.kind === "note" ? undefined : layout.groups.flatMap((g) => g.tabs).find((t) => keyOf(t) === keyOf(was.tab)));

describe("the window's preview tab", () => {
  it("is never more than one across every group, and is kept only by the member's saying so, whatever is opened, split, moved, dropped and closed in whatever order", () => {
    let most = 0;
    let split = 0;
    let converted = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const pick = numbers(seed);
      let layout = EMPTY_LAYOUT;
      for (let step = 0; step < 250; step++) {
        const action = anyAction(layout, pick);
        const was = previewsIn(layout)[0];
        // A preview that is all its pane has is kept there when the next preview opens in another pane, so no pane closes.
        const alone = !!was && action.type === "open" && layout.groups.find((g) => g.id === was.groupId)!.tabs.length === 1;
        const groupsBefore = layout.groups.map((g) => g.id);
        layout = editorReducer(layout, action);
        if (action.type === "open" && layout.groups.map((g) => g.id).join() !== groupsBefore.join()) throw new Error(`seed ${seed}, step ${step}: a group came or went by ${JSON.stringify(action)}`);
        const previews = previewsIn(layout);
        // The preview is still one, or has gone: it is a kept tab only by the member's saying so.
        const now = was && nowOf(layout, was);
        if (now && !now.preview && !keeps(action) && !alone) throw new Error(`seed ${seed}, step ${step}: ${keyOf(was!.tab)} was kept by ${JSON.stringify(action)}`);
        if (now && !now.preview) converted++;
        if (previews.length > 1) throw new Error(`seed ${seed}, step ${step}: ${previews.length} previews after ${JSON.stringify(action)}`);
        most = Math.max(most, previews.length);
        split = Math.max(split, layout.groups.length);
        // What a browser would keep reads back as it is: there is nothing for the reading to put right.
        if (!isEditorLayout(layout)) throw new Error(`seed ${seed}, step ${step}: not a layout after ${JSON.stringify(action)}`);
        if (step % 50 === 0) expect(keptLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
      }
    }
    // The runs did reach a preview, and a window split several ways.
    expect(most).toBe(1);
    expect(split).toBeGreaterThan(3);
    expect(converted).toBeGreaterThan(50);
  });

  it("comes to the group in front when the next thing is previewed there, and one that is all its group has is kept there, so the group stays", () => {
    const page = { kind: "page" as const, id: "todos", path: "/todos" };
    const layout: EditorLayout = {
      groups: [
        { id: "1", tabs: [{ kind: "note", id: "a", preview: false }], active: { kind: "note", id: "a" } },
        { id: "2", tabs: [{ kind: "folder", id: "all", preview: true }], active: { kind: "folder", id: "all" } },
      ],
      focusedGroupId: "1",
    };
    expect(editorReducer(layout, { type: "open", tab: page, preview: true })).toEqual({
      groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { ...page, preview: true }], active: page }, { ...layout.groups[1], tabs: [{ kind: "folder", id: "all", preview: false }] }],
      focusedGroupId: "1",
    });
    // With no preview anywhere, it opens in the group in front.
    const kept = editorReducer(layout, { type: "pin", groupId: "2", tab: { kind: "folder", id: "all" } });
    expect(editorReducer(kept, { type: "open", tab: page, preview: true })).toEqual({
      groups: [{ id: "1", tabs: [{ kind: "note", id: "a", preview: false }, { ...page, preview: true }], active: page }, kept.groups[1]],
      focusedGroupId: "1",
    });
  });

  it("is one in any layout that is read, with every tab still there", () => {
    const pick = numbers(7);
    for (let run = 0; run < 200; run++) {
      const groups = Array.from({ length: 1 + pick(4) }, (_, g) => {
        const tabs = THINGS.filter((_, i) => i % 4 === g && pick(3) > 0).map((tab) => ({ ...tab, preview: pick(2) === 0 }));
        const front = tabs[pick(tabs.length || 1)];
        return { id: String(g + 1), tabs, active: front ? (({ preview: _, ...ref }) => ref)(front) : null };
      });
      const kept = { groups, focusedGroupId: groups[pick(groups.length)]!.id };
      const read = keptLayout(kept);
      expect(previewsIn(read).length).toBe(Math.min(1, previewsIn(kept).length));
      expect(read.groups.map((g) => g.tabs.map((t) => `${t.kind} ${t.id}`))).toEqual(groups.map((g) => g.tabs.map((t) => `${t.kind} ${t.id}`)));
      const focus = groups.find((g) => g.id === kept.focusedGroupId)!;
      if (focus.tabs.some((t) => t.preview)) expect(read.groups.find((g) => g.id === focus.id)!.tabs.filter((t) => t.preview).length).toBe(1);
    }
  });
});
