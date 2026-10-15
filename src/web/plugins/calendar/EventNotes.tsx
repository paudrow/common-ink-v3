import { useEffect, useState } from "react";
import type { App, CalendarEvent, ListedFolder, NoteAbout, PluginHost } from "../../plugin-api.ts";
import { dayIn, dayLabel } from "./dates.ts";

const AUDIENCE: Record<NoteAbout["audience"], { label: string; title: string }> = {
  private: { label: "Private", title: "Only its owner sees it" },
  shared: { label: "Shared", title: "Its owner and the people it is shared with see it" },
  workspace: { label: "Workspace", title: "Everyone in the workspace sees it" },
};

type Listed = { is: "reading" } | { is: "listed"; notes: readonly NoteAbout[] } | { is: "failed"; message: string };

/** The folders the member may make a note in, each named by its path, in the order the tree has them. */
function foldersFor(app: App): { id: string; name: string }[] {
  const folders = app.folders;
  if (!folders) return [];
  const walk = (parent: string | null): ListedFolder[] => folders.childrenOf(parent).flatMap((f) => [f, ...walk(f.id)]);
  return walk(null)
    .filter((f) => f.access === "edit")
    .map((f) => ({ id: f.id, name: folders.pathName(f.id) }));
}

/**
 * What a note about an event starts with: its title and day as the heading, and a reference to it.
 * The title is the reference's label, which the server wrote: a title someone else gave the event
 * writes no link, embed, code or line of its own into the note.
 */
export function noteAbout(event: CalendarEvent, reference: string, timeZone: string): string {
  const label = /^::event\{[a-z0-9]{12} ?(.*)\}$/.exec(reference)?.[1] || "Untitled";
  return `# ${label}, ${dayLabel(event.when.allDay ? event.when.from : dayIn(event.when.from, timeZone), "short")}\n\n${reference}\n\n`;
}

interface Props {
  host: PluginHost;
  app: App;
  event: CalendarEvent;
  timeZone: string;
  /** Closes the event, as opening a note from it does. */
  close: () => void;
}

/** One action that makes a note about the event, in a folder the member picks, last used first, and shared as anything in that folder is. */
export function NewNoteAbout({ host, app, event, timeZone, close }: Props) {
  const [choosing, setChoosing] = useState(false);
  const folders = foldersFor(app);
  const last = host.storage.get("noteFolder");
  const [folder, setFolder] = useState(() => [last, app.folders?.unsortedId].find((id): id is string => typeof id === "string" && folders.some((f) => f.id === id)) ?? folders[0]?.id ?? "");
  const [making, setMaking] = useState<{ busy: boolean; failed?: string }>({ busy: false });

  const make = async () => {
    setMaking({ busy: true });
    try {
      const { text } = await host.perform({ type: "record.refer", sourceId: event.sourceId, id: event.id });
      const note = await host.perform({ type: "note.create", folderId: folder || undefined, text: noteAbout(event, text, timeZone) });
      host.storage.set("noteFolder", note.folderId);
      app.noteChanged(note);
      close();
      app.openNote(note.id, { preview: false });
    } catch (err) {
      setMaking({ busy: false, failed: (err as Error).message });
    }
  };

  // A member who can add to no folder, as a viewer, is offered nothing.
  if (!folders.length) return null;
  if (!choosing)
    return (
      <button type="button" className="button small" onClick={() => setChoosing(true)}>
        New note about this event
      </button>
    );
  return (
    <form
      className="event-new-note"
      aria-label="New note about this event"
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
    >
      <label>
        <span>New note in</span>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} autoFocus>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button small primary" disabled={making.busy || !folders.length}>
        Make the note
      </button>
      <button type="button" className="link" onClick={() => setChoosing(false)}>
        Cancel
      </button>
      <p className="event-note">It is shared as everything in its folder is, and references this event.</p>
      {making.failed && (
        <p role="alert" className="said failed">
          {making.failed}
        </p>
      )}
    </form>
  );
}

/** The notes that reference the event that the member can see, each saying who sees it. */
export function NotesAbout({ host, app, event, close }: Omit<Props, "timeZone">) {
  const [listed, setListed] = useState<Listed>({ is: "reading" });

  useEffect(() => {
    let current = true;
    host.perform({ type: "record.notes", sourceId: event.sourceId, id: event.id }).then(
      ({ notes }) => current && setListed({ is: "listed", notes }),
      (err: Error) => current && setListed({ is: "failed", message: err.message }),
    );
    return () => void (current = false);
  }, [host, event.sourceId, event.id]);

  return (
    <section className="event-notes" aria-label="Notes about this event" aria-busy={listed.is === "reading"}>
      <h3>Notes about this event</h3>
      {listed.is === "failed" && (
        <p role="alert" className="said failed">
          {listed.message}
        </p>
      )}
      {listed.is === "listed" &&
        (listed.notes.length ? (
          <ul className="event-note-list">
            {listed.notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    close();
                    app.openNote(note.id, { preview: false });
                  }}
                >
                  {note.title || "Untitled"}
                </button>
                <span className="event-audience" data-audience={note.audience} title={AUDIENCE[note.audience].title}>
                  {AUDIENCE[note.audience].label}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="event-note">No note references this event yet.</p>
        ))}
    </section>
  );
}
