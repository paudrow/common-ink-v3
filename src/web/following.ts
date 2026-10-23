import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * What vim's `gd` follows at the cursor besides a link: each does what a click on its own kind of
 * thing does, if the cursor is on one, and answers whether it did. A link is followed where none did.
 */
export const following = Facet.define<(view: EditorView) => boolean>();
