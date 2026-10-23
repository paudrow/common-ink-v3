import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Icon, useDismiss, type IconName } from "../../plugin-api.ts";

export interface MenuItem {
  label: string;
  /** Drawn before the label, so a menu can be skimmed. A menu with one has room for it in every row. */
  icon?: IconName;
  action: () => void;
  disabled?: boolean;
  /** Set apart from the items before it by a line. */
  separated?: boolean;
  /** The key that does the same where the menu was opened, shown at the end of the row. */
  shortcut?: string;
}

interface Props {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 8;

let opened = 0;
const watchers = new Set<() => void>();

/** Whether a context menu is open, and a call each time one opens, for what would cover it, as a hover card does. */
export const contextMenus = {
  open: () => opened > 0,
  onOpen(watch: () => void) {
    watchers.add(watch);
    return () => void watchers.delete(watch);
  },
};

/** Up and Down from item to item, round from the last to the first, and Home and End to the ends. */
function move(e: KeyboardEvent<HTMLDivElement>, onClose: () => void) {
  if (e.key === "Tab") return onClose();
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:enabled')];
  const at = all.indexOf(document.activeElement as HTMLElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to === undefined || !all.length) return;
  e.preventDefault();
  all[(to + all.length) % all.length]!.focus();
}

/** A menu opened at a point, such as where a row was right-clicked. It is moved over where it would run off the window, and Tab closes it. */
export function ContextMenu({ label, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, ref);
  useLayoutEffect(() => {
    opened++;
    for (const watch of watchers) watch();
    return () => void opened--;
  }, []);
  // Placed again each time it is drawn: its items can change after it opens, as when what the member may do is read.
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(EDGE, Math.min(x, innerWidth - EDGE - width))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(y, innerHeight - EDGE - height))}px`;
  });
  useEffect(() => ref.current?.querySelector<HTMLElement>("button:enabled")?.focus(), []);
  return (
    <div ref={ref} role="menu" aria-label={label} className="menu" style={{ left: x, top: y }} onKeyDown={(e) => move(e, onClose)}>
      {items.map(({ label, icon, action, disabled, separated, shortcut }) => (
        <Fragment key={label}>
          {separated && <hr />}
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              onClose();
              action();
            }}
          >
            {(icon || items.some((item) => item.icon)) && <span className="menu-icon">{icon && <Icon name={icon} />}</span>}
            <span className="menu-label">{label}</span>
            {shortcut && <kbd className="menu-shortcut">{shortcut}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
