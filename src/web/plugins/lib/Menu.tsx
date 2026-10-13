import { useEffect, useLayoutEffect, useRef } from "react";
import { useDismiss } from "../../plugin-api.ts";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

interface Props {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 8;

/** A menu opened at a point, such as where a row was right-clicked. It is moved over where it would run off the window. */
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
    <div ref={ref} role="menu" aria-label={label} className="menu" style={{ left: x, top: y }}>
      {items.map(({ label, action, disabled }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={() => {
            onClose();
            action();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
