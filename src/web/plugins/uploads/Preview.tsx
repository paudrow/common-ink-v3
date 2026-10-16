import { useEffect, useRef, useState } from "react";
import { Icon, useDismiss, type PluginHost, type Upload, type ViewProps } from "../../plugin-api.ts";
import { download, filePath, openingOf, type Openable } from "./opening.ts";
import type { Place } from "./previewing.ts";
import { drawPreview } from "./previews.ts";

/** A preview of a file, as a note draws one below its line: the same drawing, in a React view. `onSaid` is told what it says of the file beside it. */
export function FilePreview({ host, upload, place, onSaid }: { host: PluginHost; upload: Pick<Upload, "id" | "name" | "type" | "size">; place: Place; onSaid?: (words: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const said = useRef(onSaid);
  said.current = onSaid;
  const { id, name, type, size } = upload;
  useEffect(() => drawPreview(ref.current!, host, { id, name, type, size }, place, { said: (words) => said.current?.(words) }), [host, id, name, type, size, place]);
  return <div ref={ref} className={`upload-preview-body upload-preview-${place}`} />;
}

/**
 * A file shown larger over the app: what `openUpload` opens a picture, a video, a recording or a PDF
 * in, and what pressing any preview opens. Nothing plays until the member asks. It offers Download,
 * text's own page in the app, and a PDF in a tab where there is a site kept for files. Escape or a
 * press outside closes it, and the keyboard goes back to where it was.
 */
export function Preview({ host, close, state }: ViewProps & { host: PluginHost; close: () => void; state: unknown }) {
  const { id, name, type } = state as Openable;
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  useDismiss(close, ref);
  // Taken once whatever it opened over has given the keyboard back, as the command palette does when it closes.
  useEffect(() => {
    const was = document.activeElement;
    closing.current?.focus();
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus();
    };
  }, []);
  // How long the file is, which says how much of it a preview reads: what the note was told, or else what the server says.
  useEffect(() => {
    const told = host.uploads.referred(id);
    if (told) return void setSize(told.size);
    let live = true;
    host.perform({ type: "upload.read", id }).then(
      (upload) => live && setSize(upload.size),
      () => live && setSize(0),
    );
    return () => {
      live = false;
    };
  }, [host, id]);
  const tab = openingOf({ name, type }) === "preview" && type === "application/pdf" ? host.uploads.tabAddress(id) : null;
  return (
    <div className="upload-preview-back">
      <div ref={ref} className="upload-preview" role="dialog" aria-label={`Preview of ${name}`}>
        <header className="upload-detail-head">
          <h2>
            {name}
            {said && <span className="upload-preview-said"> {said}</span>}
          </h2>
          <div className="upload-preview-actions">
            {openingOf({ name, type }) === "app" && (
              <button type="button" className="button small" onClick={() => (close(), host.app().go(filePath(id)))}>
                Open
              </button>
            )}
            {tab && (
              <a className="button small" href={tab} target="_blank" rel="noopener noreferrer">
                Open in a tab
              </a>
            )}
            <button type="button" className="button small" onClick={() => download(host.uploads.address(id), name)}>
              Download
            </button>
            <button ref={closing} type="button" className="icon-button" aria-label="Close preview" title="Close" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        {size !== null && <FilePreview host={host} upload={{ id, name, type, size }} place="overlay" onSaid={setSaid} />}
      </div>
    </div>
  );
}
