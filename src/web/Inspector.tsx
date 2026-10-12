import { useId, useRef, useState, type ReactNode } from "react";
import type { Note, NoteSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { pathName, type FolderTree } from "./folders.ts";
import { FolderHistory, NoteHistory } from "./History.tsx";
import type { IconName } from "./icons.tsx";
import { pickView } from "./inspectorPick.ts";
import { Soon } from "./Soon.tsx";
import { ago, useNow } from "./time.ts";

/** What the inspector is about: the thing in front. A page is anything that is neither a note nor a folder's list. */
export type Subject =
  | {
      kind: "note";
      workspaceId: string;
      note: NoteSummary;
      tree: FolderTree;
      canEdit: boolean;
      onMove: (noteId: string, folderId: string) => Promise<void>;
      /** Whether the note has changes by someone else that the member hasn't been shown. */
      unseen: boolean;
      onSeen: (noteId: string, revision: number) => void;
      /** The note after History reverted it or applied a selection of its changes. */
      onChanged: (note: Note) => void;
    }
  | {
      kind: "folder";
      workspaceId: string;
      name: string;
      notes: readonly NoteSummary[];
      /** Whether its notes are every note of the workspace: All notes. */
      whole: boolean;
      canEdit: boolean;
      onOpenNote: (noteId: string) => void;
      onChanged: (note: Note) => void;
    }
  | { kind: "page" };

type Kind = Subject["kind"];
type SubjectOf<K extends Kind> = Extract<Subject, { kind: K }>;

/** One tab of the inspector. `for` says what kind of thing it is about: it is offered only while one of those is in front. */
interface InspectorView<K extends Kind = Kind> {
  id: string;
  label: string;
  icon: IconName;
  for: K;
  render: (subject: SubjectOf<K>) => ReactNode;
  /** What its tab is marked with, by a dot and these words, while there is something in it the member hasn't seen. */
  mark?: (subject: SubjectOf<K>) => string | undefined;
}

export const UNSEEN = "Changes you haven't seen";

const view = <K extends Kind>(v: InspectorView<K>) => v as unknown as InspectorView;

const INSPECTOR_VIEWS: readonly InspectorView[] = [
  view({
    id: "history",
    label: "History",
    icon: "history",
    for: "note",
    render: (s) => <NoteHistory workspaceId={s.workspaceId} noteId={s.note.id} revision={s.note.revision} canEdit={s.canEdit} onChanged={s.onChanged} onSeen={s.onSeen} />,
    mark: (s) => (s.unseen ? UNSEEN : undefined),
  }),
  view({ id: "backlinks", label: "Backlinks", icon: "backlinks", for: "note", render: () => <Soon issue={13}>Notes that link here arrive with</Soon> }),
  view({ id: "info", label: "Info", icon: "info", for: "note", render: (subject) => <Info {...subject} /> }),
  view({
    id: "folder-history",
    label: "History",
    icon: "history",
    for: "folder",
    render: (s) => <FolderHistory workspaceId={s.workspaceId} notes={s.notes} whole={s.whole} canEdit={s.canEdit} onOpenNote={s.onOpenNote} onChanged={s.onChanged} />,
  }),
  view({ id: "folder-info", label: "Info", icon: "info", for: "folder", render: (subject) => <FolderInfo {...subject} /> }),
];

/** What a view's tab or icon is marked with for what is in front, if anything. */
export const markOf = (v: InspectorView, subject: Subject | null) => (subject ? v.mark?.(subject) : undefined);

/** The tabs the inspector has for what is in front, in order. None for a page, which has nothing to show there yet. */
export const viewsFor = (subject: Subject | null) => INSPECTOR_VIEWS.filter((v) => v.for === subject?.kind);

/** The tab that shows for what is in front, by the rule in `inspectorPick.ts`. */
export const shownView = (views: readonly InspectorView[], picked: string | null) => pickView(INSPECTOR_VIEWS, views, picked);

interface Props {
  /** Null while what is in front is still loading: the inspector keeps its place and shows nothing. */
  subject: Subject | null;
  /** The tab the member last picked, whatever was in front then. */
  picked: string | null;
  onPick: (viewId: string) => void;
}

export function Inspector({ subject, picked, onPick }: Props) {
  const ids = useId();
  const views = viewsFor(subject);
  const shown = shownView(views, picked);
  return (
    <aside className="inspector" aria-label="Inspector">
      {subject && shown ? (
        <>
          <div role="tablist" className="tabs">
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                id={`${ids}-${v.id}`}
                aria-selected={v === shown}
                aria-controls={`${ids}-panel`}
                aria-description={markOf(v, subject)}
                onClick={() => onPick(v.id)}
              >
                {v.label}
                {markOf(v, subject) && <span className="unseen-dot" />}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${shown.id}`} className="panel">
            {shown.render(subject)}
          </div>
        </>
      ) : (
        subject && <p className="inspector-empty">Nothing to show for this view</p>
      )}
    </aside>
  );
}

function FolderInfo({ name, notes }: SubjectOf<"folder">) {
  const now = useNow();
  const last = notes.reduce<NoteSummary | null>((latest, n) => (latest && latest.updatedAt >= n.updatedAt ? latest : n), null);
  return (
    <dl className="info">
      <dt>Folder</dt>
      <dd>{name}</dd>
      <dt>Notes</dt>
      <dd>{notes.length === 1 ? "1 note" : `${notes.length} notes`}</dd>
      <dt>Last changed</dt>
      <dd>{last ? `${ago(last.updatedAt, now)} by ${last.updatedBy.name}` : "Nothing in it yet"}</dd>
    </dl>
  );
}

function Info({ note, tree, canEdit, onMove }: SubjectOf<"note">) {
  const url = `${location.origin}${notePath(note)}`;
  const urlField = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = [...tree.byId.keys()].map((id) => ({ id, name: pathName(tree, id) })).sort((a, b) => a.name.localeCompare(b.name));

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
        <span>{pathName(tree, note.folderId)}</span>
        <select
          aria-label="Move to"
          value={note.folderId}
          disabled={!canEdit}
          onChange={(e) => {
            setError(null);
            onMove(note.id, e.target.value).catch((err: Error) => setError(err.message));
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
