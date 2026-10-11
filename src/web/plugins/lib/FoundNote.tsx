import type { MouseEvent } from "react";
import { ago, type App, type NoteSummary } from "../../plugin-api.ts";

/** Why an operation didn't answer: the server's reason when it refused, and otherwise that it couldn't be reached. */
export const reasonOf = (err: unknown) => (err instanceof Error && "code" in err ? err.message : "Common Ink can't be reached.");

/**
 * What makes a link to a note open it as the note list does: a click opens a preview, a double click
 * keeps it open, and a click with a modifier is the browser's, which opens the note's address in a new tab.
 */
export const opening = (app: App, note: NoteSummary) => ({
  href: app.notePath(note.id),
  onClick(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.openNote(note.id, { preview: true });
  },
  onDoubleClick: () => app.openNote(note.id),
});

/** A found note's title, and under it its folder when the member can see it, when it last changed, and whether it is archived. */
export function FoundNote({ app, note, now }: { app: App; note: NoteSummary; now: number }) {
  const folder = note.folderId !== null && app.folders?.byId.has(note.folderId) ? app.folders.pathName(note.folderId) : null;
  return (
    <>
      <span className="found-title">{note.title || "Untitled"}</span>
      <span className="found-meta">
        {folder && <span>{folder}</span>}
        <span>{ago(note.updatedAt, now)}</span>
        {note.state === "archived" && <span className="found-archived">Archived</span>}
      </span>
    </>
  );
}

/** The toggle of a listing that leaves archived notes out unless asked. */
export function IncludeArchived({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="include-archived">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Include archived
    </label>
  );
}
