import { useRef, useState } from "react";
import { ago, useNow, type NoteSummary, type Plugin, type ViewProps } from "../plugin-api.ts";
import { Soon } from "./lib/Soon.tsx";

/** A set of notes: a folder's, under "Folder", or the ones a page is showing, under "Showing". */
function NotesInfo({ heading, name, notes }: { heading: string; name: string; notes: readonly NoteSummary[] }) {
  const now = useNow();
  const last = notes.reduce<NoteSummary | null>((latest, n) => (latest && latest.updatedAt >= n.updatedAt ? latest : n), null);
  return (
    <dl className="info">
      <dt>{heading}</dt>
      <dd>{name}</dd>
      <dt>Notes</dt>
      <dd>{notes.length === 1 ? "1 note" : `${notes.length} notes`}</dd>
      <dt>Last changed</dt>
      <dd>{last ? `${ago(last.updatedAt, now)} by ${last.updatedBy.name}` : "Nothing in it yet"}</dd>
    </dl>
  );
}

function Info({ app, note }: ViewProps & { note: NoteSummary }) {
  const tree = app.folders;
  const url = `${location.origin}${app.notePath(note.id)}`;
  const urlField = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!tree) return null;
  const targets = [...tree.byId.keys()].map((id) => ({ id, name: tree.pathName(id) })).sort((a, b) => a.name.localeCompare(b.name));

  const move = (folderId: string) => app.moveNote(note.id, folderId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // A preview served over plain http has no Clipboard API.
      urlField.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <dl className="info">
      <dt>Folder</dt>
      <dd>
        <span>{tree.pathName(note.folderId)}</span>
        <select
          aria-label="Move to"
          value={note.folderId}
          disabled={!app.canEdit}
          onChange={(e) => {
            setError(null);
            move(e.target.value).catch((err: Error) => setError(err.message));
          }}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {error && <span role="alert" className="error">{error}</span>}
      </dd>
      <dt>Sharing</dt>
      <dd>
        <span>Everyone in this workspace</span>
        <Soon issue={15}>Sharing with people and links arrives with</Soon>
      </dd>
      <dt>Tags</dt>
      <dd>
        <Soon issue={21}>Tags arrive with</Soon>
      </dd>
      <dt>URL</dt>
      <dd className="url">
        <input ref={urlField} readOnly aria-label="Note URL" value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="button small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
      <dt>Archive</dt>
      <dd>
        <button type="button" className="button small" disabled>
          Archive
        </button>
        <Soon issue={21}>Archiving arrives with</Soon>
      </dd>
    </dl>
  );
}

export const noteInfo: Plugin = {
  id: "note-info",
  name: "Note info",
  description: "The details of the note, the folder or the notes in front, in the inspector.",
  icon: "info",
  activate(host) {
    host.views.register("inspector", {
      id: "info",
      label: "Info",
      icon: "info",
      for: ["note", "folder", "notes"],
      component: ({ app, about }) =>
        about.kind === "note" ? <Info key={about.note.id} app={app} note={about.note} /> : <NotesInfo heading={about.kind === "folder" ? "Folder" : "Showing"} name={about.kind === "folder" ? about.name : about.label} notes={about.notes} />,
    });
  },
};
