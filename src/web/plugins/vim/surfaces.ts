import { EDITOR, FOCUSABLE, ROW, arrive, beside, focusOn, goes, listOf, listsIn, ownKeys, preview, regions, restOf, rowsOf, shown, typing } from "../lib/rows.ts";
import { land, toward, type Move, type Side } from "./moving.ts";

/**
 * What vim's keys move through outside a note's text: the lists, rows and regions of `rows.ts`. A
 * row's delete key presses what it marks `data-row-delete`.
 *
 * A list that takes focus itself keeps its own cursor and has its own keys for it, as History's
 * does. Vim's keys go as far as that list and no further: its rows are the list's to move through.
 * The moves such a list has a key of its own for are sent to it as that key: Home and End for the
 * first row and the last, and Page Down and Page Up for vim's half pages, which such a list moves by
 * a page of its own.
 */
const OVER = '[role="dialog"], [role="menu"]';
const SEARCH = 'input[type="search"], [role="searchbox"]';

/** What an embed draws in a note. Focus that has gone into it is the embed's, and so are the keys: its cards are no list of the window's. */
export const DRAWN = ".cm-content .embed";

const active = () => (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);

/** The key a list with its own keys has for a move, where a keyboard has one. j and k are such a list's own already. */
const OWN_KEY: Partial<Record<Move, string>> = { first: "Home", last: "End", halfDown: "PageDown", halfUp: "PageUp" };

/** What opening a row presses: what it marks `data-row-open`, or its link, or the field it begins with, or what it rests on. */
function openOf(row: HTMLElement) {
  const rest = restOf(row);
  const field = "rests" in row.dataset ? [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => shown(el) && !el.matches(":disabled")) : undefined;
  return row.querySelector<HTMLElement>("[data-row-open]") ?? (rest === row && !field ? row : (row.querySelector<HTMLElement>("a[href]") ?? field ?? rest));
}

/** What opens a row out and shuts it: a toggle of its own, or the row itself where it is marked as one, as the sidebar's More is. */
const toggleOf = (row: HTMLElement, toggles: string, own: (toggle: HTMLElement) => boolean) =>
  row.matches("[data-row-toggle]") ? row : [...row.querySelectorAll<HTMLElement>(toggles)].find(own);

/** The region the keys are in: the one with focus, or the side of a split that was last used, or the first in the middle of the window. */
function here() {
  const all = regions();
  return all.find((r) => r.contains(active())) ?? all.find((r) => r.matches("[data-focused]")) ?? all.find((r) => r.closest("main")) ?? all[0];
}

/** Where the keys look for a list, a search box or tabs: what is open over the window when focus is in it, or the region. */
const scope = () => active().closest<HTMLElement>(OVER) ?? here() ?? document.body;

export interface Surfaces {
  /** Whether each kind of key has something to do where focus is now. */
  on: {
    /** Not typing, with a list in reach. */
    list(): boolean;
    /** As `list`, or on a list that has keys of its own, which is sent the move as its own key. */
    anyList(): boolean;
    /** On the selected row of a list, and not on another button of that row. */
    row(): boolean;
    /** As `row`, on a row of the sidebar's that opens something beside it. */
    beside(): boolean;
    /** As `row`, on a row with something to delete it by. */
    deletable(): boolean;
    /** Not typing, with a search box in reach. */
    search(): boolean;
    /** Typing in a field that isn't a note's, with a list in reach. */
    field(): boolean;
    /** In a search box, or a field a row was opened to, with a list to go back to and nothing open that Escape closes first. */
    fieldOfList(): boolean;
    /** Not typing, or in a note's text where vim takes keys for commands. */
    window(): boolean;
    /** Not in a note's text, with tabs in reach. */
    tabs(): boolean;
  };
  move(move: Move): void;
  open(): void;
  /** Opens the selected row, which is beside the editor area, and stays on it. */
  preview(): void;
  out(): void;
  /** Expands the selected row, or collapses it, where it has something that does. */
  toggle(): void;
  /** Presses what deletes the selected row, as a todo's Abandon does. */
  remove(): void;
  search(): void;
  /** An arrow key for the field, which a field with a list under it has its own answer to. One with none sends focus into the list. */
  arrow(key: "ArrowDown" | "ArrowUp"): void;
  leaveField(): void;
  go(side: Side): void;
  tab(by: 1 | -1): void;
  /** Puts focus where a key put something in front: in the region the keys are in, where it last was there, or its note's text, or its list; or, from the sidebar, on what was opened beside it. */
  settle(): void;
  dispose(): void;
}

export function surfaces(given: { normal(el: HTMLElement): boolean; dismissing(): boolean }): Surfaces {
  /** Where focus last was in each region, and the row it was last on in each list. The sidebar is both. */
  const lastIn = new WeakMap<Element, HTMLElement>();
  const lastRow = new WeakMap<Element, HTMLElement>();
  /** The row marked as the one the keys are on. A browser shows where focus is only after some keys, and not after one held with Control. */
  let marked: HTMLElement | undefined;
  let byKey = false;
  const keyed = <A extends unknown[]>(act: (...args: A) => void) => (...args: A) => {
    byKey = true;
    try {
      act(...args);
    } finally {
      byKey = false;
    }
  };
  const mark = (row: HTMLElement | undefined) => {
    if (marked !== row) delete marked?.dataset.vimAt;
    marked = row;
    if (row) row.dataset.vimAt = "";
  };
  const focused = () => {
    const el = active();
    const region = regions().find((r) => r.contains(el));
    if (region) lastIn.set(region, el);
    const list = listOf(el);
    const row = list ? rowsOf(list).find((r) => r.contains(el)) : undefined;
    if (row) lastRow.set(list!, row);
    if (byKey || !marked?.contains(el)) mark(byKey ? row : undefined);
  };
  const left = (e: FocusEvent) => e.relatedTarget === null && mark(undefined);
  document.addEventListener("focusin", focused);
  document.addEventListener("focusout", left);

  /** The list the keys are in, or the nearest one to where focus is, or the first of the region. */
  const listNear = () => {
    const within = scope();
    const around = listOf(active());
    if (around && within.contains(around) && rowsOf(around).length) return around;
    for (let el: Element | null = active(); el && within.contains(el) && el !== within; el = el.parentElement) {
      const [inside] = listsIn(el);
      if (inside) return inside;
    }
    return listsIn(within)[0];
  };
  const rowAt = (list: Element) => rowsOf(list).find((r) => r.contains(active()));
  /** What deletes a row: its own, and not a row's of a list inside it. */
  const deleterOf = (row: HTMLElement | undefined) => [...(row?.querySelectorAll<HTMLElement>("[data-row-delete]") ?? [])].find((el) => el.closest(ROW) === row && !el.matches(":disabled"));
  const resting = (list: Element, rows: readonly HTMLElement[]) => {
    const was = lastRow.get(list);
    return Math.max(0, was ? rows.indexOf(was) : rows.findIndex((r) => r.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"])') || r.querySelector('[aria-current]:not([aria-current="false"])')));
  };
  const select = (row: HTMLElement | undefined) => {
    if (!row) return;
    const list = listOf(row);
    if (ownKeys(list)) return list.focus();
    restOf(row).focus();
    row.scrollIntoView({ block: "nearest" });
  };
  const halfPage = (list: Element, row: HTMLElement | undefined) => {
    let scroller = list.parentElement;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    return Math.max(1, Math.floor((scroller?.clientHeight ?? innerHeight) / 2 / (row?.getBoundingClientRect().height || 1)));
  };
  const searchBox = () => [scope(), here(), document.querySelector("main")].flatMap((within) => [...(within?.querySelectorAll<HTMLElement>(SEARCH) ?? [])]).find(shown);
  const tablist = () => [scope(), here()].flatMap((within) => [...(within?.querySelectorAll('[role="tablist"]') ?? [])]).find(shown);
  /** In a field of the page's. A note's editor has fields of its own, such as vim's prompt, where these keys are vim's. */
  const inField = () => typing(active()) && !active().isContentEditable && !active().closest(".cm-editor");
  const drawn = () => !!active().closest(DRAWN);
  /** The selected row, when focus is on it and not on another button of it. */
  const selected = () => {
    const list = drawn() ? null : listOf(active());
    const row = list && !typing(active()) ? rowAt(list) : undefined;
    return row && restOf(row) === active() ? row : undefined;
  };

  const enter = (region: HTMLElement | undefined) => {
    if (!region) return;
    const was = lastIn.get(region);
    if (was?.isConnected && shown(was)) return was.focus();
    const editor = region.querySelector<HTMLElement>(EDITOR);
    if (editor) return editor.focus();
    const list = listsIn(region)[0];
    if (list) return select(rowsOf(list)[resting(list, rowsOf(list))]);
    [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => shown(el) && !el.matches(":disabled"))?.focus();
  };

  return {
    on: {
      list: () => !drawn() && !typing(active()) && !ownKeys(listOf(active())) && !!listNear(),
      anyList: () => !drawn() && !typing(active()) && !!listNear(),
      row: () => !!selected(),
      beside: () => {
        const row = selected();
        return !!row && beside(row) && goes(row);
      },
      deletable: () => !!deleterOf(selected()),
      search: () => !drawn() && !typing(active()) && !!searchBox(),
      field: () => inField() && !!listNear(),
      // Over the window only a search box or a field inside a list, as Settings has: a palette's own field keeps Escape for closing.
      fieldOfList: () =>
        inField() && (active().matches(SEARCH) || !!active().closest("[data-rests]")) && !given.dismissing() && (!active().closest(OVER) || active().matches(SEARCH) || !!active().closest("[data-list]")) && !!listNear(),
      window: () => !typing(active()) || given.normal(active()),
      tabs: () => !drawn() && !typing(active()) && !!tablist(),
    },
    move: keyed((move: Move) => {
      const own = listOf(active());
      if (ownKeys(own)) {
        const key = OWN_KEY[move];
        if (key) own.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        return;
      }
      const list = listNear();
      if (!list) return;
      const rows = rowsOf(list);
      const at = rows.findIndex((r) => r.contains(active()));
      select(rows[land(move, at, rows.length, resting(list, rows), halfPage(list, rows[at] ?? rows[0]))]);
    }),
    open: keyed(() => {
      const list = listOf(active());
      const row = list && rowAt(list);
      if (!row) return;
      const target = openOf(row);
      if (typing(target)) return target.focus();
      // l opens out a row that is only a toggle, as More is, and doesn't shut it again.
      if (row.matches("[data-row-toggle]") && row.ariaExpanded === "true") return;
      target.click();
      // What a row beside the editor area opens is shown in it, and the keys go there, whether or not it was open already.
      if (beside(row) && goes(row)) arrive(keyed(focusOn));
    }),
    preview: keyed(() => {
      const row = selected();
      if (row) preview(restOf(row), keyed(focusOn));
    }),
    out: keyed(() => {
      const list = listOf(active());
      const row = list && rowAt(list);
      if (!row) return;
      if (row.ariaExpanded === "true") {
        const toggle = toggleOf(row, "[data-row-toggle]", (t) => t.closest(ROW) === row);
        if (toggle) return toggle.click();
      }
      const rows = rowsOf(list);
      const level = Number(row.ariaLevel);
      const parent = level > 1 ? rows.slice(0, rows.indexOf(row)).findLast((r) => Number(r.ariaLevel) < level) : undefined;
      const outer = list.parentElement && listOf(list.parentElement);
      select(parent ?? (outer ? rowsOf(outer).find((r) => r.contains(list)) : undefined));
    }),
    toggle: keyed(() => {
      const list = listOf(active());
      const row = list && rowAt(list);
      if (row) toggleOf(row, "[data-row-toggle], button[aria-expanded]", (t) => listOf(t) === list)?.click();
    }),
    remove: keyed(() => deleterOf(selected())?.click()),
    search: () => searchBox()?.focus(),
    arrow: keyed((key: "ArrowDown" | "ArrowUp") => {
      const left = active().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      const list = left && !active().closest(OVER) ? listNear() : undefined;
      if (list) select(rowsOf(list)[key === "ArrowDown" ? 0 : rowsOf(list).length - 1]);
    }),
    leaveField: keyed(() => {
      const list = listNear();
      if (!list) return;
      const rows = rowsOf(list);
      select(rows.find((r) => r.contains(active())) ?? rows[resting(list, rows)]);
    }),
    go: keyed((side: Side) => {
      const all = regions();
      const from = all.indexOf(here()!);
      if (from >= 0) enter(all[toward(all.map((r) => r.getBoundingClientRect()), from, side)]);
    }),
    tab(by) {
      const tabs = [...(tablist()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
      const at = tabs.findIndex((t) => t.ariaSelected === "true");
      if (tabs.length > 1) tabs[(at + by + tabs.length) % tabs.length]!.click();
    },
    settle: keyed(() => {
      const region = here();
      if (region && beside(region)) arrive(keyed(focusOn));
      else enter(region);
    }),
    dispose() {
      document.removeEventListener("focusin", focused);
      document.removeEventListener("focusout", left);
      mark(undefined);
    },
  };
}
