import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const noteHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontSize: "1.6em", fontWeight: "700" },
    { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700" },
    { tag: tags.heading3, fontSize: "1.15em", fontWeight: "700" },
    { tag: tags.heading, fontWeight: "700" },
    { tag: tags.processingInstruction, color: "var(--muted)" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: "var(--accent)" },
    { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.92em" },
    { tag: tags.quote, color: "var(--muted)" },
  ]),
);
