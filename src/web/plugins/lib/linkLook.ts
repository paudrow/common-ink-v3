import { EditorView } from "@codemirror/view";

/**
 * A link shown as written, with the cursor in it: all of it, both brackets at each end and what is
 * between them, in its kind's colour. The editor's own reading of `[…]` inside it as markdown colours
 * nothing of it.
 */
export const WRITTEN_LINK = "md-link-written";

/**
 * How every kind of link looks, a note's, a day's, a folder's, an event's and a person's alike. Drawn,
 * it has no underline at rest. Its colour alone is too close to the text's in the dark theme and in
 * Night shift to tell it apart, so it is underlined under the pointer and when the keyboard is on it.
 */
export const linkLook = EditorView.baseTheme({
  [`.${WRITTEN_LINK} *`]: { color: "inherit" },
  ".md-chip-link:hover, .md-chip-mention:hover, .md-chip-date:hover, .md-chip-event:hover, .md-chip-event:focus-visible": { textDecoration: "underline", textUnderlineOffset: "2px" },
});
