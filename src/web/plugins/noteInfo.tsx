import { useRef, useState } from "react";
import { ago, tagsIn, useNow, type NoteSummary, type Plugin, type PluginHost, type ViewProps } from "../plugin-api.ts";
import { lifecycle } from "./lib/lifecycle.ts";
import { openNotes, type OpenNotes } from "./lib/openNotes.ts";
import { tagPath } from "./tags/path.ts";
import { SharingSummary } from "./sharing/Summary.tsx";

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

function Info({ host, open, app, note }: ViewProps & { host: PluginHost; open: OpenNotes; note: NoteSummary }) {
  // The tags the note's text has now, as it is typed, read the way the server reads them.
  const tags = tagsIn(open.useText(note.id) ?? "");
  const tree = app.folders;
  const url = `${location.origin}${app.notePath(note.id)}`;
  const urlField = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!tree) return null;
  const { setArchived, trash, restore } = lifecycle(host);
  const locked = note.access !== "edit";
  const inTrash = note.state === "trashed";
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
        {note.folderId !== null && (
          <select
            aria-label="Move to"
            value={note.folderId}
            disabled={locked || inTrash}
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
        )}
        {error && <span role="alert" className="error">{error}</span>}
      </dd>
      <dt>Sharing</dt>
      <dd>
        <SharingSummary host={host} app={app} note={note} />
      </dd>
      <dt>Tags</dt>
      <dd>
        {tags.length ? (
          <ul className="info-tags" aria-label="Tags">
            {tags.map((name) => (
              <li key={name}>
                <a
                  href={tagPath(name)}
                  data-tag={name}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    app.go(tagPath(name));
                  }}
                >
                  #{name}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="soon">No tags. Write #tag in the note to tag it.</p>
        )}
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
        <button type="button" className="button small" disabled={locked || inTrash} onClick={() => void setArchived([note.id], note.state !== "archived")}>
          {note.state === "archived" ? "Unarchive" : "Archive"}
        </button>
        <p className="soon">{note.state === "archived" ? "Archived: left out of listings unless they include archived notes." : "An archived note keeps its folder and links, and is left out of listings."}</p>
      </dd>
      <dt>Trash</dt>
      <dd>
        <button type="button" className="button small" disabled={locked} onClick={() => void (inTrash ? restore([note.id]) : trash([note.id]))}>
          {inTrash ? "Restore" : "Move to Trash"}
        </button>
        <p className="soon">{inTrash ? "In Trash: read, and not changed, until it is restored." : "A note in Trash can be restored for 30 days."}</p>
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
    const open = openNotes(host);
    host.views.register("inspector", {
      id: "info",
      label: "Info",
      icon: "info",
      for: ["note", "folder", "notes"],
      component: ({ app, about }) =>
        about.kind === "note" ? <Info key={about.note.id} host={host} open={open} app={app} note={about.note} /> : <NotesInfo heading={about.kind === "folder" ? "Folder" : "Showing"} name={about.kind === "folder" ? about.name : about.label} notes={about.notes} />,
    });
  },
};
