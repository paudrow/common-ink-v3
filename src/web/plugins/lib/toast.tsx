import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Icon, type IconName } from "../../plugin-api.ts";

export interface Toast {
  text: string;
  /** The icon in its tile, a tick unless said. */
  icon?: IconName;
  /** What Undo does. It answers with what to say when it couldn't be done, and with nothing when it was. */
  undo?: () => Promise<string | undefined> | string | undefined;
  /** What it offers instead of Undo, such as Refresh: pressed, it is done and the toast goes. */
  action?: { label: string; run: () => void };
  /** Whether it stays until it is answered or sent away, as one that says something still so does. */
  stays?: boolean;
}

/** How long a toast is shown before it goes away by itself, counted only while neither the pointer nor the keyboard is on it. */
export const TOAST_MS = { plain: 5000, undo: 10_000 };
/** Left with less than this when the pointer or the keyboard leaves it, a toast is given this much again. */
const AGAIN_MS = 2000;
/** How long it takes to fade out. */
const LEAVING_MS = 350;

let root: Root | null = null;
let count = 0;
type Placed = { id: number; toast: Toast };
/** The toast shown now, until it has gone. */
let up: Placed | null = null;
/** A toast that stays, kept back while one with an Undo is up, so that it never takes an Undo's place; it is shown when that one goes. */
let behind: Placed | null = null;

const draw = ({ id, toast }: Placed, gone = false) => {
  up = { id, toast };
  root!.render(
    <Shown
      key={id}
      toast={toast}
      gone={gone}
      onGone={() => {
        if (up?.id !== id) return;
        up = null;
        const next = behind;
        behind = null;
        if (next) draw(next);
      }}
    />,
  );
};

/**
 * Says something in the window's bottom right corner for a few seconds, with an Undo when there is
 * one, as v1's toasts did. It is laid over the app from an element of its own at the end of the page,
 * so nothing moves when it comes and goes, and anything can show one: a page, or a chip in a note.
 * One is shown at a time, and a newer one takes its place, except that one that stays waits behind an
 * Undo, and comes back after one that took its place. A press on it, or Escape in it, sends it away.
 * It answers with what takes it away, which does nothing once another has taken its place.
 */
export function showToast(toast: Toast): () => void {
  root ??= createRoot(Object.assign(document.body.appendChild(document.createElement("div")), { className: "toasts" }));
  const placed = { id: ++count, toast };
  if (toast.stays && up?.toast.undo) behind = placed;
  else {
    if (toast.undo && up?.toast.stays) behind = up;
    draw(placed);
  }
  return () => {
    if (behind?.id === placed.id) behind = null;
    else if (up?.id === placed.id) draw(placed, true);
  };
}

function Shown({ toast, gone, onGone }: { toast: Toast; gone: boolean; onGone: () => void }) {
  const [said, say] = useState<Toast | null>(toast);
  const [leaving, setLeaving] = useState(false);
  const clock = useRef({ left: 0, since: 0, timer: 0, held: new Set<string>() });

  const go = () => {
    clearTimeout(clock.current.timer);
    setLeaving(true);
  };
  const run = (ms: number) => {
    if (toast.stays) return;
    const at = clock.current;
    clearTimeout(at.timer);
    at.left = ms;
    at.since = Date.now();
    // While the pointer or the keyboard is on it, the time starts when they leave.
    if (!at.held.size) at.timer = window.setTimeout(go, ms);
  };
  const hold = (why: string) => {
    const at = clock.current;
    if (!at.held.size) {
      clearTimeout(at.timer);
      at.left -= Date.now() - at.since;
    }
    at.held.add(why);
  };
  const release = (why: string) => {
    const at = clock.current;
    if (!at.held.delete(why) || at.held.size) return;
    run(Math.max(at.left, AGAIN_MS));
  };

  useEffect(() => {
    if (!said) return;
    run(said.undo ? TOAST_MS.undo : TOAST_MS.plain);
    return () => clearTimeout(clock.current.timer);
  }, [said]);
  useEffect(() => {
    if (gone) go();
  }, [gone]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      say(null);
      onGone();
    }, LEAVING_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (!said) return null;
  const { text, icon = "check", undo, action } = said;
  return (
    <div
      className="toast-card"
      data-leaving={leaving || undefined}
      role="status"
      onClick={(e) => (e.target as HTMLElement).closest("button") || go()}
      onPointerEnter={() => hold("pointer")}
      onPointerLeave={() => release("pointer")}
      onFocus={() => hold("focus")}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && release("focus")}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        go();
      }}
    >
      <span className="toast-icon">
        <Icon name={icon} />
      </span>
      <span className="toast-text">{text}</span>
      {undo && (
        <button
          type="button"
          className="toast-action"
          onClick={async () => {
            say({ text, icon });
            const problem = await undo();
            if (problem) say({ text: problem, icon: "info" });
            else go();
          }}
        >
          Undo
        </button>
      )}
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            go();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
