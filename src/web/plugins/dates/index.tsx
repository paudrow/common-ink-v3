import { EditorView, ViewPlugin } from "@codemirror/view";
import { following, today, writtenDayLink, type CompletionItem, type InsertAt, type Plugin } from "../../plugin-api.ts";
import { timeIn } from "../calendar/dates.ts";
import { browserZone, toward } from "../daily/days.ts";
import { openDay } from "../daily/opening.ts";
import { DayField } from "../lib/DayField.tsx";
import { editorKey } from "../lib/live.ts";
import { openPopover } from "../lib/Popover.tsx";
import { dateCards } from "./card.tsx";
import { dateAt, dateDrawing, type DrawnDates, type OpenDay } from "./drawing.ts";
import { openDayPicker } from "./picking.tsx";
import { asksToPick, chipWords, fullWords, howFar, orderIn, saidFor, soon, timeWords, weekdayWords, written, type Said } from "./when.ts";

/** An empty element at `pos` in `view` for a popover to hang from, which scrolls with the note's text. */
function markAt(view: EditorView, pos: number): HTMLElement {
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.coordsAtPos(pos) ?? { left: box.left, top: box.top, bottom: box.top };
  const mark = view.scrollDOM.appendChild(document.createElement("span"));
  Object.assign(mark.style, { position: "absolute", width: "0", left: `${at.left - box.left + view.scrollDOM.scrollLeft}px`, top: `${at.top - box.top + view.scrollDOM.scrollTop}px`, height: `${at.bottom - at.top}px` });
  return mark;
}

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

/**
 * Pick a date…: a date field under the cursor, which answers the day picked, at `time` where one was
 * typed, written as a note writes it, or null when it is closed with none. It starts empty, so
 * picking today is a change too.
 */
function pickDay(time: string | null, { anchor, focus }: InsertAt): Promise<string | null> {
  return new Promise((done) => {
    let picked: string | null = null;
    openPopover(
      anchor,
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
        if (hadFocus) focus();
      },
    );
  });
}

const pick = (time: string | null): CompletionItem => ({ kind: "date", label: "Pick a date…", description: time === null ? "Any day, from a calendar" : `Any day at ${timeWords(time)}, from a calendar`, insert: (at) => pickDay(time, at) });

/**
 * Dates. `@` alone offers today and tomorrow, and for what is typed after it days (today, tomorrow,
 * Friday, next Friday, Oct 21, 3pm, tomorrow 3pm) and Pick a date…, and writes the one picked as an ISO date, with the time where
 * one was said: `2026-10-21 15:00`, a day and a clock's time where the member is. A date written that
 * way anywhere in a note is drawn as it reads, Wed, Oct 21. A click on it, or Alt+Shift+D with the
 * cursor in it, opens a picker that changes its day, ⌘-click opens that day's daily note, and resting on it
 * shows a card that does either.
 */
export const dates: Plugin = {
  id: "dates",
  name: "Dates",
  description: "Writes a date or a time with @, such as @today, @next friday or @tomorrow 3pm, and draws every date in a note as it reads. A click on one changes it, and ⌘-click opens that day's note.",
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

    // A link's page has nowhere to go: there a date opens no daily note.
    const open = (): OpenDay => (typeof host.app().go === "function" ? (day, make) => void openDay(host, make ? { day, make } : toward(day, 0, today())) : null);
    const drawn: DrawnDates = new WeakMap();
    const cards = dateCards(host, open, drawn);
    const editors = new Map<string, EditorView>();
    const focused = () => [...editors.values()].find((view) => view.hasFocus);
    host.editorExtensions.register({
      id: "dates",
      extension: (editor) => [
        dateDrawing(open, cards, drawn),
        // gd on a date opens its daily note, as on a link it opens the link's note.
        following.of((view) => {
          const { head } = view.state.selection.main;
          // On the character after a date, as vim's cursor is on the space after one, the date isn't under it.
          const date = dateAt(view.state, head);
          const go = open();
          if (!date || date.to === head || !go) return false;
          go(date.day);
          return true;
        }),
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          if (!editor.reading) linkDates(editor.noteId);
          return { destroy: () => void (editors.get(key) === view && editors.delete(key)) };
        }),
      ],
    });

    /**
     * A note written before dates were links has its bare dates written as links the first time it
     * is opened by a member who may change it, by the server, as a change of the member's labeled for
     * what it did: asked once a page.
     */
    const asked = new Set<string>();
    /** Opened before the notes were listed, so before it was known whether the member may change them. */
    const waiting = new Set<string>();
    const linkDates = (noteId: string) => {
      if (asked.has(noteId)) return;
      const notes = host.app().notes;
      if (!notes) return void waiting.add(noteId);
      waiting.delete(noteId);
      asked.add(noteId);
      // Only a member who may change the note converts it: a refusal would ask the app who the member is again.
      if (host.workspace.role === "guest" || notes.find((n) => n.id === noteId)?.access !== "edit") return;
      host.perform({ type: "note.linkDates", id: noteId }).catch(() => {});
    };
    host.onItems(() => {
      for (const noteId of [...waiting]) linkDates(noteId);
    });

    // The cursor in a date shows it as written, so the picker a click on it opens is asked for from there.
    const dateHere = () => {
      const view = focused();
      const date = view && !view.state.readOnly && view.state.selection.main.empty ? dateAt(view.state, view.state.selection.main.head) : null;
      return view && date ? { view, date } : null;
    };
    host.commands.register({
      id: "dates.pick",
      title: "Change the date at the cursor",
      group: "Editor",
      // Not Alt+Enter, which edits the link at the cursor: a key runs one command, whatever is at the cursor.
      keys: ["alt+shift+d"],
      when: () => !!dateHere(),
      run() {
        const here = dateHere();
        if (!here) return;
        const { view, date } = here;
        const anchor = markAt(view, date.from);
        const go = open();
        cards.hide("pointer");
        openDayPicker(
          anchor,
          date,
          (when) => {
            // Written where the date still is, as it was: typing elsewhere meanwhile moves it, and typing over it leaves it.
            if (!view.dom.isConnected) return;
            const now = dateAt(view.state, view.state.selection.main.head);
            const at = now && now.day === date.day && now.time === date.time && now.display === date.display ? now : null;
            if (at) view.dispatch({ changes: { from: at.from, to: at.to, insert: writtenDayLink(when, at.display) }, userEvent: "input.pick" });
          },
          (hadFocus) => {
            anchor.remove();
            if (hadFocus) view.focus();
          },
          go && (() => go(date.day, true)),
        );
      },
    });
    return () => cards.dispose();
  },
};
