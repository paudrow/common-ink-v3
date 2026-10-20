import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import type { Told } from "./notices.ts";
import type { Notice } from "./plugin-api.ts";

/** How long a card is shown before it goes away by itself, counted only while neither the pointer nor the keyboard is on it. */
export const TOAST_MS = { plain: 5000, action: 10_000 };
/** Left with less than this when the pointer or the keyboard leaves it, a card is given this much again. */
const AGAIN_MS = 2000;
/** How long it takes to fade out. */
const LEAVING_MS = 350;

/** How far the stack stands off the foot of the pane, and the least it keeps from the window's edges. */
const GAP = 12;
const EDGE = 8;

/**
 * Where the stack goes: centred under the pane the member is working in, which the editor area marks
 * with `data-front` and which is the whole editor area where it marks none, and above what is kept
 * at the foot of that pane, as vim's bar is, so a card never covers it.
 */
function placeUnder(stack: HTMLElement) {
  const main = document.querySelector<HTMLElement>("main.main");
  const pane = main?.querySelector<HTMLElement>(".group[data-front]") ?? main;
  if (!pane) return;
  const box = pane.getBoundingClientRect();
  const foot = [...pane.querySelectorAll<HTMLElement>(".note-foot")].find((f) => f.offsetHeight > 0);
  const bottom = foot ? foot.getBoundingClientRect().top : box.bottom;
  const half = stack.offsetWidth / 2;
  const centre = Math.min(Math.max(box.left + box.width / 2, half + EDGE), innerWidth - half - EDGE);
  stack.style.left = `${Math.round(centre)}px`;
  stack.style.bottom = `${Math.round(Math.max(innerHeight - bottom + GAP, EDGE))}px`;
}

/**
 * Every notice of the app, as cards stacked at the foot of the pane the member is working in, the
 * newest at the foot, each going after a few seconds. They are laid over the app, so nothing moves
 * when one comes or goes, and they follow the pane while they are shown. The stack is always there,
 * so a screen reader is told when a card arrives.
 */
export function Toasts({ told, onGone }: { told: readonly Told[]; onGone: (id: number) => void }) {
  const stack = useRef<HTMLDivElement>(null);
  const showing = told.length > 0;
  useLayoutEffect(() => {
    if (!showing) return;
    let frame = 0;
    const follow = () => {
      placeUnder(stack.current!);
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [showing]);
  return (
    <div ref={stack} className="toasts" aria-live="polite">
      {told.map(({ id, notice, leaving }) => (
        <Toast key={id} notice={notice} leaving={leaving} onGone={() => onGone(id)} />
      ))}
    </div>
  );
}

/** One card. A press on it, or Escape in it, sends it away, unless it `keeps`. Its button's answer, if any, is said in its place. */
function Toast({ notice, leaving: takenDown, onGone }: { notice: Notice; leaving?: boolean; onGone: () => void }) {
  const [said, say] = useState<Notice>(notice);
  const [leaving, setLeaving] = useState(false);
  const clock = useRef({ left: 0, since: 0, timer: 0, held: new Set<string>() });
  const card = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;

  const go = () => {
    clearTimeout(clock.current.timer);
    setLeaving(true);
  };
  const run = (ms: number) => {
    if (said.stays) return;
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
    run(said.action ? TOAST_MS.action : TOAST_MS.plain);
    return () => clearTimeout(clock.current.timer);
  }, [said]);
  useEffect(() => {
    if (takenDown) go();
  }, [takenDown]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => gone.current(), LEAVING_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const { message, icon = "info", action } = said;
  return (
    <div
      ref={card}
      className="toast-card"
      tabIndex={-1}
      role="group"
      aria-label="Notice"
      data-leaving={leaving || undefined}
      onClick={(e) => (e.target as HTMLElement).closest("button") || said.keeps || go()}
      onPointerEnter={() => hold("pointer")}
      onPointerLeave={() => release("pointer")}
      onFocus={() => hold("focus")}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && release("focus")}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (!said.keeps) go();
      }}
    >
      <span className="toast-icon">
        <Icon name={icon} />
      </span>
      <span className="toast-text">{message}</span>
      {[action ?? []].flat().map((action, i) => (
        <button
          key={i}
          type="button"
          className="toast-action"
          onClick={async (e) => {
            const byKeys = e.detail === 0;
            // It stays while the button's work is on its way, however long that takes, to say how it went.
            hold("action");
            say({ message, icon });
            const answer = await action.run();
            // The button is gone, and a removed element says nothing of losing the keyboard.
            clock.current.held.delete("focus");
            release("action");
            if (!answer) return go();
            say(answer);
            // Pressed by the keys, the keyboard stays on the card, where Escape sends it away.
            if (byKeys) setTimeout(() => card.current?.focus());
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
