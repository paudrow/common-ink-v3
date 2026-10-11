import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { WrittenLink } from "../../plugin-api.ts";
import { chips, editWithin, unitAtCursor, type Chip } from "../lib/chips.ts";
import { drawnInView, within } from "../lib/live.ts";
import { MOD } from "../lib/opening.ts";
import { noteLinks, noteLinksOn } from "./at.ts";
import { linkWords, type Linked } from "./words.ts";

export type NoteOf = (noteId: string) => Linked;

const isLink = (state: EditorState, link: WrittenLink) => state.field(noteLinks).has(link.from);

/** How far before a link's end its display text is typed: before the closing brackets. */
const BEFORE_END = 2;

const modClick = (event: MouseEvent) => event.button === 0 && (event.metaKey || event.ctrlKey);

/**
 * Draws a link as the words it shows: its display text, or its note's title as it is now. It is
 * shown as written only while the cursor is inside it, since what is written is an id.
 */
function linkChip(noteOf: NoteOf, open: (noteId: string) => void): Chip<WrittenLink> {
  return {
    id: "link",
    find: noteLinksOn,
    written: "within",
    inCode: true,
    skip: (state, link) => !isLink(state, link),
    key: (link) => {
      const linked = noteOf(link.target);
      return JSON.stringify(linked && [linked.title, linked.state]) ?? "";
    },
    draw(el, link, source) {
      const { text, suffix, hint, gone } = linkWords(noteOf(link.target), link.display, MOD);
      el.textContent = text;
      // Words of the line's own size, so the line is as tall with them as without.
      if (suffix) el.appendChild(document.createElement("span")).append(suffix);
      el.title = hint;
      el.setAttribute("role", "link");
      if (gone) el.classList.add("md-notelink-gone");
      if (suffix) el.classList.add("md-notelink-trashed");
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        if (!modClick(event)) source.edit(link.to - link.from - BEFORE_END);
        else if (!gone) open(link.target);
      });
    },
  };
}

/** A link shown as written still reads as one, says which note it is, and opens on a ⌘-click. */
const asWritten = (noteOf: NoteOf) =>
  drawnInView((view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.head);
      for (const link of noteLinksOn(line.text, line.from)) {
        if (!within(state, link.from, link.to) || !isLink(state, link)) continue;
        const { hint, gone } = linkWords(noteOf(link.target), link.display, MOD);
        drawn.push(Decoration.mark({ class: gone ? "md-notelink md-notelink-gone" : "md-notelink", attributes: { title: hint, ...(gone ? {} : { "data-note": link.target }) } }).range(link.from, link.to));
      }
    }
    return drawn;
  });

const look = EditorView.baseTheme({
  // Words in the line and nothing more, so a line is as tall with a link drawn as with it written.
  ".md-chip-link, .md-notelink": { color: "var(--accent)", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" },
  ".md-chip-link": { cursor: "pointer" },
  ".md-notelink-gone": { color: "var(--faint)", textDecorationLine: "line-through", textDecorationStyle: "solid" },
  ".md-notelink-trashed": { color: "var(--muted)" },
  ".md-notelink-trashed > span": { color: "var(--faint)" },
});

/** The editor extension that draws links, a way to put the cursor inside the link it is at, and whether it is at one. */
export function linkDrawing(noteOf: NoteOf, open: (noteId: string) => void): { extension: Extension; edit: (view: EditorView) => void; canEdit: (view: EditorView) => boolean } {
  const following = EditorView.domEventHandlers({
    mousedown(event) {
      const noteId = modClick(event) && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-note]")?.dataset.note : undefined;
      if (!noteId) return false;
      open(noteId);
      event.preventDefault();
      return true;
    },
  });
  const chip = linkChip(noteOf, open);
  return { extension: [noteLinks, chips(chip), asWritten(noteOf), following, look], edit: (view) => editWithin(chip, view, BEFORE_END), canEdit: (view) => !!unitAtCursor(chip, view.state) };
}
