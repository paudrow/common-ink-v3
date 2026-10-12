import { z } from "zod";

/**
 * What a tab holds, and what an address can name in the editor area: a note, a folder's list of
 * notes, or a page. A folder's `id` is a folder's id, or `all` for every note. A page's `path`,
 * the address it is at, is no part of which tab it is.
 */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; id: string; path: string };

/** A note, a folder's list or a page open in a group. A group has at most one preview tab, which the next thing opened as a preview takes the place of. */
export type Tab = Opened & { preview: boolean };

export interface Group {
  id: string;
  tabs: Tab[];
  active: Opened | null;
}

export type Direction = "row" | "column";
/** A group, by its id, or groups and splits laid along one direction. */
export type Pane = string | Split;
/** `sizes` are the panes' shares of the split's length, as weights: twice the number is twice the room. */
export interface Split {
  direction: Direction;
  panes: Pane[];
  sizes: number[];
}

/**
 * The editor groups and how they are arranged. A note, a folder or a page has a tab in at most one
 * group, so no two editors hold the same note. `groups` are in reading order. `split` says how they
 * are laid out, and is left out for the plainest way: side by side in one row, each as wide as the
 * next. So one arrangement is written one way, and a layout kept before a group could be split
 * down is still a layout.
 */
export interface EditorLayout {
  groups: Group[];
  focusedGroupId: string;
  split?: Split;
}

export const EMPTY_LAYOUT: EditorLayout = { groups: [{ id: "1", tabs: [], active: null }], focusedGroupId: "1" };

export const same = (a: Opened | null, b: Opened | null) => a?.kind === b?.kind && a?.id === b?.id;
/** What a tab holds, without whether it is a preview. A page's is the whole `Opened`, its address with it. */
const refOf = (tab: Opened): Opened => (tab.kind === "page" ? { kind: tab.kind, id: tab.id, path: tab.path } : { kind: tab.kind, id: tab.id });
const has = (group: Group, tab: Opened) => group.tabs.some((t) => same(t, tab));
const indexOf = (group: Group, tab: Opened | null) => group.tabs.findIndex((t) => same(t, tab));

const leaves = (pane: Pane): string[] => (typeof pane === "string" ? [pane] : pane.panes.flatMap(leaves));

const Ref = z.union([z.object({ kind: z.enum(["note", "folder"]), id: z.string() }), z.object({ kind: z.literal("page"), id: z.string(), path: z.string().regex(/^\/(?!\/)/) })]);
const StoredSplit: z.ZodType<Split> = z
  .object({ direction: z.enum(["row", "column"]), panes: z.array(z.union([z.string(), z.lazy(() => StoredSplit)])).min(1), sizes: z.array(z.number().positive()) })
  .refine((s) => s.panes.length === s.sizes.length);
const Stored = z
  .object({
    groups: z.array(z.object({ id: z.string(), tabs: z.array(Ref.and(z.object({ preview: z.boolean() }))), active: Ref.nullable() })).min(1),
    focusedGroupId: z.string(),
    split: StoredSplit.optional(),
  })
  .refine((l) => {
    const keys = l.groups.flatMap((g) => g.tabs.map((t) => `${t.kind} ${t.id}`));
    const ids = l.groups.map((g) => g.id);
    const placed = l.split ? leaves(l.split) : ids;
    return (
      l.groups.some((g) => g.id === l.focusedGroupId) &&
      l.groups.every((g) => g.active === null || has(g, g.active)) &&
      new Set(keys).size === keys.length &&
      new Set(ids).size === ids.length &&
      placed.length === ids.length &&
      ids.every((id) => placed.includes(id))
    );
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
  return isEditorLayout(now) ? arranged({ ...now, groups: now.groups.map(onePreview) }, arrangement(now)) : EMPTY_LAYOUT;
}

/** How the groups are laid out, said in full where the layout leaves it unsaid. */
export const arrangement = (layout: EditorLayout): Split => layout.split ?? { direction: "row", panes: layout.groups.map((g) => g.id), sizes: layout.groups.map(() => 1) };

/** A pane with no split of one pane in it, and no split laid inside another along the same direction. */
function tidied(pane: Pane): Pane {
  if (typeof pane === "string") return pane;
  const panes: Pane[] = [];
  const sizes: number[] = [];
  pane.panes.forEach((inner, i) => {
    const child = tidied(inner);
    const size = pane.sizes[i]!;
    if (typeof child === "string" || child.direction !== pane.direction) {
      panes.push(child);
      sizes.push(size);
      return;
    }
    const whole = child.sizes.reduce((a, b) => a + b, 0);
    child.panes.forEach((p, j) => {
      panes.push(p);
      sizes.push((size * child.sizes[j]!) / whole);
    });
  });
  return panes.length === 1 ? panes[0]! : { direction: pane.direction, panes, sizes };
}

/** The layout with its groups laid out as `root` says, written the one way a layout is written. */
function arranged(layout: EditorLayout, root: Pane): EditorLayout {
  const tidy = tidied(root);
  const order = leaves(tidy);
  const groups = order.map((id) => layout.groups.find((g) => g.id === id)!);
  const plain = typeof tidy === "string" || (tidy.direction === "row" && tidy.panes.every((p) => typeof p === "string") && tidy.sizes.every((s) => s === tidy.sizes[0]));
  const { split: _, ...rest } = layout;
  return plain ? { ...rest, groups } : { ...rest, groups, split: tidy };
}

function without(pane: Pane, id: string): Pane {
  if (typeof pane === "string") return pane;
  const staying = pane.panes.map((_, i) => i).filter((i) => pane.panes[i] !== id);
  return { ...pane, panes: staying.map((i) => without(pane.panes[i]!, id)), sizes: staying.map((i) => pane.sizes[i]!) };
}

export type Side = "left" | "right" | "up" | "down";
const ALONG: Record<Side, Direction> = { left: "row", right: "row", up: "column", down: "column" };
const BEFORE: Record<Side, boolean> = { left: true, right: false, up: true, down: false };

/**
 * Puts a new group on one side of another. Where that group already stands in a split along the
 * side's direction the new one joins it, as wide as the group it is beside; otherwise the two take
 * the group's place as a split of their own, half each.
 */
function beside(pane: Pane, id: string, added: string, side: Side): Pane {
  const pair = (): Pane[] => (BEFORE[side] ? [added, id] : [id, added]);
  if (typeof pane === "string") return pane === id ? { direction: ALONG[side], panes: pair(), sizes: [1, 1] } : pane;
  const at = pane.panes.indexOf(id);
  if (at < 0 || pane.direction !== ALONG[side]) return { ...pane, panes: pane.panes.map((p) => beside(p, id, added, side)) };
  return { ...pane, panes: pane.panes.flatMap((p) => (p === id ? pair() : [p])), sizes: pane.sizes.flatMap((s, i) => (i === at ? [s, s] : [s])) };
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
  | { type: "split"; groupId: string; side: Side; tab: Opened }
  /** `index` is the gap between tabs the tab was dropped in, counting from 0 at the far left. */
  | { type: "drop"; groupId: string; index: number; tab: Opened }
  /** Adds the tab to the end of a group's, as dropping it on the middle of the group does. */
  | { type: "add"; groupId: string; tab: Opened }
  /** Gives the panes of one split new shares of it. `path` is the way to the split from the outermost one: which pane, then which pane of that. */
  | { type: "resize"; path: number[]; sizes: number[] };

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
  const taking = group.tabs[next];
  return { ...group, tabs: group.tabs.filter((_, i) => kept[i]), active: taking ? refOf(taking) : null };
}

/** A group with no tabs goes, unless it's the only one; focus moves to its left neighbour, or else its right. */
function dropEmpty(layout: EditorLayout): EditorLayout {
  const empty = layout.groups.findIndex((g) => !g.tabs.length);
  if (empty < 0 || layout.groups.length === 1) return layout;
  const gone = layout.groups[empty]!.id;
  const groups = layout.groups.filter((_, i) => i !== empty);
  const focusedGroupId = gone === layout.focusedGroupId ? groups[Math.max(0, empty - 1)]!.id : layout.focusedGroupId;
  return arranged({ groups, focusedGroupId }, without(arrangement(layout), gone));
}

/** Takes a tab out of every group but `keepIn`, ahead of placing it somewhere else. */
const lift = (layout: EditorLayout, tab: Opened, keepIn?: string): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === keepIn || !has(g, tab) ? g : close(g, "tab", tab))),
});

export function editorReducer(layout: EditorLayout, action: EditorAction): EditorLayout {
  const tab: Opened | null = "tab" in action ? refOf(action.tab) : null;
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
      const groups = [...lift(layout, tab!).groups, { id, tabs: [{ ...tab!, preview: false }], active: tab }];
      return dropEmpty(arranged({ groups, focusedGroupId: id }, beside(arrangement(layout), action.groupId, id, action.side)));
    }
    case "add":
      return editorReducer(layout, { type: "drop", groupId: action.groupId, index: layout.groups.find((g) => g.id === action.groupId)?.tabs.length ?? 0, tab: tab! });
    case "resize": {
      const sized = (pane: Pane, path: number[]): Pane => {
        if (typeof pane === "string") return pane;
        const [at, ...rest] = path;
        if (at === undefined) return action.sizes.length === pane.panes.length && action.sizes.every((s) => s > 0) ? { ...pane, sizes: action.sizes } : pane;
        return { ...pane, panes: pane.panes.map((p, i) => (i === at ? sized(p, rest) : p)) };
      };
      return arranged(layout, sized(arrangement(layout), action.path));
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
