import { EditorView } from "@codemirror/view";

/**
 * What the keyboard moves through outside a note's text, found by what the page says of itself and
 * not by which plugin drew it. A list is a tree, a listbox, a menu, a list with a name, or anything
 * marked `data-list`. Its rows are its tree items, options and menu items, or what is marked
 * `data-row`, or else its children. A region is the sidebar, the inspector, a side of a split, or
 * anything marked `data-region`.
 */
export const LIST = '[data-list], [role="tree"], [role="listbox"], [role="list"], [role="menu"], ul[aria-label], ol[aria-label], ul[aria-labelledby], ol[aria-labelledby]';
export const ROW = '[data-row], [role="treeitem"], [role="option"], [role^="menuitem"]';
const REGION = "[data-region], aside, main";
export const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
export const EDITOR = '[contenteditable="true"][role="textbox"]';
const TEXTLESS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

export const shown = (el: Element) => el.getClientRects().length > 0;

/** Whether a letter pressed here is typed, or chooses: a field, a select, or text that can be edited. */
export const typing = (el: Element | null) =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !TEXTLESS.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

export const rowsOf = (list: Element) => {
  const marked = [...list.querySelectorAll<HTMLElement>(ROW)].filter((row) => row.closest(LIST) === list);
  return (marked.length ? marked : [...list.children].filter((el) => el instanceof HTMLElement)).filter(shown);
};

/**
 * What has focus while a row is the one selected: the row, or the first thing in it that can be
 * pressed. A row that begins with a field is selected itself, so no key is typed into the field
 * before the member opens it.
 */
export function restOf(row: HTMLElement) {
  if (row.matches(FOCUSABLE)) return row;
  const first = [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => shown(el) && !el.matches(":disabled"));
  if (first && !typing(first)) return first;
  row.tabIndex = -1;
  row.dataset.rests = "";
  return row;
}

export function regions() {
  const all = [...document.querySelectorAll<HTMLElement>(REGION)].filter((r) => shown(r) && !r.ariaHidden);
  return all.filter((r) => !all.some((o) => o !== r && r.contains(o)));
}

/** The side of the editor area in front: the one last used, or the first. */
const front = () => {
  const inMain = regions().filter((r) => r.closest("main"));
  return inMain.find((r) => r.matches("[data-focused]")) ?? inMain[0];
};

/** Whether the list takes focus itself, and so moves through its rows with keys of its own. */
export const ownKeys = (list: Element | null): list is HTMLElement => list instanceof HTMLElement && list.matches("[tabindex]") && list.tabIndex >= 0;

export const listsIn = (within: Element) => [within, ...within.querySelectorAll(LIST)].filter((l) => l.matches(LIST) && shown(l) && rowsOf(l).length);

/** Puts focus on a note's text through its editor, which leaves the note where it is scrolled to, or on anything else, brought into view. */
export function focusOn(el: HTMLElement) {
  const view = el.closest(".cm-editor") && EditorView.findFromDOM(el);
  if (view) return view.focus();
  el.focus();
  el.scrollIntoView({ block: "nearest" });
}

/** Whether opening a row goes somewhere, as a link or a folder does, and doesn't only show more of the list, as More does. */
export const goes = (row: Element) => row.matches('a[href], [role="treeitem"]') || !!row.querySelector("a[href]");

/** Whether something is beside the editor area and opens things in it, as the sidebar is, which is marked `data-beside`. */
export const beside = (el: Element) => !!el.closest("[data-beside]");

/**
 * Calls `look` each frame until it says it is done or `ms` have gone, when it is told it is the last
 * time. A key or a press of the pointer ends it: the member has gone on to something else.
 */
function eachFrame(ms: number, look: (last: boolean) => boolean) {
  const until = Date.now() + ms;
  let stopped = false;
  const stop = () => {
    stopped = true;
    removeEventListener("keydown", stop, true);
    removeEventListener("pointerdown", stop, true);
  };
  const frame = () => {
    if (stopped) return;
    const last = Date.now() >= until;
    if (look(last) || last) stop();
    else requestAnimationFrame(frame);
  };
  // From the next frame, so the key that began it doesn't end it.
  requestAnimationFrame(() => {
    if (stopped) return;
    addEventListener("keydown", stop, true);
    addEventListener("pointerdown", stop, true);
    frame();
  });
  return stop;
}

const ARRIVING_MS = 2000;
let arriving: (() => void) | undefined;

/**
 * After a row beside the editor area was opened: puts focus on what it opened, in the side of the
 * editor area in front, once that is drawn. A note's text takes it, or else the first row of the
 * first list there, which may still be being read. What took focus there itself, as Search's box
 * does, keeps it, and a key pressed meanwhile leaves focus where the member put it. `onto` is how
 * focus is put there.
 */
export function arrive(onto: (el: HTMLElement) => void = focusOn) {
  arriving?.();
  arriving = eachFrame(ARRIVING_MS, (last) => {
    const region = front();
    if (!region || region.contains(document.activeElement)) return true;
    const editor = region.querySelector<HTMLElement>(EDITOR);
    const list = !region.querySelector('[aria-busy="true"]') ? listsIn(region)[0] : undefined;
    const row = list && rowsOf(list)[0];
    const first = last && [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => shown(el) && !el.matches(":disabled") && !typing(el));
    const to = editor ?? (row ? (ownKeys(list) ? list : restOf(row)) : first);
    if (to) onto(to);
    return !!to;
  });
}
