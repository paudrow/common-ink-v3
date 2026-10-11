import { z } from "zod";

/** What a tab holds: a note, or a folder's list of notes. It is the plugin API's `Opened`, written here so the layout stands on its own. */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string };

/** A note or a folder's list open in a group. A group has at most one preview tab, which the next thing opened as a preview takes the place of. */
export type Tab = Opened & { preview: boolean };

export interface Group {
  id: string;
  tabs: Tab[];
  active: Opened | null;
}

/** Editor groups side by side, left to right. A note or a folder has a tab in at most one group, so no two editors hold the same note. */
export interface EditorLayout {
  groups: Group[];
  focusedGroupId: string;
}

export const EMPTY_LAYOUT: EditorLayout = { groups: [{ id: "1", tabs: [], active: null }], focusedGroupId: "1" };

export const same = (a: Opened | null, b: Opened | null) => a?.kind === b?.kind && a?.id === b?.id;
const has = (group: Group, tab: Opened) => group.tabs.some((t) => same(t, tab));
const indexOf = (group: Group, tab: Opened | null) => group.tabs.findIndex((t) => same(t, tab));

const Ref = z.object({ kind: z.enum(["note", "folder"]), id: z.string() });
const Stored = z
  .object({
    groups: z.array(z.object({ id: z.string(), tabs: z.array(Ref.extend({ preview: z.boolean() })), active: Ref.nullable() })).min(1),
    focusedGroupId: z.string(),
  })
  .refine((l) => {
    const keys = l.groups.flatMap((g) => g.tabs.map((t) => `${t.kind} ${t.id}`));
    return l.groups.some((g) => g.id === l.focusedGroupId) && l.groups.every((g) => g.active === null || has(g, g.active)) && new Set(keys).size === keys.length;
  });

/** How a layout was kept before a folder could have a tab: every tab was a note's. */
const StoredNotesOnly = z.object({
  groups: z.array(z.object({ id: z.string(), tabs: z.array(z.object({ noteId: z.string(), preview: z.boolean() })), activeNoteId: z.string().nullable() })),
  focusedGroupId: z.string(),
});

export const isEditorLayout = (v: unknown): v is EditorLayout => Stored.safeParse(v).success;

/** The layout a browser kept, in today's shape whichever shape it was kept in. One that can't be used is the empty layout. */
export function keptLayout(v: unknown): EditorLayout {
  const old = StoredNotesOnly.safeParse(v);
  const now = old.success
    ? {
        groups: old.data.groups.map((g) => ({
          id: g.id,
          tabs: g.tabs.map((t) => ({ kind: "note" as const, id: t.noteId, preview: t.preview })),
          active: g.activeNoteId === null ? null : { kind: "note" as const, id: g.activeNoteId },
        })),
        focusedGroupId: old.data.focusedGroupId,
      }
    : v;
  return isEditorLayout(now) ? { ...now, groups: now.groups.map(onePreview) } : EMPTY_LAYOUT;
}

/**
 * A group as it is allowed to be, from one kept when it could have a preview of each kind: the
 * preview is the tab showing, or else the one opened last, and any other is a kept tab.
 */
function onePreview(group: Group): Group {
  const previews = group.tabs.filter((t) => t.preview);
  if (previews.length < 2) return group;
  const stays = previews.find((t) => same(t, group.active)) ?? previews.at(-1)!;
  return { ...group, tabs: group.tabs.map((t) => (t.preview && t !== stays ? { ...t, preview: false } : t)) };
}

export const focused = (layout: EditorLayout) => layout.groups.find((g) => g.id === layout.focusedGroupId)!.active;

/** Which tabs a close keeps, given a tab's index and the index of the tab it was asked on. */
const KEEPS = {
  tab: (i: number, at: number) => i !== at,
  others: (i: number, at: number) => i === at,
  all: () => false,
  left: (i: number, at: number) => i >= at,
  right: (i: number, at: number) => i <= at,
};

export type CloseScope = keyof typeof KEEPS;

export type EditorAction =
  /** `background` adds a kept tab and leaves showing what is. A tab it already has is kept where it is. */
  | { type: "open"; tab: Opened; preview: boolean; background?: boolean }
  | { type: "pin"; groupId: string; tab: Opened }
  | { type: "close"; scope: CloseScope; groupId: string; tab: Opened }
  | { type: "activate"; groupId: string; tab: Opened }
  | { type: "focus"; groupId: string }
  /** Moves the tab into a new group beside `groupId`. */
  | { type: "split"; groupId: string; side: "left" | "right"; tab: Opened }
  /** `index` is the gap between tabs the tab was dropped in, counting from 0 at the far left. */
  | { type: "drop"; groupId: string; index: number; tab: Opened };

const withGroup = (layout: EditorLayout, id: string, change: (group: Group) => Group): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === id ? change(g) : g)),
});

/**
 * Where a new tab goes: right after the note showing, or last when a folder's list is showing, so
 * that notes opened one after another from a list stand in the order they were opened.
 */
const placeForNew = (group: Group) => (group.active?.kind === "note" && indexOf(group, group.active) + 1) || group.tabs.length;

/**
 * A group has one preview, and the next thing previewed takes its place, whatever either is of.
 * The one exception keeps a member's place: a note previewed while a previewed list is showing was
 * opened from that list, so the list becomes a kept tab, as a note does when it is edited, and the
 * note is the preview. Notes looked through from the list then replace one another beside it.
 */
function open(group: Group, tab: Opened, preview: boolean): Group {
  const existing = indexOf(group, tab);
  const tabs = [...group.tabs];
  if (existing >= 0) {
    tabs[existing] = { ...tab, preview: tabs[existing]!.preview && preview };
    return { ...group, tabs, active: tab };
  }
  const previewed = preview ? tabs.findIndex((t) => t.preview) : -1;
  const fromList = previewed >= 0 && tab.kind === "note" && tabs[previewed]!.kind === "folder" && same(tabs[previewed]!, group.active);
  if (fromList) tabs[previewed] = { ...tabs[previewed]!, preview: false };
  if (previewed >= 0 && !fromList) tabs[previewed] = { ...tab, preview };
  else tabs.splice(placeForNew(group), 0, { ...tab, preview });
  return { ...group, tabs, active: tab };
}

function openBehind(group: Group, tab: Opened): Group {
  const tabs = [...group.tabs];
  tabs.splice(placeForNew(group), 0, { ...tab, preview: false });
  return { ...group, tabs, active: group.active ?? tab };
}

/** When the active tab closes, the nearest tab still open takes over, looking right first. */
function close(group: Group, scope: CloseScope, tab: Opened): Group {
  const at = indexOf(group, tab);
  const kept = group.tabs.map((_, i) => KEEPS[scope](i, at));
  const active = indexOf(group, group.active);
  const right = kept.indexOf(true, active + 1);
  const next = active < 0 || kept[active] ? active : right >= 0 ? right : kept.lastIndexOf(true, active);
  const { kind, id } = group.tabs[next] ?? {};
  return { ...group, tabs: group.tabs.filter((_, i) => kept[i]), active: kind && id ? { kind, id } : null };
}

/** A group with no tabs goes, unless it's the only one; focus moves to its left neighbour, or else its right. */
function dropEmpty(layout: EditorLayout): EditorLayout {
  const empty = layout.groups.findIndex((g) => !g.tabs.length);
  if (empty < 0 || layout.groups.length === 1) return layout;
  const groups = layout.groups.filter((_, i) => i !== empty);
  const focusedGroupId = layout.groups[empty]!.id === layout.focusedGroupId ? groups[Math.max(0, empty - 1)]!.id : layout.focusedGroupId;
  return { groups, focusedGroupId };
}

/** Takes a tab out of every group but `keepIn`, ahead of placing it somewhere else. */
const lift = (layout: EditorLayout, tab: Opened, keepIn?: string): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === keepIn || !has(g, tab) ? g : close(g, "tab", tab))),
});

export function editorReducer(layout: EditorLayout, action: EditorAction): EditorLayout {
  const tab: Opened | null = "tab" in action ? { kind: action.tab.kind, id: action.tab.id } : null;
  // A group may have gone since the action was made, as when its last tab closed. The tab it names stays where it is.
  if ("groupId" in action && !layout.groups.some((g) => g.id === action.groupId)) return layout;
  switch (action.type) {
    case "open": {
      const holder = layout.groups.find((g) => has(g, tab!))?.id;
      if (action.background) return holder ? editorReducer(layout, { type: "pin", groupId: holder, tab: tab! }) : withGroup(layout, layout.focusedGroupId, (g) => openBehind(g, tab!));
      const groupId = holder ?? layout.focusedGroupId;
      return { ...withGroup(layout, groupId, (g) => open(g, tab!, action.preview)), focusedGroupId: groupId };
    }
    case "pin": {
      const group = layout.groups.find((g) => g.id === action.groupId);
      if (!group?.tabs.some((t) => same(t, tab) && t.preview)) return layout;
      return withGroup(layout, group.id, (g) => ({ ...g, tabs: g.tabs.map((t) => (same(t, tab) ? { ...t, preview: false } : t)) }));
    }
    case "close":
      return dropEmpty(withGroup(layout, action.groupId, (g) => close(g, action.scope, tab!)));
    case "activate":
      return { ...withGroup(layout, action.groupId, (g) => ({ ...g, active: tab })), focusedGroupId: action.groupId };
    case "focus":
      return layout.focusedGroupId === action.groupId ? layout : { ...layout, focusedGroupId: action.groupId };
    case "split": {
      const id = String(Math.max(...layout.groups.map((g) => Number(g.id))) + 1);
      const groups = lift(layout, tab!).groups;
      const at = groups.findIndex((g) => g.id === action.groupId) + (action.side === "right" ? 1 : 0);
      groups.splice(at, 0, { id, tabs: [{ ...tab!, preview: false }], active: tab });
      return dropEmpty({ groups, focusedGroupId: id });
    }
    case "drop": {
      const placed = withGroup(lift(layout, tab!, action.groupId), action.groupId, (g) => {
        const from = indexOf(g, tab);
        const tabs = g.tabs.filter((t) => !same(t, tab));
        tabs.splice(from >= 0 && from < action.index ? action.index - 1 : action.index, 0, { ...tab!, preview: false });
        return { ...g, tabs, active: tab };
      });
      return dropEmpty({ ...placed, focusedGroupId: action.groupId });
    }
  }
}
