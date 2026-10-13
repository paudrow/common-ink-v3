import { EditorState, Facet, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * What a note's editor is given when the member can't change the note. The text can't be typed in,
 * and no change is let through from anything else either: keys, vim, a plugin's extension, an embed.
 * A change from the server is dispatched with `filter: false`, which is the one way past.
 */
export const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.changeFilter.of(() => false)];

const read = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/**
 * What a reading of a note is given: an expanded card, which is the note drawn to be read and is not
 * an editor. Besides changing nothing, it shows no line as written: a selection in it is for copying
 * what is read, so everything stays drawn wherever it is.
 */
export const reading: Extension = [readOnly, read.of(true)];

/** Whether the state is a reading's, where nothing is shown as written. */
export const isReading = (state: EditorState) => state.facet(read);
