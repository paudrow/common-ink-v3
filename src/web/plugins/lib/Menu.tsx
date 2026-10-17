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
}

interface Props {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 8;

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
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(EDGE, Math.min(x, innerWidth - EDGE - width))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(y, innerHeight - EDGE - height))}px`;
  }, [x, y]);
  useEffect(() => ref.current?.querySelector<HTMLElement>("button:enabled")?.focus(), []);
  return (
    <div ref={ref} role="menu" aria-label={label} className="menu" style={{ left: x, top: y }} onKeyDown={(e) => move(e, onClose)}>
      {items.map(({ label, icon, action, disabled, separated }) => (
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
          </button>
        </Fragment>
      ))}
    </div>
  );
}
