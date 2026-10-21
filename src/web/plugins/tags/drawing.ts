import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isReading, linesOutsideCode, tagsOn } from "../../plugin-api.ts";
import type { TagCards } from "./card.tsx";

/**
 * Every tag in the note, marked, read from the whole text by the functions the server indexes tags
 * with. So what is drawn as a tag is what tags the note: `#12`, a `#` in a fence or in inline code,
 * and one in a link's address are not.
 */
function tagsOf(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const marks = new RangeSetBuilder<Decoration>();
  if (text.includes("#")) {
    for (const { line, from } of linesOutsideCode(text)) {
      for (const tag of tagsOn(line, from)) marks.add(tag.from, tag.to, Decoration.mark({ class: "md-tag", attributes: { "data-tag": tag.name } }));
    }
  }
  return marks.finish();
}

/**
 * The mark is the same whether or not the cursor is on its line, and changes only the color of the
 * characters it is on, so no glyph is anywhere else for it: there is nothing to show as written.
 */
const marked = StateField.define<DecorationSet>({
  create: tagsOf,
  update: (tags, tr) => (tr.docChanged ? tagsOf(tr.state) : tags),
  provide: (field) => EditorView.decorations.from(field),
});

const look = EditorView.baseTheme({ ".md-tag": { color: "var(--accent)" } });

/** The tag the cursor is inside, past its `#`, or null. */
function tagAtCursor(state: EditorState): { from: number; name: string } | null {
  const { main } = state.selection;
  if (!main.empty) return null;
  let found: { from: number; name: string } | null = null;
  state.field(marked).between(main.head, main.head, (from, to, mark) => {
    if (from < main.head && main.head <= to) found = { from, name: (mark.spec.attributes as Record<string, string>)["data-tag"]! };
  });
  return found;
}

/**
 * Shows a tag's card while the cursor rests in it, the keyboard's way to the card a pointer gets by
 * resting on the tag. Typing a tag shows nothing: it is a word being written, not one being read.
 */
const cardAtCursor = (cards: TagCards) =>
  ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.selectionSet && !update.focusChanged && !update.docChanged) return;
        const at = update.view.hasFocus && !update.docChanged ? tagAtCursor(update.state) : null;
        if (!at) return cards.hide("cursor");
        update.view.requestMeasure({
          key: cards,
          read: (view) => {
            // Read again when it is measured: the cursor may have moved on since.
            const now = view.hasFocus ? tagAtCursor(view.state) : null;
            const { node } = now ? view.domAtPos(now.from + 1) : { node: null };
            const anchor = node && (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-tag]");
            return now && anchor ? { anchor, name: now.name } : null;
          },
          write: (found) => (found ? cards.show(found.anchor, found.name, "cursor") : cards.hide("cursor")),
        });
      }
      destroy() {
        cards.hide("cursor");
      }
    },
  );

/**
 * Draws a note's tags as tags. ⌘-click, or Ctrl-click, on one calls `open` with its name, as it does
 * for a link, and a plain click puts the cursor in it. In a reading, as a card in a folder's list is,
 * there is no cursor to put, and a plain click opens it. `cards` shows a tag's card.
 */
export const tagDrawing = (open: (name: string) => void, cards: TagCards): Extension => [
  marked,
  look,
  cardAtCursor(cards),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.target instanceof Element) || !view.contentDOM.contains(event.target)) return false;
      const name = event.metaKey || event.ctrlKey || isReading(view.state) ? event.target.closest<HTMLElement>("[data-tag]")?.dataset.tag : undefined;
      if (!name) return false;
      open(name);
      event.preventDefault();
      return true;
    },
  }),
];
