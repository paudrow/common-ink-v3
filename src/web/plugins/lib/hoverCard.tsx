import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { contextMenus } from "./Menu.tsx";

/** How long the pointer rests on an anchor before its card shows, so passing over one shows nothing. */
const SHOW_MS = 350;
/** How long the card stays once the pointer leaves its anchor and the card, and again each time it moves nearer the card on its way there. */
const HIDE_MS = 300;
const GAP = 6;
const EDGE = 8;

/** What shows a card: the pointer resting on its anchor, the keyboard on one, or the cursor in a tag in a note. Its holder's `data-showing` says which, and only a card the pointer shows catches the pointer. */
export type Showing = "pointer" | "focus" | "cursor";

export interface HoverCards {
  show(anchor: HTMLElement, key: string, how: Showing): void;
  /** Takes the card away, when it was shown that way. */
  hide(how: Showing): void;
  dispose(): void;
}

/**
 * The card anything marked `data-<kind>` shows while it is pointed at or has the keyboard, wherever
 * it is drawn: a tag's (`data-tag` with its name) or a folder's (`data-folder` with its id). One
 * marked `data-<kind>-card="beside"` too, a row of a list, has it beside it rather than under it.
 * `content` draws what the card says of that key, or null for a key it knows nothing of, which shows
 * no card. It is laid over the app at the end of the page,
 * or of the dialog the anchor is in, so it moves nothing, and is a tooltip the anchor is described by.
 */
export function hoverCards(kind: string, content: (key: string, close: () => void) => ReactNode): HoverCards {
  const beside = `${kind}Card`;
  const anchorOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(`[data-${kind}]`) : null);
  let shown: { anchor: HTMLElement; key: string; how: Showing } | null = null;
  let holder: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let showing: ReturnType<typeof setTimeout> | undefined;
  let hiding: ReturnType<typeof setTimeout> | undefined;
  /** The anchor the card describes, and what described it before, which it is given back. */
  let described: { anchor: HTMLElement; before: string | null } | null = null;

  const close = () => {
    clearTimeout(hiding);
    if (described) {
      const { anchor, before } = described;
      if (before === null) anchor.removeAttribute("aria-describedby");
      else anchor.setAttribute("aria-describedby", before);
      described = null;
    }
    shown = null;
    root?.unmount();
    holder?.remove();
    root = holder = null;
  };

  const open = (anchor: HTMLElement, key: string, how: Showing) => {
    clearTimeout(showing);
    clearTimeout(hiding);
    // A card would cover the menu, which is beside its anchor too.
    if (contextMenus.open()) return close();
    if (shown?.anchor === anchor && shown.key === key) {
      shown.how = how;
      holder!.dataset.showing = how;
      return;
    }
    close();
    const drawn = content(key, close);
    if (drawn === null) return;
    shown = { anchor, key, how };
    // Inside a modal dialog, such as Settings, only what is in the dialog is drawn over it.
    holder = (anchor.closest("dialog[open]") ?? document.body).appendChild(document.createElement("div"));
    holder.dataset.showing = how;
    root = createRoot(holder);
    const id = `${kind}-card-${Math.random().toString(36).slice(2)}`;
    // The cursor in a note's text is no element of its own to describe.
    if (how !== "cursor") {
      const before = anchor.getAttribute("aria-describedby");
      described = { anchor, before };
      anchor.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    }
    root.render(
      <Card id={id} kind={kind} anchor={anchor} beside={anchor.dataset[beside] === "beside"} onClose={close} onPointer={(inside) => (inside ? clearTimeout(hiding) : shown?.how === "pointer" && later())}>
        {drawn}
      </Card>,
    );
  };

  /** How far the pointer was from the card when it last moved while the card was going. */
  let away = Infinity;
  const later = () => {
    clearTimeout(hiding);
    hiding = setTimeout(close, HIDE_MS);
  };
  // On its way to the card the pointer can cross other rows and anchors, slowly, as to a link at the card's foot: while it keeps nearing the card, the card waits.
  const moved = (e: PointerEvent) => {
    const card = holder?.firstElementChild;
    if (!card || shown?.how !== "pointer" || anchorOf(e.target) === shown.anchor || card.contains(e.target as Node)) return void (away = Infinity);
    const box = card.getBoundingClientRect();
    const near = Math.hypot(Math.max(box.left - e.clientX, 0, e.clientX - box.right), Math.max(box.top - e.clientY, 0, e.clientY - box.bottom));
    if (near < away) later();
    away = near;
  };

  /** The row a click was on, which shows no card until the pointer has left it: a click is no rest, and the card beside the row would cover the list the click opened. */
  let pressed: string | undefined;
  const down = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const anchor = anchorOf(e.target);
    if (anchor?.dataset[beside] !== "beside") return;
    clearTimeout(showing);
    pressed = anchor.dataset[kind];
    if (shown?.anchor === anchor) close();
  };

  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const anchor = anchorOf(e.target);
    const key = anchor?.dataset[kind];
    if (!anchor || !key || key === pressed) return;
    if (shown?.anchor === anchor) return void clearTimeout(hiding);
    clearTimeout(showing);
    showing = setTimeout(() => anchor.isConnected && open(anchor, key, "pointer"), SHOW_MS);
  };
  const out = (e: PointerEvent) => {
    const anchor = anchorOf(e.target);
    if (!anchor) return;
    if (e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget)) return;
    if (anchor.dataset[kind] === pressed) pressed = undefined;
    if (!shown || shown.anchor !== anchor) return void clearTimeout(showing);
    if (shown.how === "pointer") later();
  };
  // The keyboard's focus, and not a click's, which is the pointer's.
  const focused = (e: FocusEvent) => {
    const anchor = e.target instanceof HTMLElement && e.target.dataset[kind] !== undefined && e.target.matches(":focus-visible") ? e.target : null;
    const key = anchor?.dataset[kind];
    if (anchor && key) open(anchor, key, "focus");
  };
  const blurred = (e: FocusEvent) => {
    if (shown?.how === "focus" && e.target === shown.anchor && !(e.relatedTarget instanceof Node && holder?.contains(e.relatedTarget))) close();
  };
  // Escape takes the card away. With the keyboard on its anchor or in it, that is all it does, as from a dialog it is shown in;
  // otherwise the keyboard is somewhere else, a menu or a dialog the pointer happens to rest beside, or the note under the cursor's
  // card, as vim's, and Escape goes on to it too.
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    clearTimeout(showing);
    if (!shown) return;
    const at = document.activeElement;
    if (shown.how !== "cursor" && at && (at === shown.anchor || holder?.contains(at))) {
      e.preventDefault();
      e.stopPropagation();
    }
    close();
  };

  // There is no page where plugins are started to read what they add, as a test of them does.
  const page = globalThis.document as Document | undefined;
  page?.addEventListener("pointerdown", down, true);
  page?.addEventListener("pointerover", over, true);
  page?.addEventListener("pointerout", out, true);
  page?.addEventListener("pointermove", moved, true);
  page?.addEventListener("focusin", focused, true);
  page?.addEventListener("focusout", blurred, true);
  page?.addEventListener("keydown", escape, true);
  const unwatch = contextMenus.onOpen(() => {
    clearTimeout(showing);
    close();
  });

  return {
    show: open,
    hide(how) {
      if (shown?.how === how) close();
    },
    dispose() {
      clearTimeout(showing);
      close();
      page?.removeEventListener("pointerdown", down, true);
      page?.removeEventListener("pointerover", over, true);
      page?.removeEventListener("pointerout", out, true);
      page?.removeEventListener("pointermove", moved, true);
      page?.removeEventListener("focusin", focused, true);
      page?.removeEventListener("focusout", blurred, true);
      page?.removeEventListener("keydown", escape, true);
      unwatch();
    },
  };
}

function Card({ id, kind, anchor, beside, onClose, onPointer, children }: { id: string; kind: string; anchor: HTMLElement; beside: boolean; onClose: () => void; onPointer: (inside: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const place = () => {
      // Not while React is drawing it: the card's own root is what closing takes away.
      if (!anchor.isConnected) return queueMicrotask(onClose);
      const at = anchor.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const within = (x: number, most: number) => Math.max(EDGE, Math.min(x, most - EDGE));
      // An anchor that is a row of a list, as in the sidebar, has its card beside it, so the rows under it can still be pointed at.
      if (beside) {
        const right = at.right + GAP + width <= innerWidth - EDGE;
        el.style.left = `${right ? at.right + GAP : within(at.left - GAP - width, innerWidth - width)}px`;
        el.style.top = `${within(at.top, innerHeight - height)}px`;
        return;
      }
      const under = at.bottom + GAP + height <= innerHeight - EDGE || at.top - GAP - height < EDGE;
      el.style.left = `${within(at.left, innerWidth - width)}px`;
      el.style.top = `${under ? at.bottom + GAP : at.top - GAP - height}px`;
    };
    place();
    const sized = new ResizeObserver(place);
    sized.observe(el);
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      sized.disconnect();
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [anchor, beside, onClose]);

  return (
    <div ref={ref} id={id} role="tooltip" className={`hover-card ${kind}-card`} onPointerEnter={() => onPointer(true)} onPointerLeave={() => onPointer(false)}>
      {children}
    </div>
  );
}
