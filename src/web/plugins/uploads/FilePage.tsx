import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginHost, Upload, ViewProps } from "../../plugin-api.ts";
import { tokenColors } from "../code/colors.ts";
import { withSpaceRuns } from "../lib/markdownSpaces.ts";
import { shownTable, tableOf } from "./delimited.ts";
import { UNAVAILABLE } from "./drawing.ts";
import { fileIn } from "./opening.ts";
import { asNote, formatOf, SHOWN_BYTES, SHOWN_CELLS, SHOWN_COLUMNS, SHOWN_ROWS, textOf, type ReadText } from "./reading.ts";
import { formatBytes } from "./sizing.ts";

type Shown = { kind: "reading" } | { kind: "unavailable" } | { kind: "read"; upload: Upload; read: ReadText };

/**
 * A file read in the app, at `/file/<id>`: text drawn to be read and not changed. Its bytes are read
 * as the member's session reads a picture's, and only ever handed to the page as text: markdown is
 * drawn as a link's page draws a note, a CSV or TSV is a table, anything else is code. A file that
 * isn't there and one the member can't see are the same words, with nothing of the file.
 */
export function FilePage({ host, app }: ViewProps & { host: PluginHost }) {
  const id = fileIn(app.path);
  const [shown, setShown] = useState<Shown>({ kind: "reading" });

  useEffect(() => {
    let live = true;
    setShown({ kind: "reading" });
    if (!id) return void setShown({ kind: "unavailable" });
    host
      .perform({ type: "upload.read", id })
      .then(async (upload) => ({ upload, bytes: await host.uploads.bytes(id, SHOWN_BYTES) }))
      .then(
        ({ upload, bytes }) => live && setShown({ kind: "read", upload, read: textOf(bytes, upload.size) }),
        () => live && setShown({ kind: "unavailable" }),
      );
    return () => {
      live = false;
    };
  }, [host, id]);

  if (shown.kind === "reading") return <section className="file-page" aria-label="File" aria-busy />;
  if (shown.kind === "unavailable") {
    return (
      <section className="file-page" aria-label="File">
        <p className="file-none">{UNAVAILABLE}</p>
      </section>
    );
  }
  const { upload, read } = shown;
  const copied = read.kind === "text" && !read.cut && app.canCreateNote ? asNote(upload.name, read.text) : null;
  const copy = async () => {
    try {
      const note = await host.perform({ type: "note.create", text: copied! });
      app.openNote(note.id, { focus: true });
    } catch (err) {
      app.notify({ message: err instanceof Error ? err.message : "The note couldn't be made." });
    }
  };

  return (
    <section className="file-page" aria-label={upload.name}>
      <header className="file-head">
        <div className="file-title">
          <h1>{upload.name}</h1>
          <p className="upload-meta">
            <span>Uploaded by {upload.uploadedBy.name}</span>
            <span>{formatBytes(upload.size)}</span>
          </p>
        </div>
        <div className="file-actions">
          {copied !== null && (
            <button type="button" className="button small" onClick={() => void copy()}>
              Copy into a new note
            </button>
          )}
          <a className="button small" href={host.uploads.address(upload.id)} download={upload.name}>
            Download
          </a>
        </div>
      </header>
      {read.kind === "binary" ? (
        <p className="file-none">This file isn't text, so it can't be shown here. Download it to open it on your computer.</p>
      ) : (
        <>
          <p className="file-said">
            Read only: a file you upload isn't changed here.
            {read.cut && ` This is its first ${formatBytes(SHOWN_BYTES)} of ${formatBytes(upload.size)}.`}
          </p>
          <FileText app={app} name={upload.name} text={read.text} />
        </>
      )}
    </section>
  );
}

function FileText({ app, name, text }: ViewProps & { name: string; text: string }) {
  const shape = formatOf(name);
  if (shape.format === "markdown") return <div className="file-markdown">{app.readMarkdown(text)}</div>;
  if (shape.format === "table") return <FileTable text={text} separator={shape.separator} />;
  return <FileCode name={name} text={text} />;
}

function FileTable({ text, separator }: { text: string; separator: "," | "\t" }) {
  const { rows, columnsCut, rowsCut } = useMemo(() => shownTable(tableOf(text, separator, SHOWN_ROWS + 1), { columns: SHOWN_COLUMNS, cells: SHOWN_CELLS }), [text, separator]);
  const [head, ...body] = rows;
  const cut = [rowsCut && `the first ${(rows.length - 1).toLocaleString()} rows`, columnsCut && `the first ${SHOWN_COLUMNS} columns`].filter(Boolean);
  return (
    <>
      <div className="file-table-scroll">
        <table className="file-table">
          {head && (
            <thead>
              <tr>
                {head.map((cell, i) => (
                  <th key={i} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cut.length > 0 && <p className="file-said">Showing {cut.join(" and ")}.</p>}
    </>
  );
}

/** Code and plain text, read only, coloured once its language has loaded where the file's name says one. */
function FileCode({ name, text }: { name: string; text: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: el.current,
      state: EditorState.create({
        doc: text,
        extensions: [EditorState.readOnly.of(true), lineNumbers(), language.of([]), syntaxHighlighting(classHighlighter), tokenColors, EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "File text", "aria-readonly": "true" })],
      }),
    });
    let live = true;
    // The list of languages is loaded only once a file of code is read, as a note's code block loads it.
    import("@codemirror/language-data")
      .then(({ languages }) => LanguageDescription.matchFilename(withSpaceRuns(languages), name)?.load())
      .then(
        (support) => live && support && view.dispatch({ effects: language.reconfigure(support) }),
        () => {},
      );
    return () => {
      live = false;
      view.destroy();
    };
  }, [name, text]);
  return <div className="file-code" ref={el} />;
}
