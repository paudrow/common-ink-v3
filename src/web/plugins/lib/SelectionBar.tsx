import { useSyncExternalStore, type RefObject } from "react";
import { Icon, type IconName } from "../../plugin-api.ts";
import { focusOn, restOf, rowsOf } from "./rows.ts";
import { clear, count, selectedIn, subscribe } from "./selecting.ts";

/** Something a list does to every row picked in it at once, such as Archive. */
export interface SelectionAction {
  label: string;
  icon?: IconName;
  run: (rows: readonly HTMLElement[]) => void;
}

/** The row the keyboard goes on to once `rows` were acted on: the first after them that isn't one of them, or else the nearest before, or else the first of them. */
function onward(list: Element, rows: readonly HTMLElement[]) {
  const order = rowsOf(list);
  const at = order.indexOf(rows.at(-1)!);
  return [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0)).reverse()].find((row) => !rows.includes(row)) ?? rows[0];
}

/**
 * In a list's header while rows of it are picked: how many, what can be done to all of them, and
 * Clear. Nothing while none are. What is done lets them go, and the bar goes with them: the keyboard
 * goes on to a row of the list, unless what was done took it somewhere, so the next key, or undo, is
 * the list's.
 */
export function SelectionBar({ list, actions = [] }: { list: RefObject<HTMLElement | null>; actions?: readonly SelectionAction[] }) {
  const picked = useSyncExternalStore(subscribe, () => count(list.current));
  if (!picked || !list.current) return null;
  const at = list.current;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected rows">
      <span className="selection-count" role="status">
        {picked} selected
      </span>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="button small"
          onClick={(e) => {
            const rows = selectedIn(at);
            action.run(rows);
            clear(at);
            const now = document.activeElement;
            const to = onward(at, rows);
            if (to && (!now || now === document.body || e.currentTarget.contains(now))) focusOn(restOf(to));
          }}
        >
          {action.icon && <Icon name={action.icon} />}
          {action.label}
        </button>
      ))}
      <button type="button" className="button small" onClick={() => clear(at)}>
        Clear
      </button>
    </div>
  );
}
