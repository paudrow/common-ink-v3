import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useDismiss } from "../../plugin-api.ts";

const GAP = 4;
const EDGE = 8;

let shown: { anchor: HTMLElement; close: () => void } | null = null;

/**
 * Opens a small panel under `anchor`, such as the form a chip is set with. It is laid over the app,
 * in an element of its own at the end of the page, so it takes no room in the note and moves nothing
 * there. It follows its anchor as the page scrolls, and closes on Escape, on a press outside it, when
 * `close` is called, and when its anchor is gone, as a chip is once its token is written another way.
 * One is open at a time, and opening it again from the same anchor closes it.
 */
export function openPopover(anchor: HTMLElement, label: string, content: (close: () => void) => ReactNode): void {
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
  };
  shown = { anchor, close };
  root.render(
    <Panel anchor={anchor} label={label} close={close}>
      {content(close)}
    </Panel>,
  );
}

/** Closes the panel that is open, if one is. */
export const closePopover = () => shown?.close();

function Panel({ anchor, label, close, children }: { anchor: HTMLElement; label: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const from = useRef(anchor);
  useDismiss(close, ref, from);

  useLayoutEffect(() => {
    const el = ref.current!;
    const place = () => {
      if (!anchor.isConnected) return close();
      const at = anchor.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const below = at.bottom + GAP;
      // Above its anchor where there is no room below and there is above.
      const top = below + height > innerHeight - EDGE && at.top - GAP - height >= EDGE ? at.top - GAP - height : below;
      el.style.left = `${Math.max(EDGE, Math.min(at.left, innerWidth - EDGE - width))}px`;
      // Where it fits neither below nor above, it is kept inside the window, over its anchor.
      el.style.top = `${Math.max(EDGE, Math.min(top, innerHeight - EDGE - height))}px`;
    };
    place();
    el.querySelector<HTMLElement>("[data-autofocus], button:enabled, input:enabled, select:enabled")?.focus();
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
