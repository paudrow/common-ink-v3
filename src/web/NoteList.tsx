import { useId, useState } from "react";
import type { NoteSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { Icon } from "./icons.tsx";
import { ago, useNow } from "./time.ts";

export const NOTE_DRAG = "application/x-common-ink-note";

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
  notes: NoteSummary[] | null;
  openId: string | null;
  canEdit: boolean;
  onNew: () => void;
  onOpen: (note: NoteSummary) => void;
}

export function NoteList({ heading, notes, openId, canEdit, onNew, onOpen }: Props) {
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
                href={notePath(note)}
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
                  onOpen(note);
                }}
              >
                <span className="row-title" id={`${ids}-${note.id}`}>
                  {titleOf(note)}
                </span>
                {note.snippet && <span className="row-snippet">{note.snippet}</span>}
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
