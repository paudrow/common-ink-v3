import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, Facet, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { embedContent } from "./embedContent.ts";
import { noteHighlighting } from "./highlight.ts";
import { spaceRuns } from "./plugins/lib/markdownSpaces.ts";
import type { EditorExtension } from "./plugin-api.ts";
import { reading } from "./readOnly.ts";

/**
 * The editor extensions that draw what a line of a note says, and not how the note is worked: a
 * list's marks and a todo's box and chips, emphasis, links by their names, mentions, tags, dates and
 * formulas. Gutters, vim, folding and dragging are the note's, and not a line's drawn elsewhere.
 */
const DRAWS_A_LINE = new Set(["gfm.lists", "gfm.marks", "links", "mentions", "tags", "dates", "todos", "references.events", "math"]);

/** Of a note's editor extensions, those a line of it is drawn with elsewhere, such as in a board's card. */
export const lineExtensions = (added: readonly EditorExtension[]) => added.filter((one) => DRAWS_A_LINE.has(one.id));

/** What an editor's embeds draw lines of its note with: the extensions {@link lineExtensions} picked, made for a reading of the note. */
export const drawsLines = Facet.define<Extension, readonly Extension[]>();

const LIST_MARK = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** The first line's list mark and the space after it, which aren't drawn: the lines stand on their own, as a card does. Lists under it are lists. */
const unmarked = StateField.define<DecorationSet>({
  create: (state) => marksOf(state),
  update: (marks, tr) => (tr.docChanged ? marksOf(tr.state) : marks),
  provide: (field) => EditorView.decorations.from(field),
});

function marksOf(state: EditorState): DecorationSet {
  const mark = LIST_MARK.exec(state.doc.line(1).text);
  return mark ? Decoration.set(Decoration.replace({}).range(0, mark[0].length)) : Decoration.none;
}

/** Whether a press is on something a line's drawing put there, and not on its words. */
function onDrawing(event: MouseEvent, view: EditorView): boolean {
  const drawing = (event.target as Element).closest("[contenteditable=false], button, input, a");
  return !!drawing && drawing !== view.contentDOM && view.contentDOM.contains(drawing);
}

/**
 * Draws `text`, lines of the note `within` holds, into `el` as the note draws them, in an editor of
 * their own: a todo's box ticks, a chip opens its menu, and each change it makes is handed to
 * `changed` as the lines are then. Nothing is typed there, and the keys pass it by: a press on the words
 * is handed to `pressed`, as the lines are changed where the note writes them.
 * A list item's mark isn't drawn. Without the extensions, as on a page that draws no note, the lines are their text.
 */
export function drawLines(within: EditorState, el: HTMLElement, text: string, { readOnly, changed, pressed }: { readOnly: boolean; changed: (text: string) => void; pressed: () => void }): () => void {
  const drawn = within.facet(drawsLines);
  if (!drawn.length) {
    el.append(text.replace(LIST_MARK, ""));
    el.style.whiteSpace = "pre-line";
    return () => {};
  }
  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: text,
      extensions: [
        drawn,
        markdown({ base: markdownLanguage, extensions: [spaceRuns, embedContent], addKeymap: false }),
        noteHighlighting,
        unmarked,
        readOnly ? reading : [],
        EditorView.lineWrapping,
        // Not typed in, and out of the order the keys go through the page in: what is drawn here is pressed, and the words are changed in the note.
        // The editor is still one that may be changed, which is what lets a todo's box and a chip change the lines.
        EditorView.contentAttributes.of({ contenteditable: "false", tabindex: "-1", "aria-readonly": "true" }),
        EditorView.domEventHandlers({
          // A press on the words is the note's, once it is let go, as what it does moves what is under the pointer.
          click: (event, view) => !onDrawing(event, view) && (pressed(), true),
          // Nothing is dropped into the lines: a drop is what holds them, as a card moved on its board.
          dragover: () => true,
          drop: () => true,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed(update.state.doc.toString());
        }),
      ],
    }),
  });
  // What a line's drawing takes a press on, such as a todo's box or a chip, has it. The words are kept from the editor, which would take a press
  // on them for its cursor and stop it being a drag, so what holds them, as a card, may be dragged from them.
  const kept = (event: MouseEvent) => !onDrawing(event, view) && event.stopPropagation();
  el.addEventListener("mousedown", kept, true);
  return () => {
    el.removeEventListener("mousedown", kept, true);
    view.destroy();
  };
}
