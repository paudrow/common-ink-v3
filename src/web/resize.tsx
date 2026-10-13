import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { draggedTo, grabbed, type Dragged } from "./sideDrag.ts";

interface Props {
  /** What it resizes, for a screen reader: "Resize sidebar". */
  label: string;
  /** Which way the bar itself runs. A vertical bar stands between things side by side and is dragged left and right. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  /** How far one press of an arrow key moves it. */
  step: number;
  /** How much the value changes for each pixel dragged right or down, read when a drag starts. Negative where dragging that way makes the thing smaller. 1 unless said. */
  perPixel?: () => number;
  /** What the value is read out as, where it isn't a number of pixels. */
  valueText?: string;
  onChange: (value: number) => void;
  /** Double-click, or Enter, puts it back to how it starts. */
  onReset: () => void;
  /**
   * For the edge of something that folds away to a bar `size` wide, as the sidebar does. Dragged well
   * under `min` it folds, and the bar's edge dragged out opens it: see `draggedTo`. `value` is then
   * the width it opens at.
   */
  fold?: { folded: boolean; size: number; onFold: (folded: boolean) => void };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** How far the pointer goes before a press on an edge is a drag. */
const DRAG_PX = 3;
const DOUBLE_CLICK_MS = 500;

/**
 * The edge between two parts of the window, dragged to give one more room and the other less. It is
 * a focusable separator: the arrow keys move it a step, Home and End take it to its ends, and Enter
 * or a double-click puts it back. One that folds is folded by Home, or by an arrow key at its least
 * width, and opened by End, Enter, the other arrow key, or a press on it.
 */
export function ResizeHandle({ label, orientation, value, min, max, step, perPixel, valueText, onChange, onReset, fold }: Props) {
  const drag = useRef<{ from: number; asked: number; perPixel: number; kept: number; narrower: number; side: Dragged; moved: boolean } | null>(null);
  /** Whether the last press on it was let go of with no drag. */
  const pressed = useRef(false);
  const along = (e: PointerEvent) => (orientation === "vertical" ? e.clientX : e.clientY);
  const [less, more] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const onKey = (e: KeyboardEvent) => {
    const sign = Math.sign(perPixel?.() ?? 1) || 1;
    const next = e.key === less ? value - sign * step : e.key === more ? value + sign * step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null && e.key !== "Enter") return;
    e.preventDefault();
    if (fold?.folded) {
      if (next === null || next > value || e.key === "End") fold.onFold(false);
    } else if (fold && next !== null && (e.key === "Home" || (next < value && value <= min))) fold.onFold(true);
    else if (next === null) onReset();
    else onChange(clamp(next, min, max));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    pressed.current = e.type === "pointerup" && !!drag.current && !drag.current.moved;
    drag.current = null;
    delete e.currentTarget.dataset.dragging;
  };
  /** A press on a folded edge opens its side. The second click of a double click is then over what opened, and is dropped so it presses nothing there. */
  const press = () => {
    if (!fold?.folded || !pressed.current) return;
    fold.onFold(false);
    const drop = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const over = () => ["click", "dblclick"].forEach((type) => removeEventListener(type, drop, true));
    addEventListener("click", drop, true);
    addEventListener("dblclick", drop, true);
    setTimeout(over, DOUBLE_CLICK_MS);
  };
  return (
    <div
      role="separator"
      className="resize-handle"
      data-folds={fold ? (fold.folded ? "folded" : "open") : undefined}
      title={fold ? (fold.folded ? "Drag or press to open" : "Drag to resize, or past its narrowest to collapse") : undefined}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(fold?.folded ? fold.size : value)}
      aria-valuemin={Math.round(fold ? fold.size : min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={fold?.folded ? "Collapsed" : valueText}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "";
        const each = perPixel?.() ?? 1;
        // In a narrow window a side is drawn narrower than it was dragged to. It folds by where the pointer is on what is drawn, and its kept width changes by as far as it is dragged.
        const drawn = fold && (each > 0 ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling)?.getBoundingClientRect().width;
        const narrower = fold && !fold.folded && drawn ? Math.max(0, value - drawn) : 0;
        drag.current = { from: along(e), asked: drawn ?? value, perPixel: each, kept: value, narrower, side: grabbed(!fold?.folded, value - narrower), moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const by = along(e) - d.from;
        d.moved ||= Math.abs(by) > DRAG_PX;
        const asked = d.asked + by * d.perPixel;
        if (!fold) return onChange(clamp(asked, min, max));
        if (!d.moved) return;
        const side = draggedTo({ min, max, folded: fold.size }, d.kept - d.narrower, d.side, asked);
        if (side.open !== d.side.open) fold.onFold(!side.open);
        if (side.width !== d.side.width) onChange(Math.min(max, side.width + d.narrower));
        d.side = side;
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={press}
      onDoubleClick={onReset}
      onKeyDown={onKey}
    />
  );
}
