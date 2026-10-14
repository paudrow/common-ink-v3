import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { WrittenLink } from "../../plugin-api.ts";
import { chips, editWithin, unitAtCursor, type Chip } from "../lib/chips.ts";
import { drawnInView, within } from "../lib/live.ts";
import { MOD } from "../lib/opening.ts";
import { noteLinks, noteLinksOn } from "./at.ts";

/** A linked note's title; null when there is no such note that the member can see; undefined while the notes are still being listed. */
export type TitleOf = (noteId: string) => string | null | undefined;

const UNAVAILABLE = "Unavailable note";
/** What hovering a link says of clicking it: drawn, where a click follows it, and as written, where a click is for the cursor. */
const HOW = { drawn: `Click to open · ${MOD}-click to open in a new tab`, written: `${MOD}-click to open` };
const hint = (title: string | null | undefined, how: string) => (title === null ? "This note doesn't exist, or you can't see it." : title === undefined ? "" : `${title || "Untitled"}\n${how}`);

const isLink = (state: EditorState, link: WrittenLink) => state.field(noteLinks).has(link.from);

/** How far before a link's end its display text is typed: before the closing brackets. */
const BEFORE_END = 2;

const modClick = (event: MouseEvent) => event.button === 0 && (event.metaKey || event.ctrlKey);

/** A way to open a link's note: where the member is, or in a tab behind what they are reading. */
export type Open = (noteId: string, how?: { background: boolean }) => void;

/**
 * Draws a link as the words it shows: its display text, or its note's title as it is now. It is
 * shown as written only while the cursor is inside it, since what is written is an id.
 */
function linkChip(titleOf: TitleOf, open: Open): Chip<WrittenLink> {
  return {
    id: "link",
    find: noteLinksOn,
    written: "within",
    inCode: true,
    skip: (state, link) => !isLink(state, link),
    // A title not known yet and a note that isn't there are told apart, which JSON would write alike: the first becomes the second when the notes are listed.
    key: (link) => {
      const title = titleOf(link.target);
      return title === undefined ? "waiting" : JSON.stringify([title]);
    },
    draw(el, link, source) {
      const title = titleOf(link.target);
      el.textContent = link.display ?? (title === null ? UNAVAILABLE : title === undefined ? "…" : title || "Untitled");
      el.title = hint(title, HOW.drawn);
      el.setAttribute("role", "link");
      if (title === null) el.classList.add("md-notelink-gone");
      // A click follows the link. One to a note that isn't there has nowhere to go, so the click is for mending it.
      el.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (title !== null) open(link.target, { background: modClick(event) });
        else if (!modClick(event)) source.edit(link.to - link.from - BEFORE_END);
      });
    },
  };
}

/** A link shown as written still reads as one, says which note it is, and opens on a ⌘-click, where a plain click is for the cursor. */
const asWritten = (titleOf: TitleOf) =>
  drawnInView((view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.head);
      for (const link of noteLinksOn(line.text, line.from)) {
        if (!within(state, link.from, link.to) || !isLink(state, link)) continue;
        const title = titleOf(link.target);
        drawn.push(Decoration.mark({ class: title === null ? "md-notelink md-notelink-gone" : "md-notelink", attributes: { title: hint(title, HOW.written), ...(title === null ? {} : { "data-note": link.target }) } }).range(link.from, link.to));
      }
    }
    return drawn;
  });

const look = EditorView.baseTheme({
  // Words in the line and nothing more, so a line is as tall with a link drawn as with it written.
  ".md-chip-link, .md-notelink": { color: "var(--accent)", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" },
  ".md-chip-link": { cursor: "pointer" },
  ".md-notelink-gone": { color: "var(--faint)", textDecorationLine: "line-through", textDecorationStyle: "solid" },
});

/** The editor extension that draws links, a way to put the cursor inside the link it is at, and whether it is at one. */
export function linkDrawing(titleOf: TitleOf, open: Open): { extension: Extension; edit: (view: EditorView) => void; canEdit: (view: EditorView) => boolean } {
  const following = EditorView.domEventHandlers({
    mousedown(event) {
      const noteId = modClick(event) && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-note]")?.dataset.note : undefined;
      if (!noteId) return false;
      open(noteId);
      event.preventDefault();
      return true;
    },
  });
  const chip = linkChip(titleOf, open);
  return { extension: [noteLinks, chips(chip), asWritten(titleOf), following, look], edit: (view) => editWithin(chip, view, BEFORE_END), canEdit: (view) => !!unitAtCursor(chip, view.state) };
}
