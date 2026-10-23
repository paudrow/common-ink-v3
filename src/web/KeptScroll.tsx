import { useLayoutEffect, useRef, type ReactNode } from "react";
import { keptThroughReload } from "./stored.ts";

type Scrolled = Record<string, number>;
const isScrolled = (v: unknown): v is Scrolled => !!v && typeof v === "object" && Object.values(v).every((top) => typeof top === "number");
/** How far each part of a page that scrolls was scrolled, by the page and where each part is in it: the indexes of the elements down to it. */
const kept = keptThroughReload("ink.page-scroll", isScrolled, 100);
/** How long a page goes on returning to where it was left as what it shows comes in. One that has become shorter since never gets there. */
const RETURNING_MS = 5000;

const pathOf = (el: Element, root: Element) => {
  const path: number[] = [];
  for (let at = el; at !== root && at.parentElement; at = at.parentElement) path.unshift([...at.parentElement.children].indexOf(at));
  return path.join(" ");
};
const at = (path: string, root: Element) => (path ? path.split(" ") : []).reduce<Element | undefined>((el, i) => el?.children[Number(i)], root);

/**
 * A page that keeps where it was scrolled to through being drawn again, as when its tab is gone back
 * to or the window is loaded again. Each part of it that scrolls goes back there as what it shows comes
 * in, until it is there, or the member scrolls or presses something first.
 */
export function KeptScroll({ place, className, children }: { place: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current!;
    const scrolled: Scrolled = { ...kept.get(place) };
    const returning = new Map(Object.entries(scrolled));
    const settle = () => {
      for (const [path, top] of returning) {
        const el = at(path, root);
        if (!el) continue;
        el.scrollTop = top;
        if (Math.abs(el.scrollTop - top) < 1) returning.delete(path);
      }
      if (!returning.size) takeOver();
    };
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      const path = pathOf(e.target, root);
      if (returning.has(path)) return;
      scrolled[path] = e.target.scrollTop;
      kept.set(place, scrolled);
    };
    const coming = new MutationObserver(settle);
    const givingUp = setTimeout(() => takeOver(), RETURNING_MS);
    const memberMoves = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
    function takeOver() {
      returning.clear();
      coming.disconnect();
      clearTimeout(givingUp);
      for (const type of memberMoves) root.removeEventListener(type, takeOver, true);
    }
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    for (const type of memberMoves) root.addEventListener(type, takeOver, { capture: true, passive: true });
    if (returning.size) {
      coming.observe(root, { childList: true, subtree: true });
      settle();
    } else takeOver();
    return () => {
      takeOver();
      root.removeEventListener("scroll", onScroll, true);
    };
  }, [place]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
