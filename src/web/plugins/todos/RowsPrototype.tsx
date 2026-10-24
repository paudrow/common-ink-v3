// PROTOTYPE, throw away. Four layouts for the Todos page's rows, switched by ?rows=A|B|C|D on the Todos page,
// to answer "what should a todo row look like?" (Audrow, 23 Oct). Only in dev builds. Not for main.
import { useEffect, useState } from "react";
import { addDays } from "./dates.ts";
import "./rows-prototype.css";

export const ROW_VARIANTS = {
  A: "Today's rows",
  B: "One line, dividers",
  C: "Compact two lines, grouped by when",
  D: "Grouped by note",
  E: "A, but no empty line when narrow",
} as const;
export type RowVariant = keyof typeof ROW_VARIANTS;
const KEYS = Object.keys(ROW_VARIANTS) as RowVariant[];
const at = (i: number): RowVariant => KEYS[((i % KEYS.length) + KEYS.length) % KEYS.length]!;

const read = (): RowVariant => {
  const v = new URLSearchParams(location.search).get("rows")?.toUpperCase();
  return v && v in ROW_VARIANTS ? (v as RowVariant) : "A";
};

export function useRowVariant(): RowVariant {
  const [variant, setVariant] = useState<RowVariant>(read);
  useEffect(() => {
    const changed = () => setVariant(read());
    addEventListener("popstate", changed);
    addEventListener("rows-variant", changed);
    return () => {
      removeEventListener("popstate", changed);
      removeEventListener("rows-variant", changed);
    };
  }, []);
  return variant;
}

const go = (variant: RowVariant) => {
  const url = new URL(location.href);
  url.searchParams.set("rows", variant);
  history.replaceState(history.state, "", url);
  dispatchEvent(new Event("rows-variant"));
};

/** When a todo is due, as variant C groups by. */
export function whenGroup(due: string | null | undefined, now: string): string {
  if (!due) return "No date";
  if (due < now) return "Overdue";
  if (due === now) return "Today";
  if (due <= addDays(now, 6)) return "This week";
  return "Later";
}

export function RowsSwitcher({ variant }: { variant: RowVariant }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const here = KEYS.indexOf(read());
      go(at(here + (e.key === "ArrowRight" ? 1 : -1)));
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (!import.meta.env.DEV) return null;
  const here = KEYS.indexOf(variant);
  return (
    <div className="rows-proto-bar" role="toolbar" aria-label="Row layout prototype">
      <button type="button" onClick={() => go(at(here - 1))} aria-label="Previous layout">
        ←
      </button>
      <span>
        {variant} · {ROW_VARIANTS[variant]}
      </span>
      <button type="button" onClick={() => go(at(here + 1))} aria-label="Next layout">
        →
      </button>
      <small>⌥← ⌥→</small>
    </div>
  );
}
