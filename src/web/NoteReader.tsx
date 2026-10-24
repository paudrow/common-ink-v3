import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { fontLoaded } from "./noteFont.ts";
import type { Results } from "../core/protocol.ts";
import { perform } from "./api.ts";
import { forEditor } from "./editorExtensions.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import type { EditorExtension, AddressEmbed, Embed } from "./plugin-api.ts";
import { embedContent } from "./embedContent.ts";
import { spaceRuns } from "./plugins/lib/markdownSpaces.ts";
import { reading } from "./readOnly.ts";
import { committed } from "./sync.ts";

interface Props {
  workspaceId: string;
  noteId: string;
  /** The note's latest revision as the workspace knows it. A later one than was read is read in. */
  revision: number | undefined;
  embeds: readonly (Embed | AddressEmbed)[];
  extensions: readonly EditorExtension[];
  /** Called with each reading, which says what the note's uploads are before they are drawn. */
  onRead: (note: Results["note.read"]) => void;
}

/**
 * A note's text drawn as its editor draws it, to be read and not changed: nothing typed, clicked or
 * pressed in it changes the note. It is not an editor: it has no cursor, no line of it is shown as
 * written, and what is only for editing, such as vim, is left out of it. Its text is selected and
 * copied as a page's is. It is as tall as its text and scrolls with whatever it is in.
 */
export function NoteReader({ workspaceId, noteId, revision, embeds, extensions: contributed, onRead }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [embedded] = useState(() => new Compartment());
  const [added] = useState(() => new Compartment());
  const mine = useMemo(() => forEditor({ noteId, reading: true }), [noteId]);
  const extensions = useMemo(() => mine(contributed).extensions, [mine, contributed]);
  const now = useRef({ embeds, extensions, onRead });
  now.current = { embeds, extensions, onRead };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    // Typing still on its way from an editor of the same note is read once it has arrived.
    Promise.all([committed(noteId).then(() => perform(workspaceId, { type: "note.read", id: noteId })), fontLoaded()])
      .then(([note]) => note)
      .then(
        (note) => {
          if (!live || !el.current) return;
          setFailed(false);
          now.current.onRead(note);
          const { text } = note;
          const view = viewRef.current;
          if (view) {
            if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, filter: false });
            return;
          }
          viewRef.current = new EditorView({
            parent: el.current,
            state: EditorState.create({
              doc: text,
              extensions: [
                reading,
                added.of(now.current.extensions),
                markdown({ base: markdownLanguage, extensions: [spaceRuns, embedContent] }),
                noteHighlighting,
                embedding(noteId),
                embedded.of(embedsAre(now.current.embeds)),
                EditorView.lineWrapping,
                EditorView.contentAttributes.of({ "aria-label": "Read-only note", "aria-readonly": "true" }),
              ],
            }),
          });
        },
        () => live && setFailed(true),
      );
    return () => {
      live = false;
    };
  }, [workspaceId, noteId, revision, embedded, added]);

  useEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  useEffect(() => {
    viewRef.current?.dispatch({ effects: added.reconfigure(extensions) });
  }, [extensions, added]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: embedded.reconfigure(embedsAre(embeds)) });
  }, [embeds, embedded]);

  return (
    <>
      {failed && <p className="notice">This note can't be read.</p>}
      <div className="editor reading" ref={el} hidden={failed} />
    </>
  );
}
