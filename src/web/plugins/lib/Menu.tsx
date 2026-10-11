import { useEffect, useRef } from "react";
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

/** A menu opened at a point, such as where a row was right-clicked. */
export function ContextMenu({ label, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, ref);
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
