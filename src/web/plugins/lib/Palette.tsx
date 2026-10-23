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
  /** How many are shown at most, for a list that can be long, as a workspace's notes can. Without it every item is: the commands are a few hundred at most, and the palette is where a member reads what there is. */
  most?: number;
  /** Shown when nothing matches what was typed. */
  empty: string;
  /** A switch under the box that widens what is listed, such as to archived notes. The box keeps the keyboard when it is clicked. */
  toggle?: { label: string; on: boolean; set: (on: boolean) => void };
  /**
   * Items found for what is typed some other way than by their label, such as events by their title
   * and a day: listed after the items whose label holds what is typed, and before those that only
   * have its letters in order.
   */
  found?: (typed: string) => PaletteItem[];
  /** What is listed before anything is typed, in place of the items, such as the tabs open and the places visited lately. */
  idle?: PaletteItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}

/** A box to type in over a list that narrows to what matches; the command palette and quick open are both one. */
export function Palette({ label, placeholder, items, most, empty, toggle, found, idle, onPick, onClose }: Props) {
  const ids = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [at, setAt] = useState(0);
  const matched = matching(items, typed, (item) => item.label).slice(0, most);
  const holding = matched.findIndex((item) => !item.label.toLowerCase().includes(typed.trim().toLowerCase()));
  const cut = holding < 0 ? matched.length : holding;
  const shown = idle && !typed.trim() ? idle : found ? [...matched.slice(0, cut), ...found(typed), ...matched.slice(cut)] : matched;
  const optionId = (i: number) => `${ids}-option-${i}`;

  useDismiss(onClose, ref);
  useEffect(() => {
    const focused = document.activeElement;
    input.current!.focus();
    return () => {
      // Back where it was, with whatever it is in scrolled as it was: a note's editor would otherwise be scrolled to its top.
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
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
