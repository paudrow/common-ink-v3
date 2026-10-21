import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { nameKey, type App, type ListedTag, type PluginHost } from "../../plugin-api.ts";
import { MANAGE_PATH, tagPath } from "./path.ts";
import { describes, going, type TagStore } from "./Tags.tsx";

/** How long the pointer rests on a tag before its card shows, so passing over one shows nothing. */
const SHOW_MS = 350;
/** How long the card stays once the pointer leaves, so it can be crossed to reach the card's links. */
const HIDE_MS = 200;
const GAP = 6;
const EDGE = 8;

/** What shows a card: the pointer resting on a tag, the keyboard on one, or the cursor in a tag in a note. */
export type Showing = "pointer" | "focus" | "cursor";

export interface TagCards {
  show(anchor: HTMLElement, name: string, how: Showing): void;
  /** Takes the card away, when it was shown that way. */
  hide(how: Showing): void;
  dispose(): void;
}

const tagOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-tag]") : null);

/**
 * The card a tag shows while it is pointed at or has the keyboard, wherever it is drawn: anything
 * marked `data-tag` with the tag's name, as a tag in a note, a todo's chip and the sidebar's rows are.
 * One marked `data-tag-card="beside"` too, a row of a list, has it beside it rather than under it.
 * It says how many notes have the tag and what it is for. With nothing said, it asks whoever may say
 * it to, with a link to its row in Settings, and shows anyone else the name and count alone. It is laid over
 * the app at the end of the page, or of the dialog the tag is in, so it moves nothing.
 */
export function tagCards(host: PluginHost, store: TagStore): TagCards {
  let shown: { anchor: HTMLElement; name: string; how: Showing } | null = null;
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

  const open = (anchor: HTMLElement, name: string, how: Showing) => {
    clearTimeout(showing);
    clearTimeout(hiding);
    if (shown?.anchor === anchor && shown.name === name) {
      shown.how = how;
      return;
    }
    close();
    shown = { anchor, name, how };
    // Inside a modal dialog, such as Settings, only what is in the dialog is drawn over it.
    holder = (anchor.closest("dialog[open]") ?? document.body).appendChild(document.createElement("div"));
    root = createRoot(holder);
    const id = `tag-card-${Math.random().toString(36).slice(2)}`;
    // The cursor in a note's text is no element of its own to describe.
    if (how !== "cursor") {
      const before = anchor.getAttribute("aria-describedby");
      described = { anchor, before };
      anchor.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    }
    root.render(<Card id={id} host={host} store={store} anchor={anchor} name={name} onClose={close} onPointer={(inside) => (inside ? clearTimeout(hiding) : later())} />);
  };

  const later = () => {
    clearTimeout(hiding);
    hiding = setTimeout(close, HIDE_MS);
  };

  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const anchor = tagOf(e.target);
    const name = anchor?.dataset.tag;
    if (!anchor || !name) return;
    if (shown?.anchor === anchor) return void clearTimeout(hiding);
    clearTimeout(showing);
    showing = setTimeout(() => anchor.isConnected && open(anchor, name, "pointer"), SHOW_MS);
  };
  const out = (e: PointerEvent) => {
    const anchor = tagOf(e.target);
    if (!anchor) return;
    if (e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget)) return;
    if (!shown || shown.anchor !== anchor) return void clearTimeout(showing);
    if (shown.how === "pointer") later();
  };
  // The keyboard's focus, and not a click's, which the pointer resting there already answers.
  const focused = (e: FocusEvent) => {
    const anchor = e.target instanceof HTMLElement && e.target.dataset.tag !== undefined && e.target.matches(":focus-visible") ? e.target : null;
    if (anchor?.dataset.tag) open(anchor, anchor.dataset.tag, "focus");
  };
  const blurred = (e: FocusEvent) => {
    if (shown?.how === "focus" && e.target === shown.anchor && !(e.relatedTarget instanceof Node && holder?.contains(e.relatedTarget))) close();
  };
  // Escape takes the card away and does nothing else, as from a dialog it is shown in. The cursor's card lets it through to the note, as to vim.
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    clearTimeout(showing);
    if (!shown) return;
    if (shown.how !== "cursor") {
      e.preventDefault();
      e.stopPropagation();
    }
    close();
  };

  // There is no page where plugins are started to read what they add, as a test of them does.
  const page = globalThis.document as Document | undefined;
  page?.addEventListener("pointerover", over, true);
  page?.addEventListener("pointerout", out, true);
  page?.addEventListener("focusin", focused, true);
  page?.addEventListener("focusout", blurred, true);
  page?.addEventListener("keydown", escape, true);

  return {
    show: open,
    hide(how) {
      if (shown?.how === how) close();
    },
    dispose() {
      clearTimeout(showing);
      close();
      page?.removeEventListener("pointerover", over, true);
      page?.removeEventListener("pointerout", out, true);
      page?.removeEventListener("focusin", focused, true);
      page?.removeEventListener("focusout", blurred, true);
      page?.removeEventListener("keydown", escape, true);
    },
  };
}

/** The tag as the plugin last read it, or as the server says it alone when it is past the tags read. Undefined until known. */
function useTag(host: PluginHost, store: TagStore, name: string): ListedTag | null | undefined {
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const listed = tags?.find((t) => nameKey(t.name) === nameKey(name));
  const [asked, setAsked] = useState<ListedTag | null | undefined>(undefined);
  useEffect(() => {
    if (listed || !tags) return;
    let live = true;
    host.perform({ type: "tag.list", name, includeArchived: true, limit: 1 }).then(
      ({ tags }) => live && setAsked(tags[0] ?? null),
      () => live && setAsked(null),
    );
    return () => {
      live = false;
    };
  }, [host, name, !!listed, !!tags]);
  return listed ?? asked;
}

function Card({ id, host, store, anchor, name, onClose, onPointer }: { id: string; host: PluginHost; store: TagStore; anchor: HTMLElement; name: string; onClose: () => void; onPointer: (inside: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tag = useTag(host, store, name);
  const app: App = host.app();

  useLayoutEffect(() => {
    const el = ref.current!;
    const place = () => {
      // Not while React is drawing it: the card's own root is what closing takes away.
      if (!anchor.isConnected) return queueMicrotask(onClose);
      const at = anchor.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const within = (x: number, most: number) => Math.max(EDGE, Math.min(x, most - EDGE));
      // A tag that is a row of a list, as in the sidebar, has its card beside it, so the rows under it can still be pointed at.
      if (anchor.dataset.tagCard === "beside") {
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
  }, [anchor, onClose]);

  const shownName = tag?.name ?? name;
  const leave = (path: string, before?: () => void) => {
    const link = going(app, path);
    return {
      ...link,
      onClick(e: MouseEvent) {
        // Only a plain click goes there here; a modified one opens a new tab, which asks nothing of this one's Settings.
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) before?.();
        link.onClick(e);
        onClose();
      },
    };
  };
  return (
    <div ref={ref} id={id} role="tooltip" className="tag-card" onPointerEnter={() => onPointer(true)} onPointerLeave={() => onPointer(false)}>
      <div className="tag-card-head">
        <a className="tag-card-name" {...leave(tagPath(shownName))}>
          #{shownName}
        </a>
        {tag !== undefined && <span className="tag-card-count">{`${tag?.notes ?? 0} ${tag?.notes === 1 ? "note" : "notes"}`}</span>}
      </div>
      {tag?.description ? (
        <p className="tag-card-description">{tag.description}</p>
      ) : (
        tag !== undefined && describes(app) && <p className="tag-card-none">No description yet. Add one to help AI use #{shownName} right.</p>
      )}
      {tag !== undefined && describes(app) && (
        <a className="tag-card-manage" {...leave(MANAGE_PATH, () => store.ask({ name: shownName, kind: null }))}>
          Manage tags
        </a>
      )}
    </div>
  );
}
