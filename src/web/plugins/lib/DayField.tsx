import { useRef } from "react";
import { Icon } from "../../plugin-api.ts";

/** Keys that type into a date field, which has a whole date after every one of them on the way to the one meant. */
const TYPING = /^(\d|ArrowUp|ArrowDown|Backspace|Delete)$/;

/**
 * Any day, as a todo's due date and `@`'s Pick a date… take one. One picked from the browser's calendar
 * is given at once. Typed, the browser has a whole date after every key (0002 on the way to 2031), so a
 * typed one is given on Enter.
 */
export function DayField({ day, label, onDay }: { day: string | null; label: string; onDay: (day: string) => void }) {
  const typed = useRef(false);
  return (
    <label className="chip-day">
      <Icon name="calendar" />
      <input
        type="date"
        aria-label={label}
        defaultValue={day ?? ""}
        onPointerDown={() => (typed.current = false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.currentTarget.value) onDay(e.currentTarget.value);
          } else if (TYPING.test(e.key)) typed.current = true;
        }}
        onChange={(e) => !typed.current && e.target.value && onDay(e.target.value)}
      />
    </label>
  );
}
