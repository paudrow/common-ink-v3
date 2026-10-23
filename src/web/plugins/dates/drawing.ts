import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { today } from "../../plugin-api.ts";
import { chips, type Chip, type Source } from "../lib/chips.ts";
import type { HoverCards } from "../lib/hoverCard.tsx";
import { drawnInView, within } from "../lib/live.ts";
import { openDayPicker } from "./picking.tsx";
import { chipWords, fullWords, written, writtenOn, type Written } from "./when.ts";

/** A heading, as a daily note's title is its date: a date there is left as written. */
const HEADING = /^#{1,6}\s/;
/** A line up to a date that is inside an embed's braces, a link's brackets or a link's address, which the embed or the link draws. */
const OPEN = /\{[^}]*$|\[[^\]]*$|\]\($/;

/** Opens the daily note for a day, made first with `make` where there is none, or null where nothing can be opened from here, as on a share link's page. */
export type OpenDay = ((day: string, make?: boolean) => void) | null;

/** Whether a date written on a line is drawn as a date, and not left as written for a heading, an embed or a link to draw. */
const drawable = (line: string, at: number) => !HEADING.test(line) && !OPEN.test(line.slice(0, at));

/** The date drawn where `pos` is, at its start, inside or at its end, or null. */
export function dateAt(state: EditorState, pos: number): Written | null {
  const line = state.doc.lineAt(pos);
  return writtenOn(line.text, line.from).find((date) => date.from <= pos && pos <= date.to && drawable(line.text, date.from - line.from)) ?? null;
}

/**
 * Each date one start of the plugin draws, by its chip: what the date's card is about, and what
 * changes it. Its own, so a page that draws notes twice over, as one with a reading of a file in it,
 * shows a date's card once.
 */
export type DrawnDates = WeakMap<HTMLElement, { date: Written; source: Source }>;

/**
 * Opens the picker under a date's chip, and writes the day and the time picked in place of the
 * date's. With somewhere to go, the picker opens the day's daily note too, which a screen with no
 * pointer to rest on a date has no other way to.
 */
export function changeDate(el: HTMLElement, drawn: DrawnDates, go: OpenDay): void {
  const found = drawn.get(el);
  if (!found || found.source.readOnly) return;
  const { date, source } = found;
  const editor = el.closest<HTMLElement>(".cm-editor");
  const view = editor && EditorView.findFromDOM(editor);
  el.setAttribute("aria-expanded", "true");
  openDayPicker(
    el,
    date,
    (when) => source.rewrite(written(when)),
    (hadFocus) => {
      el.removeAttribute("aria-expanded");
      if (hadFocus) view?.focus();
    },
    go && (() => go(date.day, true)),
  );
}

/**
 * Draws a day written in a note as it reads: Wed, Oct 21, with the year where it isn't this year's
 * and the time where one is written. It is shown as written only while the cursor is inside it, as a
 * link is. A click opens a picker under it to change the day, and ⌘-click opens its daily note.
 * Resting on it shows its card. Where the note can only be read, a click opens the daily note, where
 * there is one to go to, and changes nothing.
 */
function dateChip(open: () => OpenDay, cards: HoverCards, drawn: DrawnDates): Chip<Written> {
  return {
    id: "date",
    find: writtenOn,
    written: "within",
    skip(state, date) {
      const line = state.doc.lineAt(date.from);
      return !drawable(line.text, date.from - line.from);
    },
    // The year it reads with changes at New Year.
    key: () => today().slice(0, 4),
    draw(el, date, source) {
      el.textContent = chipWords(date, today().slice(0, 4));
      el.dataset.date = date.day;
      el.setAttribute("aria-label", fullWords(date));
      drawn.set(el, { date, source });
      if (!source.readOnly) {
        el.setAttribute("role", "button");
        el.setAttribute("aria-haspopup", "dialog");
      }
      el.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        const go = open();
        if ((event.metaKey || event.ctrlKey || source.readOnly) && go) {
          event.preventDefault();
          cards.hide("pointer");
          return go(date.day);
        }
        if (source.readOnly) return;
        event.preventDefault();
        cards.hide("pointer");
        changeDate(el, drawn, go);
      });
    },
  };
}

/** A date the cursor is in, shown as written, still reads as something to follow: tinted and underlined as a link written out is. */
const asWritten = drawnInView((view) => {
  const { state } = view;
  const marked: Range<Decoration>[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    for (const date of writtenOn(line.text, line.from)) {
      if (within(state, date.from, date.to) && drawable(line.text, date.from - line.from)) marked.push(Decoration.mark({ class: "md-date-written", attributes: { title: fullWords(date) } }).range(date.from, date.to));
    }
  }
  return marked;
});

const look = EditorView.baseTheme({
  // A tint behind the words and nothing around them, so a line is as tall with a date drawn as with it written.
  ".md-chip-date": { color: "var(--accent)", background: "var(--accent-soft)", borderRadius: "4px", padding: "0 0.2em", whiteSpace: "nowrap" },
  ".md-chip-date[role=button]": { cursor: "pointer" },
  ".md-date-written": { color: "var(--accent)", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" },
});

/** The editor extension that draws written days, with `cards` the cards they show, each kept in `drawn`. */
export const dateDrawing = (open: () => OpenDay, cards: HoverCards, drawn: DrawnDates): Extension => [chips(dateChip(open, cards, drawn)), asWritten, look];
