import { focusOn, listOf, restOf, rowsOf, typing } from "./rows.ts";

/**
 * The rows of one list a member picked, to act on together, in the list's order. `anchor` is where a
 * range is taken from: the row picked first, or the last one picked by itself. `visual` is vim's
 * visual line selection, which a move to another row widens to that row. Nothing picked has no anchor.
 */
export interface Picked<R> {
  anchor: R | null;
  rows: readonly R[];
  visual: boolean;
}

export const NONE: Picked<never> = { anchor: null, rows: [], visual: false };

/** The rows from `a` to `b` in `order`, both in, whichever comes first. Null when either isn't in it. */
function between<R>(order: readonly R[], a: R, b: R) {
  const [i, j] = [order.indexOf(a), order.indexOf(b)];
  return i < 0 || j < 0 ? null : order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** The range from the anchor, or from `from` when there is none, to `to`: what Shift with an arrow or a click picks. */
export function extend<R>(order: readonly R[], picked: Picked<R>, from: R, to: R): Picked<R> {
  const anchor = picked.anchor !== null && order.includes(picked.anchor) ? picked.anchor : from;
  const rows = between(order, anchor, to);
  return rows ? { anchor, rows, visual: picked.visual } : picked;
}

/** Picks a row too, or lets it go when it was picked, as ⌘ with a click does. It is the anchor from then on. */
export function toggle<R>(picked: Picked<R>, row: R): Picked<R> {
  const rows = picked.rows.includes(row) ? picked.rows.filter((r) => r !== row) : [...picked.rows, row];
  return rows.length ? { anchor: row, rows, visual: false } : NONE;
}

/** Vim's V: begins visual line selection on `at`, or ends it and lets everything go. */
export const visual = <R>(picked: Picked<R>, at: R): Picked<R> => (picked.visual ? NONE : { anchor: at, rows: [at], visual: true });

/** A move to `to` while visual takes the range from the anchor to it. Any other move leaves what is picked. */
export function follow<R>(order: readonly R[], picked: Picked<R>, to: R): Picked<R> {
  const rows = picked.visual && picked.anchor !== null ? between(order, picked.anchor, to) : null;
  return rows ? { ...picked, rows } : picked;
}

/** What is picked of the rows in `order` now, in its order. The same `picked` when nothing left. */
export function pruned<R>(order: readonly R[], picked: Picked<R>): Picked<R> {
  const rows = order.filter((r) => picked.rows.includes(r));
  if (!rows.length) return NONE;
  const anchor = picked.anchor !== null && order.includes(picked.anchor) ? picked.anchor : rows[0]!;
  const same = anchor === picked.anchor && rows.length === picked.rows.length && rows.every((r, i) => r === picked.rows[i]);
  return same ? picked : { anchor, rows, visual: picked.visual };
}

/*
 * The rows picked in the window's lists. A list whose rows can be picked says so with
 * `data-selectable`, and its rows are what rows.ts takes them to be. One marked
 * `data-selectable="keys"` is picked from only by the keys, as the sidebar is, whose rows are links
 * that keep what Shift and ⌘ with a click do to a link. A picked row is marked
 * `data-selected` here and not by the page, so a page drawn again keeps the mark. What a page does
 * with a row it reads back from the row's own attributes, such as `data-note`.
 */
const SELECTABLE = "[data-selectable]";
/** What a click in a row is for, and not the row: a link or a control. Not what only a script gives focus to, as an editor's scroller. */
const CONTROL = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const picks = new WeakMap<Element, Picked<HTMLElement>>();
const listeners = new Set<() => void>();

/** Whether `el` is anywhere in a list whose rows can be picked. */
export const inSelectable = (el: Element) => !!el.closest(SELECTABLE);

const selectableOf = (el: Element) => {
  const list = listOf(el);
  return list?.matches(SELECTABLE) ? list : null;
};

function put(list: Element, next: Picked<HTMLElement>, tell = true) {
  const was = picks.get(list) ?? NONE;
  if (was === next) return;
  for (const row of was.rows) if (!next.rows.includes(row)) delete row.dataset.selected;
  for (const row of next.rows) row.dataset.selected = "";
  if (next.rows.length) picks.set(list, next);
  else picks.delete(list);
  if (tell) for (const listener of listeners) listener();
}

/** What is picked in `list`, letting go of rows that have left it. Said to nobody, since it is read while a page is drawn. */
function read(list: Element) {
  const was = picks.get(list) ?? NONE;
  const now = was.rows.length ? pruned(rowsOf(list), was) : was;
  put(list, now, false);
  return now;
}

/** The rows picked in `list`, in its order. */
export const selectedIn = (list: Element): readonly HTMLElement[] => read(list).rows;

export const count = (list: Element | null) => (list ? read(list).rows.length : 0);

/** The rows an action on `row` is for: every row picked in its list when it is one of them, or else only it. */
export function actedOn(row: HTMLElement): readonly HTMLElement[] {
  const list = selectableOf(row);
  const rows = list ? read(list).rows : [];
  return rows.includes(row) ? rows : [row];
}

export const clear = (list: Element) => put(list, NONE);

/** Told whenever what is picked in any list changes, as `useSyncExternalStore` asks. */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The list focus is in, not typing, when its rows can be picked. */
const listHere = () => {
  const el = document.activeElement;
  return el && !typing(el) ? selectableOf(el) : null;
};

/** The row focus is on, in a list whose rows can be picked, and that list. Not while typing. */
function focused() {
  const list = listHere();
  const order = list ? rowsOf(list) : [];
  const row = order.find((r) => r.contains(document.activeElement));
  return list && row ? { list, order, row } : null;
}

/** Whether focus is on a row that can be picked. */
export const canSelect = () => !!focused();

/** Whether the list focus is in has rows picked. */
export function hasSelection() {
  const list = listHere();
  return !!list && count(list) > 0;
}

/** Shift with Down or Up: widens what is picked from the anchor to the next row or the one before, and goes to it. */
export function extendBy(by: 1 | -1) {
  const at = focused();
  if (!at) return;
  const to = at.order[Math.min(Math.max(at.order.indexOf(at.row) + by, 0), at.order.length - 1)]!;
  put(at.list, extend(at.order, read(at.list), at.row, to));
  focusOn(restOf(to));
}

/** Vim's V on the row focus is on. */
export function visualHere() {
  const at = focused();
  if (at) put(at.list, visual(read(at.list), at.row));
}

export function clearHere() {
  const list = listHere();
  if (list) clear(list);
}

/**
 * Picking with the pointer, while it is on: Shift with a click picks the range from the anchor, or
 * from the row focus is on, to the row clicked, and ⌘ with a click (Ctrl off a Mac) picks a row or
 * lets it go. A click on a link or a control inside a row is that control's, unless it is the row's
 * own, what focus rests on. A plain click on a row anywhere but another control lets everything go,
 * once the row has done what the click was for, which is for everything picked. And a move to
 * another row while visual widens the range to it.
 */
export function selecting(mac: boolean) {
  const rowAt = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null;
    const list = selectableOf(target);
    const order = list ? rowsOf(list) : [];
    const row = order.find((r) => r.contains(target));
    if (!list || !row) return null;
    const control = target.closest<HTMLElement>(CONTROL);
    const inner = !!control && control !== row && row.contains(control);
    return { list, order, row, body: !inner || control === restOf(row), keys: list.matches('[data-selectable="keys"]') };
  };
  const picking = (e: MouseEvent) => e.button === 0 && (e.shiftKey || (mac ? e.metaKey : e.ctrlKey));
  const onMouseDown = (e: MouseEvent) => {
    const at = picking(e) ? rowAt(e.target) : null;
    // So no text is selected from where the last click was.
    if (at?.body && !at.keys && e.shiftKey) e.preventDefault();
  };
  const onClick = (e: MouseEvent) => {
    const at = picking(e) ? rowAt(e.target) : null;
    if (!at?.body || at.keys) return;
    e.preventDefault();
    e.stopPropagation();
    const was = read(at.list);
    const here = focused();
    put(at.list, e.shiftKey ? extend(at.order, was, here?.list === at.list ? here.row : at.row, at.row) : toggle(was, at.row));
    focusOn(restOf(at.row));
  };
  const onPlainClick = (e: MouseEvent) => {
    const at = e.button === 0 && !picking(e) ? rowAt(e.target) : null;
    if (at?.body) clear(at.list);
  };
  const onFocus = () => {
    const at = focused();
    if (at && picks.get(at.list)?.visual) put(at.list, follow(at.order, read(at.list), at.row));
  };
  // Taken first, so a click that picks is never the row's own as well.
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("click", onClick, true);
  // And last, after the row's own.
  document.addEventListener("click", onPlainClick);
  document.addEventListener("focusin", onFocus);
  return () => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("click", onPlainClick);
    document.removeEventListener("focusin", onFocus);
  };
}
