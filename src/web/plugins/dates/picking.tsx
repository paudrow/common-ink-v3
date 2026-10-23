import { useState } from "react";
import { today } from "../../plugin-api.ts";
import { openFrom, openPopover } from "../lib/Popover.tsx";
import { ChipMenu } from "../todos/ChipMenu.tsx";
import type { When } from "./when.ts";

/** The date the last picker was opened from. */
let from: HTMLElement | null = null;
/** Whether a date's picker is open: its card stays away while it is, so as not to cover it. */
export const picking = () => from !== null && openFrom(from);

/**
 * Opens under `anchor` the picker a todo's due date opens, on the day of `when`: Today, Tomorrow, Next
 * week, and a field for any day, so a date in prose and a due date are changed alike. Under them, the
 * time: Add time, which is an hour and minute field once pressed, and Remove time. A day picked is
 * written at once, with the time as it then is, and closes the picker. A time changed alone is
 * written as the picker closes, by Enter or a press outside it, since writing it redraws the date the
 * picker hangs from; Escape closes it with the time as it was. `onWhen` is
 * told what to write. `onClosed` is told whether the keyboard was in it. With `openNote`, it ends
 * with Open daily note.
 */
export function openDayPicker(anchor: HTMLElement, when: When, onWhen: (when: When) => void, onClosed?: (hadFocus: boolean) => void, openNote?: (() => void) | null): void {
  let time = when.time;
  let written = false;
  from = anchor;
  openPopover(
    anchor,
    "Change date",
    (close) => (
      <DatePicker
        when={when}
        onTime={(next) => (time = next)}
        onDay={(day) => {
          written = true;
          close();
          onWhen({ day, time });
        }}
        onClose={close}
        openNote={
          openNote &&
          (() => {
            close();
            openNote();
          })
        }
      />
    ),
    (hadFocus) => {
      if (!written && time !== when.time) onWhen({ day: when.day, time });
      onClosed?.(hadFocus);
    },
  );
}

const TIME = /^\d{2}:\d{2}$/;

function DatePicker({ when, onTime, onDay, onClose, openNote }: { when: When; onTime: (time: string | null) => void; onDay: (day: string) => void; onClose: () => void; openNote: (() => void) | null | undefined }) {
  // Null with no time, and "" while the field is there with none typed in it yet.
  const [time, setTime] = useState<string | null>(when.time);
  const take = (next: string | null) => {
    setTime(next);
    onTime(next === "" ? null : next);
  };
  return (
    // Escape is a cancel: the time goes back to what it was before the picker closes.
    <div className="date-picker" onKeyDown={(e) => e.key === "Escape" && onTime(when.time)}>
      <ChipMenu
        chip="due"
        todo={{ state: "open", due: when.day, importance: 0, every: null }}
        now={today()}
        dayLabel="Date"
        clearable={false}
        onClose={onClose}
        onPick={(change) => {
          if (typeof change.due === "string") onDay(change.due);
          else onClose();
        }}
      />
      <div className="date-picker-time">
        {time === null ? (
          <button type="button" className="chip-choice" onClick={() => take("")}>
            Add time
          </button>
        ) : (
          <>
            <input
              type="time"
              aria-label="Time"
              value={time}
              autoFocus={time === ""}
              onChange={(e) => (e.target.value === "" || TIME.test(e.target.value)) && take(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // The note the keyboard goes back to takes no Enter of the field's.
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
            />
            <button type="button" className="chip-choice" onClick={() => take(null)}>
              Remove time
            </button>
          </>
        )}
      </div>
      {openNote && (
        <button type="button" className="chip-choice date-picker-note" onClick={openNote}>
          Open daily note
        </button>
      )}
    </div>
  );
}
