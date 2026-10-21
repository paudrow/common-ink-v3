import { EditorView } from "@codemirror/view";
import { today, type CompletionItem, type Plugin } from "../../plugin-api.ts";
import { timeIn } from "../calendar/dates.ts";
import { browserZone, toward } from "../daily/days.ts";
import { openDay } from "../daily/opening.ts";
import { DayField } from "../lib/DayField.tsx";
import { openPopover } from "../lib/Popover.tsx";
import { dateDrawing, type OpenDay } from "./drawing.ts";
import { asksToPick, chipWords, fullWords, howFar, orderIn, saidFor, soon, timeWords, weekdayWords, written, type Said } from "./when.ts";

/** How many days `@` offers at most, before Pick a date…. */
const MOST_OFFERED = 8;

function itemFor(said: Said, now: string): CompletionItem {
  const label = said.name === null ? chipWords(said, now.slice(0, 4)) : said.time === null ? said.name : `${said.name}, ${timeWords(said.time)}`;
  return {
    kind: "date",
    label,
    description: fullWords(said),
    preview: {
      facts: [
        ["Weekday", weekdayWords(said.day)],
        ["From today", howFar(said.day, now)],
      ],
    },
    insert: written(said),
  };
}

/** A mark at the cursor of `view` for a popover to hang from, which scrolls with the note's text. */
function markAtCursor(view: EditorView): HTMLElement {
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.coordsAtPos(view.state.selection.main.head) ?? { left: box.left, top: box.top, bottom: box.top };
  const mark = view.scrollDOM.appendChild(document.createElement("span"));
  Object.assign(mark.style, {
    position: "absolute",
    width: "0",
    left: `${at.left - box.left + view.scrollDOM.scrollLeft}px`,
    top: `${at.top - box.top + view.scrollDOM.scrollTop}px`,
    height: `${at.bottom - at.top}px`,
  });
  return mark;
}

/**
 * Pick a date…: a date field under the cursor of the editor that has the keyboard, which answers the
 * day picked, at `time` where one was typed, written as a note writes it, or null when it is closed
 * with none. It starts empty, so picking today is a change too.
 */
function pickDay(time: string | null): Promise<string | null> {
  const editor = document.activeElement?.closest<HTMLElement>(".cm-editor");
  const view = editor && EditorView.findFromDOM(editor);
  if (!view) return Promise.resolve(null);
  const mark = markAtCursor(view);
  return new Promise((done) => {
    let picked: string | null = null;
    openPopover(
      mark,
      "Pick a date",
      (close) => (
        <div className="chip-menu date-pick">
          <DayField
            day={null}
            label="Date"
            onDay={(day) => {
              picked = written({ day, time });
              close();
            }}
          />
        </div>
      ),
      (hadFocus) => {
        done(picked);
        mark.remove();
        if (hadFocus && view.dom.isConnected) view.focus();
      },
    );
  });
}

const pick = (time: string | null): CompletionItem => ({ kind: "date", label: "Pick a date…", description: time === null ? "Any day, from a calendar" : `Any day at ${timeWords(time)}, from a calendar`, insert: () => pickDay(time) });

/**
 * Dates. `@` alone offers today and tomorrow, and for what is typed after it days (today, tomorrow,
 * Friday, next Friday, Oct 21, 3pm, tomorrow 3pm) and Pick a date…, and writes the one picked as an ISO date, with the time where
 * one was said: `2026-10-21 15:00`, a day and a clock's time where the member is. A date written that
 * way anywhere in a note is drawn as it reads, Wed, Oct 21, and a click on it opens that day's daily note.
 */
export const dates: Plugin = {
  id: "dates",
  name: "Dates",
  description: "Writes a date or a time with @, such as @today, @next friday or @tomorrow 3pm, and draws every date in a note as it reads. A click on one opens that day's note.",
  icon: "calendar",
  activate(host) {
    const order = orderIn();
    host.completions.register({
      id: "dates",
      trigger: "@",
      spaces: true,
      items(typed) {
        const now = today();
        const at = { day: now, time: timeIn(Date.now(), browserZone()) };
        if (!typed) return soon(at).map((s) => itemFor(s, now));
        const said = saidFor(typed, at, order).slice(0, MOST_OFFERED);
        const time = said.find((s) => s.name !== "Now")?.time ?? null;
        return said.length || asksToPick(typed) ? [...said.map((s) => itemFor(s, now)), pick(time)] : [];
      },
    });

    // A link's page has nowhere to go: there a click on a date is for the cursor.
    const open = (): OpenDay => (typeof host.app().go === "function" ? (day) => void openDay(host, toward(day, 0, today())) : null);
    host.editorExtensions.register({ id: "dates", extension: () => dateDrawing(open) });
  },
};
