import { useEffect, useId, useRef, useState } from "react";
import { useDismiss } from "../../plugin-api.ts";
import { matching } from "./match.ts";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
}

interface Props {
  label: string;
  placeholder: string;
  items: PaletteItem[];
  /** Shown when nothing matches what was typed. */
  empty: string;
  /** A switch under the box that widens what is listed, such as to archived notes. The box keeps the keyboard when it is clicked. */
  toggle?: { label: string; on: boolean; set: (on: boolean) => void };
  onPick: (id: string) => void;
  onClose: () => void;
}

const MOST_SHOWN = 50;

/** A box to type in over a list that narrows to what matches; the command palette and quick open are both one. */
export function Palette({ label, placeholder, items, empty, toggle, onPick, onClose }: Props) {
  const ids = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [at, setAt] = useState(0);
  const shown = matching(items, typed, (item) => item.label).slice(0, MOST_SHOWN);
  const optionId = (i: number) => `${ids}-option-${i}`;

  useDismiss(onClose, ref);
  useEffect(() => {
    const focused = document.activeElement;
    input.current!.focus();
    return () => {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);
  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (item: PaletteItem) => {
    onClose();
    onPick(item.id);
  };

  return (
    <div ref={ref} className="palette" role="dialog" aria-label={label}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded
        aria-controls={`${ids}-list`}
        aria-activedescendant={shown.length ? optionId(at) : undefined}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (shown.length) setAt((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[at]) pick(shown[at]);
          }
        }}
      />
      {toggle && (
        <div className="palette-tools">
          <button
            type="button"
            className="chip"
            aria-pressed={toggle.on}
            onClick={() => {
              toggle.set(!toggle.on);
              setAt(0);
              input.current?.focus();
            }}
          >
            {toggle.label}
          </button>
        </div>
      )}
      <ul id={`${ids}-list`} role="listbox" aria-label={label}>
        {shown.map((item, i) => (
          <li key={item.id} id={optionId(i)} role="option" aria-selected={i === at} onPointerMove={() => setAt(i)} onClick={() => pick(item)}>
            <span className="palette-label">{item.label}</span>
            {item.hint && <span className="palette-hint">{item.hint}</span>}
          </li>
        ))}
      </ul>
      {!shown.length && <p className="empty">{empty}</p>}
    </div>
  );
}
