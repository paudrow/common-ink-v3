import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { today } from "../../plugin-api.ts";
import { chips, type Chip } from "../lib/chips.ts";
import { chipWords, fullWords, writtenOn, type Written } from "./when.ts";

/** A heading, as a daily note's title is its date: a date there is left as written. */
const HEADING = /^#{1,6}\s/;
/** A line up to a date that is inside an embed's braces, a link's brackets or a link's address, which the embed or the link draws. */
const OPEN = /\{[^}]*$|\[[^\]]*$|\]\($/;

/** Opens the daily note for a day, or null where nothing can be opened from here, as on a share link's page. */
export type OpenDay = ((day: string) => void) | null;

/**
 * Draws a day written in a note as it reads: Wed, Oct 21, with the year where it isn't this year's
 * and the time where one is written. It is shown as written only while the cursor is inside it, as a
 * link is, and a click opens the daily note for its day.
 */
function dateChip(open: () => OpenDay): Chip<Written> {
  return {
    id: "date",
    find: writtenOn,
    written: "within",
    skip(state, date) {
      const line = state.doc.lineAt(date.from);
      return HEADING.test(line.text) || OPEN.test(line.text.slice(0, date.from - line.from));
    },
    // The year it reads with changes at New Year.
    key: () => today().slice(0, 4),
    draw(el, date) {
      el.textContent = chipWords(date, today().slice(0, 4));
      const go = open();
      el.title = go ? `${fullWords(date)} · Click to open its daily note` : fullWords(date);
      if (!go) return;
      el.setAttribute("role", "link");
      el.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        go(date.day);
      });
    },
  };
}

const look = EditorView.baseTheme({
  // A tint behind the words and nothing around them, so a line is as tall with a date drawn as with it written.
  ".md-chip-date": { color: "var(--accent)", background: "var(--accent-soft)", borderRadius: "4px", padding: "0 0.2em", whiteSpace: "nowrap" },
  ".md-chip-date[role=link]": { cursor: "pointer" },
});

/** The editor extension that draws written days. */
export const dateDrawing = (open: () => OpenDay): Extension => [chips(dateChip(open)), look];
