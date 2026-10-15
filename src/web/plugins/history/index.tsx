import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ALL_NOTES, useInspected, type About, type Blame, type NoteSummary, type Plugin, type PluginHost, type Showing, type ViewProps } from "../../plugin-api.ts";
import { titleOf } from "../lib/historyView.ts";
import { History, isScope, type Kept, type Left, type Scope } from "./History.tsx";
import { whoWrote, whoWroteToggles, type WhoWroteToggles } from "./whoWrote.ts";

const PATH = "/history";
/** The page's state that asks for every note and everyone's changes, where no state leaves the page as it is. */
const EVERYTHING = "everything";
/** As many notes as history can be narrowed to at once. A folder with more shows the ones changed last. */
const MOST_NOTES = 200;

/** Changes when any of the notes does. */
const versionOf = (notes: readonly NoteSummary[]) => notes.reduce((sum, n) => sum + n.revision, 0);

/** Which of the notes the member may change: each note says so of itself, since a grant or a private note can differ from the member's role. */
function useEditable(notes: readonly NoteSummary[]): (noteId: string) => boolean {
  const editable = useMemo(() => new Set(notes.filter((n) => n.access === "edit").map((n) => n.id)), [notes]);
  return useCallback((noteId: string) => editable.has(noteId), [editable]);
}

const ANY = () => true;
const NONE = () => false;

/** Where each History that was shown keeps its ticks, by what it was of. */
type Places = (place: string) => Left;

/**
 * What the page tells the inspector it is showing: the notes whose changes are ticked. One note is
 * that note, so Info and the rest are about it. With nothing ticked the page is its own list, and
 * the inspector has nothing of its own to add.
 */
const shows = (ticked: readonly string[]): Showing | null =>
  ticked.length > 1 ? { kind: "notes", label: "Ticked in History", noteIds: ticked } : ticked[0] ? { kind: "note", noteId: ticked[0] } : null;

/** The page, narrowed to the scope it was last opened with: a note's or a folder's notes from their History tab, or an author another plugin names. */
function Page({ host, app, places }: ViewProps & { host: PluginHost; places: Places }) {
  const handed = app.pageState;
  const [scope, setScope] = useState<Scope | null>(isScope(handed) ? handed : null);
  useEffect(() => {
    if (isScope(handed)) setScope(handed);
    else if (handed === EVERYTHING) setScope(null);
  }, [handed]);
  // Each scope is a place of its own, with its own ticks: History starts again from what that place kept.
  const canEdit = useEditable(app.notes ?? []);
  const place = `page ${scope ? ("author" in scope ? `by ${scope.author.kind} ${scope.author.id}` : `of ${scope.noteIds.join()}`) : "everything"}`;
  const [ticked, setTicked] = useState<readonly string[]>([]);
  useInspected(app, shows(ticked));
  return (
    <History key={place} host={host} me={app.me.id} canEdit={canEdit} scope={scope} layout="page" version={versionOf(app.notes ?? [])} empty="Nothing has been written in this workspace yet." onScope={setScope} onTicked={setTicked} onOpenNote={app.openNote} onChanged={app.refresh} left={places(place)} />
  );
}

interface OfNotesProps extends ViewProps {
  host: PluginHost;
  /** What the notes are called, or null where they are every note there is. */
  name: string | null;
  notes: readonly NoteSummary[];
  /** What to say where they have no history. */
  empty: string;
  left: Left;
}

/** History for the inspector, narrowed to a set of notes: a folder's, or the ones a page is showing. */
function OfNotes({ host, app, name, notes, empty, left }: OfNotesProps) {
  const canEdit = useEditable(notes);
  const ids = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MOST_NOTES).map((n) => n.id).join(","), [notes]);
  const scope = useMemo<Scope | null>(() => (name === null ? null : { label: name, noteIds: ids ? ids.split(",") : [] }), [name, ids]);
  if (name !== null && !notes.length) return <p className="empty">{empty}</p>;
  return <History host={host} me={app.me.id} canEdit={canEdit} scope={scope} layout="panel" version={versionOf(notes)} empty={empty} onOpenHistory={() => app.go(PATH, { state: scope ?? EVERYTHING })} onOpenNote={app.openNote} onChanged={app.refresh} left={left} />;
}

/** The changes asked for from a line's bar, by note, until the note's History panel shows them; and the notes whose panel is showing. */
interface Asked {
  of(noteId: string): number | null;
  subscribe(listener: () => void): () => void;
  shown(noteId: string): void;
  showing: Set<string>;
}

/** The switch for a note's bars, in its History panel. */
function WhoWroteSwitch({ toggles, noteId }: { toggles: WhoWroteToggles; noteId: string }) {
  const on = useSyncExternalStore(toggles.subscribe, () => toggles.has(noteId));
  return (
    <button type="button" role="switch" aria-checked={on} className="link who-switch" title="Mark each line with who last wrote it" onClick={() => toggles.toggle(noteId)}>
      Who wrote this
    </button>
  );
}

/** The inspector's History, by what is in front. */
function Panel({ host, app, about, places, toggles, asked }: ViewProps & { host: PluginHost; about: About; places: Places; toggles: WhoWroteToggles; asked: Asked }) {
  const noteId = about.kind === "note" ? about.note.id : null;
  const pick = useSyncExternalStore(asked.subscribe, () => (noteId ? asked.of(noteId) : null));
  useEffect(() => {
    if (!noteId) return;
    asked.showing.add(noteId);
    return () => {
      asked.showing.delete(noteId);
      // A change asked for and not shown yet is not shown the next time this note's History is. Not while the panel is only drawn again.
      setTimeout(() => !asked.showing.has(noteId) && asked.shown(noteId));
    };
  }, [asked, noteId]);
  if (about.kind === "folder") {
    const whole = about.folderId === ALL_NOTES;
    return <OfNotes key={`folder ${about.folderId}`} host={host} app={app} name={whole ? null : about.name} notes={about.notes} empty={whole ? "Nothing has been written in this workspace yet." : "Nothing has been written in this folder yet."} left={places(`folder ${about.folderId}`)} />;
  }
  if (about.kind === "notes") return <OfNotes key={`notes ${about.label}`} host={host} app={app} name={about.label} notes={about.notes} empty="Nothing has been written in these notes yet." left={places(`notes ${about.label}`)} />;
  const { note } = about;
  const scope: Scope = { label: titleOf(note.title), noteIds: [note.id], one: true };
  return (
    <History
      key={note.id}
      host={host}
      me={app.me.id}
      canEdit={note.access === "edit" ? ANY : NONE}
      scope={scope}
      layout="panel"
      version={note.revision}
      empty="Nothing has been written in this note yet."
      onOpenHistory={() => app.go(PATH, { state: scope })}
      onOpenNote={app.openNote}
      onChanged={app.refresh}
      onLoaded={(changes) => app.markSeen(note.id, changes[0]?.revision ?? 0)}
      left={places(`note ${note.id}`)}
      pick={pick}
      onPicked={() => asked.shown(note.id)}
      tools={<WhoWroteSwitch toggles={toggles} noteId={note.id} />}
    />
  );
}

export const history: Plugin = {
  id: "history",
  name: "History",
  description: "Every change to a note, who made it, and a way to take it back. Who wrote this marks each line of a note with who last wrote it.",
  icon: "history",
  activate(host) {
    // Kept while the app is open and no longer: a reload starts with nothing ticked.
    const kept = new Map<string, Kept>();
    const places: Places = (place) => ({ get: () => kept.get(place), set: (left) => void kept.set(place, left) });

    const toggles = whoWroteToggles(host.storage);
    const read = new Map<string, Blame>();
    const picks = new Map<string, number>();
    const listeners = new Set<() => void>();
    const told = () => listeners.forEach((listener) => listener());
    const asked: Asked = {
      of: (noteId) => picks.get(noteId) ?? null,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      shown(noteId) {
        if (picks.delete(noteId)) told();
      },
      showing: new Set(),
    };
    const openAt = (noteId: string, revision: number) => {
      picks.set(noteId, revision);
      told();
      if (!asked.showing.has(noteId)) host.app().togglePanel("history");
    };
    host.editorExtensions.register({ id: "whoWrote", extension: (editor) => (editor.reading ? [] : whoWrote(host, toggles, read, openAt, editor.noteId)) });
    host.commands.register({
      id: "history.whoWrote",
      title: "Who wrote this",
      when: () => host.app().noteId !== null,
      run: () => {
        const { noteId } = host.app();
        if (noteId) toggles.toggle(noteId);
      },
    });
    host.views.register("page", {
      id: "history",
      path: PATH,
      label: "History",
      icon: "history",
      nav: "more",
      component: ({ app }) => <Page host={host} app={app} places={places} />,
    });
    host.views.register("inspector", {
      id: "history",
      label: "History",
      icon: "history",
      for: ["note", "folder", "notes"],
      badge: (app) => (app.unseen ? "Changes you haven't seen" : null),
      component: ({ app, about }) => <Panel host={host} app={app} about={about} places={places} toggles={toggles} asked={asked} />,
    });
  },
};
