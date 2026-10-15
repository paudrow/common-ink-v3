import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useDismiss } from "../../plugin-api.ts";

const GAP = 4;
const EDGE = 8;

let shown: { anchor: HTMLElement; close: () => void } | null = null;

/** Closes the popover that is open, if one is. */
export const closePopover = () => shown?.close();

/** Whether the popover that is open hangs from `anchor`. */
export const openFrom = (anchor: HTMLElement) => shown?.anchor === anchor;

/**
 * Opens a small panel under `anchor`, such as the form a chip is set with. It is laid over the app,
 * in an element of its own at the end of the page, so it takes no room in the note and moves nothing
 * there. It follows its anchor as the page scrolls, and closes on Escape, on a press outside it, when
 * `close` is called, and when its anchor is gone, as a chip is once its token is written another way.
 * One is open at a time, and opening it again from the same anchor closes it. `onClosed` is told when it
 * has closed, however that came about, and whether the keyboard was in it.
 */
export function openPopover(anchor: HTMLElement, label: string, content: (close: () => void) => ReactNode, onClosed?: (hadFocus: boolean) => void): void {
  const again = shown?.anchor === anchor;
  shown?.close();
  if (again) return;

  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const close = () => {
    if (shown?.close !== close) return;
    shown = null;
    const within = holder.contains(document.activeElement);
    root.unmount();
    holder.remove();
    if (within && anchor.isConnected) anchor.focus();
    onClosed?.(within);
  };
  shown = { anchor, close };
  root.render(
    <Panel anchor={anchor} label={label} close={close}>
      {content(close)}
    </Panel>,
  );
}

function Panel({ anchor, label, close, children }: { anchor: HTMLElement; label: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const from = useRef(anchor);
  useDismiss(close, ref, from);

  useLayoutEffect(() => {
    const el = ref.current!;
    const place = () => {
      if (!anchor.isConnected) return close();
      const at = anchor.getBoundingClientRect();
      const width = el.getBoundingClientRect().width;
      // Its whole height, however much of it is shown now.
      const height = el.scrollHeight;
      const below = at.bottom + GAP;
      const roomBelow = innerHeight - EDGE - below;
      const roomAbove = at.top - GAP - EDGE;
      // Under its anchor, or above it where there is no room under it. Where it fits on neither side it is on the side with
      // more room, as tall as that room, and scrolls: never over its anchor, so the thing it is for stays in sight.
      const under = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
      const room = under ? roomBelow : roomAbove;
      el.style.maxHeight = height > room ? `${Math.max(room, 0)}px` : "";
      el.style.left = `${Math.max(EDGE, Math.min(at.left, innerWidth - EDGE - width))}px`;
      el.style.top = `${under ? below : Math.max(EDGE, at.top - GAP - Math.min(height, room))}px`;
    };
    place();
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>("button:enabled, input:enabled, select:enabled"))?.focus();
    // Its own size changes as it loads or a part of it is opened, and it may then fit another way.
    const sized = new ResizeObserver(place);
    sized.observe(el);
    const gone = new MutationObserver(() => !anchor.isConnected && close());
    gone.observe(anchor.closest(".cm-content") ?? document.body, { childList: true, subtree: true });
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      sized.disconnect();
      gone.disconnect();
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [anchor, close]);

  return (
    <div ref={ref} role="dialog" aria-label={label} className="chip-popover">
      {children}
    </div>
  );
}
