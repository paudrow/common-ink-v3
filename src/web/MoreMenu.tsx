import { useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { ContextMenu, type MenuItem } from "./plugins/lib/Menu.tsx";

/** A quiet "…" button that opens a menu under itself of what isn't the page's one primary action, and gives focus back when it closes. */
export function MoreMenu({ label, title, items }: { label: string; title: string; items: MenuItem[] }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = () => {
    setAt(null);
    button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          if (at) return close();
          const box = button.current!.getBoundingClientRect();
          setAt({ x: box.right - 180, y: box.bottom + 4 });
        }}
      >
        <Icon name="more" />
      </button>
      {at && <ContextMenu label={label} x={at.x} y={at.y} items={items} onClose={close} />}
    </>
  );
}
