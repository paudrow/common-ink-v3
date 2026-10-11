import { useId, useState } from "react";
import { Icon, NOTE_DRAG, ago, useNow, type NoteSummary, type Plugin } from "../plugin-api.ts";

const titleOf = (note: NoteSummary) => note.title || "Untitled";

const SORTS = [
  { id: "recent", label: "Recent", compare: (a: NoteSummary, b: NoteSummary) => b.updatedAt - a.updatedAt },
  { id: "created", label: "Created", compare: (a: NoteSummary, b: NoteSummary) => b.createdAt - a.createdAt },
  { id: "title", label: "Title", compare: (a: NoteSummary, b: NoteSummary) => titleOf(a).localeCompare(titleOf(b)) },
] as const;

type Sort = (typeof SORTS)[number]["id"];

interface Props {
  heading: string;
  /** Null while the folder's notes load. */
  notes: readonly NoteSummary[] | null;
  openId: string | null;
  pathOf: (noteId: string) => string;
  canEdit: boolean;
  /** Whether each note's first lines are shown under its title. */
  snippets: boolean;
  onNew: () => void;
  /** A single click opens a preview; a double click keeps the note open. */
  onOpen: (note: NoteSummary, keep: boolean) => void;
}

function NoteList({ heading, notes, openId, pathOf, canEdit, snippets, onNew, onOpen }: Props) {
  const ids = useId();
  const now = useNow();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [hasTodos, setHasTodos] = useState(false);

  const needle = filter.trim().toLowerCase();
  const shown = (notes ?? [])
    .filter((n) => (!hasTodos || n.openTodos > 0) && (!needle || `${titleOf(n)}\n${n.snippet}`.toLowerCase().includes(needle)))
    .sort(SORTS.find((s) => s.id === sort)!.compare);

  return (
    <section className="note-list" aria-labelledby={`${ids}-heading`}>
      <header className="list-head">
        <h2 id={`${ids}-heading`}>{heading}</h2>
        {canEdit && (
          <button type="button" className="icon-button" aria-label="New note" title="New note" onClick={onNew}>
            <Icon name="plus" />
          </button>
        )}
      </header>
      <div className="list-tools">
        <input
          type="search"
          className="filter"
          aria-label="Filter notes"
          placeholder={notes ? `Filter ${notes.length} ${notes.length === 1 ? "note" : "notes"}` : "Filter notes"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="chips">
          <div role="group" aria-label="Sort by">
            {SORTS.map((s) => (
              <button key={s.id} type="button" className="chip" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <button type="button" className="chip" aria-pressed={hasTodos} onClick={() => setHasTodos(!hasTodos)}>
            Has todos
          </button>
        </div>
      </div>
      <nav aria-label="Notes" className="list-body">
        {notes && !shown.length && <p className="empty">{notes.length ? "No notes match." : "No notes in this folder."}</p>}
        <ul>
          {shown.map((note) => (
            <li key={note.id}>
              <a
                href={pathOf(note.id)}
                className="note-row"
                draggable
                aria-current={note.id === openId ? "page" : undefined}
                aria-labelledby={`${ids}-${note.id}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(NOTE_DRAG, note.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onOpen(note, false);
                }}
                onDoubleClick={() => onOpen(note, true)}
              >
                <span className="row-title" id={`${ids}-${note.id}`}>
                  {titleOf(note)}
                </span>
                {snippets && note.snippet && <span className="row-snippet">{note.snippet}</span>}
                <span className="row-meta">
                  <span>
                    {ago(note.updatedAt, now)} · {note.updatedBy.name}
                  </span>
                  {note.openTodos > 0 && <span>{note.openTodos} open</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}

export const noteList: Plugin = {
  id: "note-list",
  name: "Note list",
  settings: {
    snippets: { type: "boolean", default: true, title: "Show snippets", description: "Show the first lines of each note under its title." },
  },
  activate(host) {
    host.views.register("column", {
      id: "notes",
      popover: true,
      component: ({ app }) => (
        <NoteList
          heading={app.folderId && app.folders ? (app.folders.byId.get(app.folderId)?.name ?? "") : "All notes"}
          notes={app.notes && (app.folderId ? app.notes.filter((n) => n.folderId === app.folderId) : app.notes)}
          openId={app.note?.id ?? null}
          pathOf={app.notePath}
          canEdit={app.canEdit}
          snippets={host.settings.get<boolean>("snippets")}
          onNew={app.createNote}
          onOpen={(note, keep) => app.openNote(note.id, { preview: !keep })}
        />
      ),
    });
  },
};
