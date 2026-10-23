import { z } from "zod";

/**
 * What a tab holds: a note, a folder's list of notes, or a page. It is the plugin API's `Opened`,
 * written here so the layout stands on its own. A page is the same tab wherever under its path it
 * is, so `path`, the address it is at, is no part of which tab it is, unless the page has a tab for
 * each of several keys, as each tag's page does: `ownTab` is then the key of the one at this address,
 * which the Tabs plugin puts on it from what the page says.
 */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; id: string; path: string; ownTab?: string };

/** A note, a folder's list or a page open in a group. The window has at most one preview tab, which the next thing opened as a preview takes the place of. */
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
 * The editor groups and how they are arranged. A folder or a page has a tab in at most one group. A
 * note can have one in several, split off so two places in it show at once, and its editors share
 * one text. No group has two tabs of one thing. `groups` are in reading order. `split` says how they
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

/** The notes that have a tab in any group. */
export const notesIn = (layout: EditorLayout): Set<string> => new Set(layout.groups.flatMap((g) => g.tabs.flatMap((t) => (t.kind === "note" ? [t.id] : []))));

/** Which tab something is: no group has two with one key, and a folder or a page has one in one group at most. */
export const keyOf = (tab: Opened) => (tab.kind === "page" && tab.ownTab !== undefined ? `page ${tab.id} ${tab.ownTab}` : `${tab.kind} ${tab.id}`);
export const same = (a: Opened | null, b: Opened | null) => (a && b ? keyOf(a) === keyOf(b) : a === b);
/** What a tab holds, without whether it is a preview. A page's is the plugin API's whole `Opened`, its address with it. */
const refOf = (tab: Opened): Opened => (tab.kind === "page" ? { kind: tab.kind, id: tab.id, path: tab.path, ...(tab.ownTab !== undefined && { ownTab: tab.ownTab }) } : { kind: tab.kind, id: tab.id });
const has = (group: Group, tab: Opened) => group.tabs.some((t) => same(t, tab));
const indexOf = (group: Group, tab: Opened | null) => group.tabs.findIndex((t) => same(t, tab));

const leaves = (pane: Pane): string[] => (typeof pane === "string" ? [pane] : pane.panes.flatMap(leaves));

const Ref = z.union([z.object({ kind: z.enum(["note", "folder"]), id: z.string() }), z.object({ kind: z.literal("page"), id: z.string(), path: z.string().regex(/^\/(?!\/)/), ownTab: z.string().optional() })]);
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
    const keys = l.groups.flatMap((g) => g.tabs.flatMap((t) => (t.kind === "note" ? [] : [keyOf(t)])));
    const ids = l.groups.map((g) => g.id);
    const placed = l.split ? leaves(l.split) : ids;
    return (
      l.groups.some((g) => g.id === l.focusedGroupId) &&
      l.groups.every((g) => g.active === null || has(g, g.active)) &&
      new Set(keys).size === keys.length &&
      l.groups.every((g) => new Set(g.tabs.map(keyOf)).size === g.tabs.length) &&
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
  return isEditorLayout(now) ? arranged(onePreview(now), arrangement(now)) : EMPTY_LAYOUT;
}

/** A tab as the layout keys it: for a page with a tab for each of several keys, `ownTab` says the key of the one at an address. */
export function keyed<T extends Opened>(tab: T, ownTab: (pageId: string, path: string) => string | undefined): T {
  if (tab.kind !== "page") return tab;
  const key = ownTab(tab.id, tab.path.split("?")[0]!);
  return key === tab.ownTab || key === undefined ? tab : { ...tab, ownTab: key };
}

/**
 * The layout with every tab keyed as `keyed` keys it, as one kept before a page had a tab at each
 * address is once the pages are known. Each such page had one tab at most then, so no two tabs come to
 * have one key. Answers the layout itself where nothing changes.
 */
export function keyedLayout(layout: EditorLayout, ownTab: (pageId: string, path: string) => string | undefined): EditorLayout {
  if (layout.groups.every((g) => g.tabs.every((t) => keyed(t, ownTab) === t))) return layout;
  return { ...layout, groups: layout.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => keyed(t, ownTab)), active: g.active && keyed(g.active, ownTab) })) };
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
 * A layout as it is allowed to be, from one kept when each group could have a preview, or one of
 * each kind: the preview is the focused group's, or else the first group's that has one, and in
 * that group the tab showing, or else the one opened last. Any other is a kept tab, and none closes.
 */
function onePreview(layout: EditorLayout): EditorLayout {
  const previewIn = (group: Group) => {
    const previews = group.tabs.filter((t) => t.preview);
    return previews.find((t) => same(t, group.active)) ?? previews.at(-1);
  };
  const stays = [layout.groups.find((g) => g.id === layout.focusedGroupId)!, ...layout.groups].map(previewIn).find((t) => t);
  return { ...layout, groups: layout.groups.map((g) => (g.tabs.some((t) => t.preview && t !== stays) ? { ...g, tabs: g.tabs.map((t) => (t.preview && t !== stays ? { ...t, preview: false } : t)) } : g)) };
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
  /**
   * Opens in the focused group, as a preview where `preview`, which takes the place of the window's
   * preview wherever that is. `background` adds a kept tab and leaves showing what is. A tab another
   * group keeps is gone to there, as going back does, unless it is a note picked `here`, by the member
   * in that group or beside the editor area, which then opens in the focused group too.
   */
  | { type: "open"; tab: Opened; preview: boolean; background?: boolean; here?: boolean }
  /**
   * Opens the tab to the side, as a preview where `preview`: in the group after the focused one,
   * round to the first, or with one group, in a new group right of it. With `stay` the focused group
   * stays the one in front.
   */
  | { type: "aside"; tab: Opened; preview: boolean; stay?: boolean }
  | { type: "pin"; groupId: string; tab: Opened }
  | { type: "close"; scope: CloseScope; groupId: string; tab: Opened }
  | { type: "activate"; groupId: string; tab: Opened }
  | { type: "focus"; groupId: string }
  /**
   * Puts the tab in a new group beside `groupId`. A note split off from the menu or a command is
   * copied, and shows in both; anything else is moved, as a note dragged there is from `from`, the
   * group it was dragged out of. A tab that is moved is what it was, a preview or kept, unless `keep`
   * says the member meant it to stay, as dragging it there does. A tab that is new is kept.
   */
  | { type: "split"; groupId: string; side: Side; tab: Opened; keep?: boolean; from?: string }
  /** `index` is the gap between tabs the tab was dropped in, counting from 0 at the far left. A note's tab comes out of `from`, the group it was dragged from, and only that one. */
  | { type: "drop"; groupId: string; index: number; tab: Opened; from?: string }
  /** Adds the tab to the end of a group's, as dropping it on the middle of the group does. */
  | { type: "add"; groupId: string; tab: Opened; from?: string }
  /** Moves the tab from `groupId` to the group after or before it, round from the last to the first, as dropping it on the middle of that group does. */
  | { type: "send"; groupId: string; tab: Opened; to: "next" | "previous" }
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
 * The window has one preview, and the next thing previewed takes its place, whatever either is of:
 * the reducer's `open` takes it out of any other group. Nothing else
 * about a tab changes by being opened from: a note previewed from a previewed list takes the list's
 * place, and the list is a kept tab only once the member keeps it.
 */
function open(group: Group, tab: Opened, preview: boolean): Group {
  const existing = indexOf(group, tab);
  const tabs = [...group.tabs];
  if (existing >= 0) {
    tabs[existing] = { ...tab, preview: tabs[existing]!.preview && preview };
    return { ...group, tabs, active: tab };
  }
  const previewed = preview ? tabs.findIndex((t) => t.preview) : -1;
  if (previewed >= 0) tabs[previewed] = { ...tab, preview };
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

/** The window has one preview: one in any group but `into` goes, unless it is all its group has, which keeps it rather than close. */
function previewOnlyIn(layout: EditorLayout, into: string): EditorLayout {
  const there = layout.groups.find((g) => g.id !== into && g.tabs.some((t) => t.preview));
  if (!there) return layout;
  return withGroup(layout, there.id, (g) => (g.tabs.length > 1 ? close(g, "tab", refOf(g.tabs.find((t) => t.preview)!)) : { ...g, tabs: g.tabs.map((t) => ({ ...t, preview: false })) }));
}

/**
 * Takes a tab out of every group but `keepIn`, ahead of placing it somewhere else. A note, which can
 * be in several, comes out of `from` alone, the group it is moved from, and out of none when it came from outside them.
 */
const lift = (layout: EditorLayout, tab: Opened, keepIn?: string, from?: string): EditorLayout => ({
  ...layout,
  groups: layout.groups.map((g) => (g.id === keepIn || !has(g, tab) || (tab.kind === "note" && g.id !== from) ? g : close(g, "tab", tab))),
});

export function editorReducer(layout: EditorLayout, action: EditorAction): EditorLayout {
  const tab: Opened | null = "tab" in action ? refOf(action.tab) : null;
  // A group may have gone since the action was made, as when its last tab closed. The tab it names stays where it is.
  if ("groupId" in action && !layout.groups.some((g) => g.id === action.groupId)) return layout;
  switch (action.type) {
    case "open": {
      const front = layout.groups.find((g) => g.id === layout.focusedGroupId)!;
      const elsewhere = has(front, tab!) ? undefined : layout.groups.find((g) => has(g, tab!));
      const theirs = elsewhere?.tabs.find((t) => same(t, tab));
      // A tab open in another pane is gone to there, as going back does. Picked `here`, a preview there comes to this pane, unless it is all
      // that pane has, and a note opens in front all the same, since two panes can show one note.
      const stays = !!theirs && (!action.here || !theirs.preview || elsewhere!.tabs.length === 1 || (!!action.background && tab!.kind !== "note"));
      const into = stays && !(action.here && tab!.kind === "note") ? elsewhere! : front;
      if (action.background) return has(into, tab!) ? editorReducer(layout, { type: "pin", groupId: into.id, tab: tab! }) : withGroup(layout, into.id, (g) => openBehind(g, tab!));
      // The window has one preview, which comes to where it is opened.
      const cleared = !has(into, tab!) && (action.preview || theirs?.preview) ? previewOnlyIn(layout, into.id) : layout;
      return { ...withGroup(cleared, into.id, (g) => open(g, tab!, action.preview)), focusedGroupId: into.id };
    }
    case "aside": {
      const from = layout.focusedGroupId;
      const at = layout.groups.findIndex((g) => g.id === from);
      const only = layout.groups.length === 1 ? layout.groups[0]! : undefined;
      // A folder or a page has one tab, which the only group keeps, or has alone: it is gone to there.
      const kept = only && tab!.kind !== "note" && only.tabs.some((t) => same(t, tab) && (!t.preview || only.tabs.length === 1));
      let opened: EditorLayout;
      if (!only || kept) {
        const next = only ?? layout.groups[(at + 1) % layout.groups.length]!;
        opened = editorReducer({ ...layout, focusedGroupId: next.id }, { type: "open", tab: tab!, preview: action.preview, here: true });
      } else {
        const id = String(Math.max(...layout.groups.map((g) => Number(g.id))) + 1);
        const cleared = action.preview ? previewOnlyIn(layout, id) : layout;
        // A folder or a page moves, having one tab; a note is copied, as split off from its menu.
        const base = tab!.kind === "note" ? cleared : lift(cleared, tab!, id);
        opened = dropEmpty(arranged({ groups: [...base.groups, { id, tabs: [{ ...tab!, preview: action.preview }], active: tab }], focusedGroupId: id }, beside(arrangement(layout), from, id, "right")));
      }
      return action.stay && opened.groups.some((g) => g.id === from) ? { ...opened, focusedGroupId: from } : opened;
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
      const copied = tab!.kind === "note" && !action.keep;
      const preview = !action.keep && !copied && layout.groups.some((g) => g.tabs.some((t) => t.preview && same(t, tab)));
      const groups = [...(copied ? layout : lift(layout, tab!, undefined, action.from)).groups, { id, tabs: [{ ...tab!, preview }], active: tab }];
      return dropEmpty(arranged({ groups, focusedGroupId: id }, beside(arrangement(layout), action.groupId, id, action.side)));
    }
    case "add":
      return editorReducer(layout, { type: "drop", groupId: action.groupId, index: layout.groups.find((g) => g.id === action.groupId)?.tabs.length ?? 0, tab: tab!, ...(action.from !== undefined && { from: action.from }) });
    case "send": {
      const count = layout.groups.length;
      const to = layout.groups[(layout.groups.findIndex((g) => g.id === action.groupId) + (action.to === "next" ? 1 : count - 1)) % count]!;
      return count > 1 ? editorReducer(layout, { type: "add", groupId: to.id, tab: tab!, from: action.groupId }) : layout;
    }
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
      const placed = withGroup(lift(layout, tab!, action.groupId, action.from), action.groupId, (g) => {
        const from = indexOf(g, tab);
        const tabs = g.tabs.filter((t) => !same(t, tab));
        tabs.splice(from >= 0 && from < action.index ? action.index - 1 : action.index, 0, { ...tab!, preview: false });
        return { ...g, tabs, active: tab };
      });
      return dropEmpty({ ...placed, focusedGroupId: action.groupId });
    }
  }
}
