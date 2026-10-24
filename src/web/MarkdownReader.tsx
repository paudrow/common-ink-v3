import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import { useDrawing } from "./drawingHost.ts";
import { forEditor } from "./editorExtensions.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import { embedContent } from "./embedContent.ts";
import { spaceRuns } from "./plugins/lib/markdownSpaces.ts";
import { reading } from "./readOnly.ts";

const NOWHERE = () => "about:blank";
const STAYS = () => {};

/**
 * Markdown that is not a note, drawn to be read as a link's page draws a note: the same embeds, none
 * of which can reach the workspace. Links to notes and uploads in it are drawn as ones the reader
 * can't open, and HTML in it runs only when Run is pressed.
 */
export function MarkdownReader({ text }: { text: string }) {
  const el = useRef<HTMLDivElement>(null);
  const { embeds, extensions } = useDrawing(NOWHERE, STAYS);
  const mine = useMemo(() => forEditor({ noteId: "", reading: true }), []);
  const added = useMemo(() => mine(extensions).extensions, [mine, extensions]);

  useEffect(() => {
    if (!el.current) return;
    const view = new EditorView({
      parent: el.current,
      state: EditorState.create({
        doc: text,
        extensions: [reading, added, markdown({ base: markdownLanguage, extensions: [spaceRuns, embedContent] }), noteHighlighting, embedding(""), embedsAre(embeds), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "File text", "aria-readonly": "true" })],
      }),
    });
    return () => view.destroy();
  }, [text, added, embeds]);

  return <div className="editor reading" ref={el} />;
}
