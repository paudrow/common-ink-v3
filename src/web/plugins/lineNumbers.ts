import { EditorView, lineNumbers as numbered } from "@codemirror/view";
import type { Plugin } from "../plugin-api.ts";

// The numbers stand in a column of one width left of the text and of what hangs in its margin, so the text is moved by that
// width when they are shown and by nothing else: not as a note grows from 9 lines to 10, nor from 99 to 100.
const look = EditorView.theme({
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--faint)", fontFamily: "var(--mono)", fontSize: "0.75em" },
  ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", width: "3rem", minWidth: "3rem", padding: "0 0.5rem 0 0", textAlign: "right" },
});

/** Each line's number beside it, in every note's editor. A line that wraps is numbered once, on its first row. A reading of a note has none. */
export const lineNumbers: Plugin = {
  id: "lineNumbers",
  name: "Line numbers",
  enabledByDefault: false,
  activate(host) {
    host.editorExtensions.register({ id: "lineNumbers", extension: (editor) => (editor.reading ? [] : [numbered(), look]) });
  },
};
