import { useEffect, useRef, useState, type ReactNode } from "react";
import type { App, CalendarEvent, ListedFolder, NoteAbout, PluginHost, Reference } from "../../plugin-api.ts";
import { dayIn, dayLabel } from "./dates.ts";

const AUDIENCE: Record<NoteAbout["audience"], { label: string; title: string }> = {
  private: { label: "Private", title: "Only its owner sees it" },
  shared: { label: "Shared", title: "Its owner and the people it is shared with see it" },
  workspace: { label: "Workspace", title: "Everyone in the workspace sees it" },
};

type Listed = { is: "reading" } | { is: "listed"; notes: readonly NoteAbout[] } | { is: "failed"; message: string };

/** The notes about the event that the member can see, the one changed last first, as `record.notes` answers. */
export function useNotesAbout(host: PluginHost, event: Pick<CalendarEvent, "sourceId" | "id">): Listed {
  const [listed, setListed] = useState<Listed>({ is: "reading" });
  useEffect(() => {
    let current = true;
    host.perform({ type: "record.notes", sourceId: event.sourceId, id: event.id }).then(
      ({ notes }) => current && setListed({ is: "listed", notes }),
      (err: Error) => current && setListed({ is: "failed", message: err.message }),
    );
    return () => void (current = false);
  }, [host, event.sourceId, event.id]);
  return listed;
}

/** Who sees a note about the event: Private, Shared or Workspace. */
export const Audience = ({ of }: { of: NoteAbout["audience"] }) => (
  <span className="event-audience" data-audience={of} title={AUDIENCE[of].title}>
    {AUDIENCE[of].label}
  </span>
);

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
 * What a note about an event starts with: its title and day as the heading, and a link to it.
 * The title is the reference's label, which the server wrote: a title someone else gave the event
 * writes no link, embed, code or line of its own into the note.
 */
export function noteAbout(event: CalendarEvent, reference: Pick<Reference, "text" | "label">, timeZone: string): string {
  return `# ${reference.label || "Untitled"}, ${dayLabel(event.when.allDay ? event.when.from : dayIn(event.when.from, timeZone), "short")}\n\n${reference.text}\n\n`;
}

interface Props {
  host: PluginHost;
  app: App;
  event: CalendarEvent;
  timeZone: string;
  /** Closes the event, as opening a note from it does. */
  close: () => void;
}

/** What starts making the note: the panel's main button, unless another is given. */
const startButton = (start: () => void) => (
  <button type="button" className="button primary event-new-note-start" onClick={start}>
    New note about this event
  </button>
);

/** One action that makes a note about the event, in a folder the member picks, last used first, and shared as anything in that folder is. */
export function NewNoteAbout({ host, app, event, timeZone, close, starter = startButton }: Props & { starter?: (start: () => void) => ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const folders = foldersFor(app);
  const last = host.storage.get("noteFolder");
  const [folder, setFolder] = useState(() => [last, app.folders?.unsortedId].find((id): id is string => typeof id === "string" && folders.some((f) => f.id === id)) ?? folders[0]?.id ?? "");
  const [making, setMaking] = useState<{ busy: boolean; failed?: string }>({ busy: false });
  // Cancel gives the keyboard back to the action that opened the form, which takes the form's place.
  const start = useRef<HTMLSpanElement>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (cancelled && !choosing) start.current?.querySelector<HTMLElement>("button")?.focus();
  }, [cancelled, choosing]);

  const make = async () => {
    setMaking({ busy: true });
    try {
      const reference = await host.perform({ type: "record.refer", sourceId: event.sourceId, id: event.id });
      const note = await host.perform({ type: "note.create", folderId: folder || undefined, text: noteAbout(event, reference, timeZone) });
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
      <span ref={start} className="event-note-start">
        {starter(() => {
          setCancelled(false);
          setChoosing(true);
        })}
      </span>
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
      <button
        type="button"
        className="link"
        onClick={() => {
          setChoosing(false);
          setCancelled(true);
        }}
      >
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

/** The notes that reference the event that the member can see, each saying who sees it, and under them `children`, the way to make another. */
export function NotesAbout({ host, app, event, close, children }: Omit<Props, "timeZone"> & { children?: ReactNode }) {
  const listed = useNotesAbout(host, event);

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
                <Audience of={note.audience} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="event-note">No note references this event yet.</p>
        ))}
      {children}
    </section>
  );
}
