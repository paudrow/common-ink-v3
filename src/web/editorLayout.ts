import { z } from "zod";

/** A note open in a group. A preview tab is replaced by the next note opened as a preview. */
export interface Tab {
  noteId: string;
  preview: boolean;
}

export interface Group {
  id: string;
  tabs: Tab[];
  activeNoteId: string | null;
}

/** Editor groups side by side, left to right. A note has a tab in at most one group, so no two editors hold the same note. */
export interface EditorLayout {
  groups: Group[];
  focusedGroupId: string;
}

export const EMPTY_LAYOUT: EditorLayout = { groups: [{ id: "1", tabs: [], activeNoteId: null }], focusedGroupId: "1" };

const Stored = z
  .object({
    groups: z
      .array(z.object({ id: z.string(), tabs: z.array(z.object({ noteId: z.string(), preview: z.boolean() })), activeNoteId: z.string().nullable() }))
      .min(1),
    focusedGroupId: z.string(),
  })
  .refine((l) => {
    const noteIds = l.groups.flatMap((g) => g.tabs.map((t) => t.noteId));
    return (
      l.groups.some((g) => g.id === l.focusedGroupId) &&
      l.groups.every((g) => g.activeNoteId === null || g.tabs.some((t) => t.noteId === g.activeNoteId)) &&
      new Set(noteIds).size === noteIds.length
    );
  });

export const isEditorLayout = (v: unknown): v is EditorLayout => Stored.safeParse(v).success;

export const focusedNoteId = (layout: EditorLayout) => layout.groups.find((g) => g.id === layout.focusedGroupId)!.activeNoteId;

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
  | { type: "open"; noteId: string; preview: boolean }
  | { type: "pin"; groupId: string; noteId: string }
  | { type: "close"; scope: CloseScope; groupId: string; noteId: string }
  | { type: "activate"; groupId: string; noteId: string }
  | { type: "focus"; groupId: string }
  /** Moves the note into a new group beside `groupId`. */
  | { type: "split"; groupId: string; side: "left" | "right"; noteId: string }
  /** `index` is the gap between tabs the note was dropped in, counting from 0 at the far left. */
  | { type: "drop"; groupId: string; index: number; noteId: string };

const withGroup = (layout: EditorLayout, id: string, change: (group: Group) => Group): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === id ? change(g) : g)),
});

function open(group: Group, noteId: string, preview: boolean): Group {
  const existing = group.tabs.findIndex((t) => t.noteId === noteId);
  const replacing = preview ? group.tabs.findIndex((t) => t.preview) : -1;
  const tabs = [...group.tabs];
  if (existing >= 0) tabs[existing] = { noteId, preview: tabs[existing]!.preview && preview };
  else if (replacing >= 0) tabs[replacing] = { noteId, preview };
  else tabs.splice(group.tabs.findIndex((t) => t.noteId === group.activeNoteId) + 1 || tabs.length, 0, { noteId, preview });
  return { ...group, tabs, activeNoteId: noteId };
}

/** When the active tab closes, the nearest tab still open takes over, looking right first. */
function close(group: Group, scope: CloseScope, noteId: string): Group {
  const at = group.tabs.findIndex((t) => t.noteId === noteId);
  const kept = group.tabs.map((_, i) => KEEPS[scope](i, at));
  const active = group.tabs.findIndex((t) => t.noteId === group.activeNoteId);
  const right = kept.indexOf(true, active + 1);
  const next = active < 0 || kept[active] ? active : right >= 0 ? right : kept.lastIndexOf(true, active);
  return { ...group, tabs: group.tabs.filter((_, i) => kept[i]), activeNoteId: group.tabs[next]?.noteId ?? null };
}

/** A group with no tabs goes, unless it's the only one; focus moves to its left neighbour, or else its right. */
function dropEmpty(layout: EditorLayout): EditorLayout {
  const empty = layout.groups.findIndex((g) => !g.tabs.length);
  if (empty < 0 || layout.groups.length === 1) return layout;
  const groups = layout.groups.filter((_, i) => i !== empty);
  const focusedGroupId = layout.groups[empty]!.id === layout.focusedGroupId ? groups[Math.max(0, empty - 1)]!.id : layout.focusedGroupId;
  return { groups, focusedGroupId };
}

/** Takes a note's tab out of every group but `keepIn`, ahead of placing it somewhere else. */
const lift = (layout: EditorLayout, noteId: string, keepIn?: string): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === keepIn ? g : close(g, "tab", noteId))),
});

export function editorReducer(layout: EditorLayout, action: EditorAction): EditorLayout {
  switch (action.type) {
    case "open": {
      const groupId = layout.groups.find((g) => g.tabs.some((t) => t.noteId === action.noteId))?.id ?? layout.focusedGroupId;
      return { ...withGroup(layout, groupId, (g) => open(g, action.noteId, action.preview)), focusedGroupId: groupId };
    }
    case "pin": {
      const group = layout.groups.find((g) => g.id === action.groupId);
      if (!group?.tabs.some((t) => t.noteId === action.noteId && t.preview)) return layout;
      return withGroup(layout, group.id, (g) => ({ ...g, tabs: g.tabs.map((t) => (t.noteId === action.noteId ? { ...t, preview: false } : t)) }));
    }
    case "close":
      return dropEmpty(withGroup(layout, action.groupId, (g) => close(g, action.scope, action.noteId)));
    case "activate":
      return { ...withGroup(layout, action.groupId, (g) => ({ ...g, activeNoteId: action.noteId })), focusedGroupId: action.groupId };
    case "focus":
      return layout.focusedGroupId === action.groupId ? layout : { ...layout, focusedGroupId: action.groupId };
    case "split": {
      const id = String(Math.max(...layout.groups.map((g) => Number(g.id))) + 1);
      const groups = lift(layout, action.noteId).groups;
      const at = groups.findIndex((g) => g.id === action.groupId) + (action.side === "right" ? 1 : 0);
      groups.splice(at, 0, { id, tabs: [{ noteId: action.noteId, preview: false }], activeNoteId: action.noteId });
      return dropEmpty({ groups, focusedGroupId: id });
    }
    case "drop": {
      const placed = withGroup(lift(layout, action.noteId, action.groupId), action.groupId, (g) => {
        const from = g.tabs.findIndex((t) => t.noteId === action.noteId);
        const tabs = g.tabs.filter((t) => t.noteId !== action.noteId);
        tabs.splice(from >= 0 && from < action.index ? action.index - 1 : action.index, 0, { noteId: action.noteId, preview: false });
        return { ...g, tabs, activeNoteId: action.noteId };
      });
      return dropEmpty({ ...placed, focusedGroupId: action.groupId });
    }
  }
}
