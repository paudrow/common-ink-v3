import { useId, useRef, useState } from "react";
import { Icon, draggableAs, type NoteSummary, type PluginHost, type ViewProps } from "../plugin-api.ts";
import { matching } from "./lib/match.ts";
import { openPopover } from "./lib/Popover.tsx";
import { MOST_ROWS, crumbsOf, entriesOf, goLabel, type Crumb, type Entry } from "./noteCrumbs.ts";
import { titleOf } from "./noteListView.ts";

const GO = "go";

/** A screen nothing rests on, as a touch screen is, where no card shows. */
const hoverless = () => matchMedia("(hover: none)").matches;

/** The list under a crumb: "Go to folder", then its subfolders and notes, narrowed by what is typed. Arrow keys move, Enter picks and Escape closes. */
function CrumbList({ label, go, entries, onPick }: { label: string; go: string; entries: Entry[]; onPick: (id: string) => void }) {
  const ids = useId();
  const [typed, setTyped] = useState("");
  const [at, setAt] = useState(0);
  const shown = [{ id: GO, kind: "folder" as const, label: go }, ...matching(entries, typed, (e) => e.label).slice(0, MOST_ROWS)];
  const optionId = (i: number) => `${ids}-${i}`;
  const list = useRef<HTMLUListElement>(null);
  const move = (to: number) => {
    setAt(to);
    list.current?.children[to]?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="crumb-list">
      <input
        data-autofocus
        role="combobox"
        aria-label={`Search ${label}`}
        aria-expanded
        aria-controls={`${ids}-list`}
        aria-activedescendant={optionId(at)}
        aria-autocomplete="list"
        placeholder="Search"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
          } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            move(e.key === "Home" ? 0 : shown.length - 1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            onPick(shown[at]!.id);
          }
        }}
      />
      <ul ref={list} id={`${ids}-list`} role="listbox" aria-label={label}>
        {shown.map((entry, i) => (
          <li key={entry.id} id={optionId(i)} role="option" aria-selected={i === at} data-go={entry.id === GO || undefined} onPointerMove={() => setAt(i)} onClick={() => onPick(entry.id)}>
            <Icon name={entry.id === GO ? "open" : entry.kind === "folder" ? "folders" : "text"} />
            <span className="crumb-label">{entry.label}</span>
          </li>
        ))}
      </ul>
      {!!typed.trim() && shown.length === 1 && <p className="empty">Nothing here matches.</p>}
    </div>
  );
}

/**
 * Above an open note, its way down from the workspace: workspace › folder › subfolder › note. Each
 * crumb but the note's own opens a list of that folder's subfolders and notes with "Go to folder" at
 * its top, which is searchable and moved through by the keyboard. Like VS Code's breadcrumbs.
 */
export function NoteCrumbs({ app, host, note }: ViewProps & { host: PluginHost; note: NoteSummary }) {
  const tree = app.folders;
  // Until the folders arrive the line is there and empty, so the note under it doesn't move as they do.
  if (!tree || !app.notes) return <nav className="crumbs" aria-label="Breadcrumbs" aria-busy="true" />;
  const crumbs = crumbsOf(tree, note, host.workspace.name);
  const open = (crumb: Crumb, anchor: HTMLElement) => {
    const entries = entriesOf(tree, app.notes!, crumb);
    openPopover(anchor, `${crumb.name} folder`, (close) => (
      <CrumbList
        label={crumb.name}
        go={goLabel(crumb)}
        entries={entries}
        onPick={(id) => {
          close();
          if (id === GO) return app.openFolder(crumb.folderId);
          const entry = entries.find((e) => e.id === id)!;
          if (entry.kind === "folder") app.openFolder(id);
          // In this pane, whether or not another pane has it.
          else app.openNote(id, { preview: true, focus: true });
        }}
      />
    ));
  };
  return (
    <nav className="crumbs" aria-label="Breadcrumbs">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.folderId}>
            {/* A folder's card names it whole where a pointer rests on it, so there a folder's crumb has no title. A touch screen shows no card, and every crumb keeps one. */}
            <button type="button" className="crumb" aria-haspopup="dialog" {...(tree.byId.has(crumb.folderId) ? { "data-folder": crumb.folderId } : {})} title={hoverless() || !tree.byId.has(crumb.folderId) ? crumb.name : undefined} onClick={(e) => open(crumb, e.currentTarget)} {...draggableAs({ kind: "folder", id: crumb.folderId })}>
              {crumb.name}
            </button>
          </li>
        ))}
        <li aria-current="page">
          <span className="crumb crumb-note" title={titleOf(note)} {...draggableAs({ kind: "note", id: note.id })}>
            {titleOf(note)}
          </span>
        </li>
      </ol>
    </nav>
  );
}
