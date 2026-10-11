import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * What a note's editor is given when the member can't change the note. The text can't be typed in,
 * and no change is let through from anything else either: keys, vim, a plugin's extension, an embed.
 * A change from the server is dispatched with `filter: false`, which is the one way past.
 */
export const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.changeFilter.of(() => false)];
