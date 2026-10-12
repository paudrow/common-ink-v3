import { useRef, type KeyboardEvent, type PointerEvent } from "react";

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
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The edge between two parts of the window, dragged to give one more room and the other less. It is
 * a focusable separator: the arrow keys move it a step, Home and End take it to its ends, and Enter
 * or a double-click puts it back.
 */
export function ResizeHandle({ label, orientation, value, min, max, step, perPixel, valueText, onChange, onReset }: Props) {
  const drag = useRef<{ from: number; value: number; perPixel: number } | null>(null);
  const along = (e: PointerEvent) => (orientation === "vertical" ? e.clientX : e.clientY);
  const [less, more] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const onKey = (e: KeyboardEvent) => {
    const sign = Math.sign(perPixel?.() ?? 1) || 1;
    const next = e.key === less ? value - sign * step : e.key === more ? value + sign * step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null && e.key !== "Enter") return;
    e.preventDefault();
    if (next === null) onReset();
    else onChange(clamp(next, min, max));
  };
  return (
    <div
      role="separator"
      className="resize-handle"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={valueText}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "";
        drag.current = { from: along(e), value, perPixel: perPixel?.() ?? 1 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onChange(clamp(d.value + (along(e) - d.from) * d.perPixel, min, max));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
      onDoubleClick={onReset}
      onKeyDown={onKey}
    />
  );
}
