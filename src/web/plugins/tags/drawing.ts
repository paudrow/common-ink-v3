import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { linesOutsideCode, tagsOn } from "../../plugin-api.ts";

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

/** Draws a note's tags as tags. ⌘-click, or Ctrl-click, on one calls `open` with its name, as it does for a link. A plain click puts the cursor in it. */
export const tagDrawing = (open: (name: string) => void): Extension => [
  marked,
  look,
  EditorView.domEventHandlers({
    mousedown(event) {
      const name = (event.metaKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tag]")?.dataset.tag : undefined;
      if (!name) return false;
      open(name);
      event.preventDefault();
      return true;
    },
  }),
];
