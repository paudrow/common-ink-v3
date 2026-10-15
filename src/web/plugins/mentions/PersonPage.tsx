import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_SEARCH_LENGTH, useInspected, writtenMention, type App, type PersonPage as Person, type PluginHost, type Results, type Showing, type Source } from "../../plugin-api.ts";
import { personPath } from "../lib/person.ts";
import { QueryBar } from "../lib/QueryBar.tsx";
import { TodoList } from "../todos/Todos.tsx";
import { ContactSection } from "./ContactEditor.tsx";
import { initialsOf } from "./fields.ts";

/** How long typing rests before the search is asked for. */
const PAUSE_MS = 200;
/** How long notes rest from changing before the page is read again. */
const REREAD_MS = 1500;

const ago = (at: number, now: number) => {
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

interface Props {
  host: PluginHost;
  app: App;
  who: string;
  /** Opens a note with the cursor at the end of a line. */
  openAt: (noteId: string, line: number) => void;
}

/**
 * A person's page: who they are as the member is told it, the open todos assigned to them, and the
 * lines of notes that mention them, which the field searches among. Its one action makes a note about them.
 */
export function PersonPage({ host, app, who, openAt }: Props) {
  const [person, setPerson] = useState<Person | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; answer: Results["search"] | null; problem: string | null } | null>(null);
  const [sources, setSources] = useState<Results["source.list"]["sources"]>([]);
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}:${n.state}`).join(","), [app.notes]);
  /** Bumped when the member changed their contacts from here, which the page is read again for at once. */
  const [changed, setChanged] = useState(0);

  // Read on opening, and again a while after notes stop changing: each read lists the member's contacts again from where they are kept.
  const read = useRef<{ who: string; changed: number } | null>(null);
  useEffect(() => {
    // An answer is kept unless the page is of someone else by then: a read made before notes changed again is still the latest there is.
    const ask = () =>
      host.perform({ type: "person.read", who }).then(
        (answer) => read.current?.who === who && (setPerson(answer), setProblem(null)),
        (err: unknown) => read.current?.who === who && setProblem(err instanceof Error ? err.message : "This person couldn't be read."),
      );
    const again = read.current?.who === who && read.current.changed === changed;
    read.current = { who, changed };
    const timer = again ? setTimeout(() => void ask(), REREAD_MS) : (void ask(), undefined);
    return () => clearTimeout(timer);
  }, [host, who, version, changed]);
  // The member's data sources say whether their contacts can be changed from here, or added to.
  useEffect(() => {
    host.perform({ type: "source.list" }).then((r) => setSources(r.sources), () => {});
  }, [host, changed]);

  const wanted = typed.trim();
  useEffect(() => {
    if (wanted === query) return;
    const timer = setTimeout(() => setQuery(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, query]);
  useEffect(() => {
    if (!person || !query) return void setFound(null);
    let stale = false;
    // What is typed is one group, so an OR in it is still among the notes that mention them.
    const asked = `${person.query} (${query})`;
    if (asked.length > MAX_SEARCH_LENGTH) return void setFound({ query, answer: null, problem: `A search here can be ${MAX_SEARCH_LENGTH - person.query.length - 3} characters long` });
    host.perform({ type: "search", query: asked, today: new Date().toISOString().slice(0, 10), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, limit: 50 }).then(
      (answer) => !stale && setFound({ query, answer, problem: null }),
      (err: unknown) => !stale && setFound({ query, answer: null, problem: err instanceof Error ? err.message : "The search couldn't be made." }),
    );
    return () => {
      stale = true;
    };
  }, [host, person, query, version]);

  // The inspector is about the notes that mention them, or while a search among those is shown, the notes it found.
  const showing = useMemo((): Showing | null => {
    if (!person) return null;
    if (found?.answer) return { kind: "notes", label: `${person.name}: ${found.query}`, noteIds: [...new Set(found.answer.results.map((r) => r.note.id))].sort() };
    return { kind: "notes", label: person.name, noteIds: [...new Set(person.mentionedIn.map((line) => line.noteId))].sort() };
  }, [person, found]);
  useInspected(app, showing);

  const newNote = async () => {
    if (!person) return;
    const mention = writtenMention({ id: person.member?.personId ?? null, name: person.name });
    try {
      const note = await host.perform({ type: "note.create", text: `# ${person.name}\n\n${mention} ` });
      app.openNote(note.id, { focus: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "The note couldn't be made.");
    }
  };

  /** Connects a contacts data source again, asking to change it too: off to agree to it where that is somewhere else. */
  const connectToEdit = async (source: Source) => {
    try {
      const answer = await host.perform({ type: "source.connect", id: source.id, back: app.path, edit: true });
      if (answer.redirect) return void (location.href = answer.redirect);
      setChanged((n) => n + 1);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "It couldn't be connected.");
    }
  };
  const addToContacts = async (sourceId: string) => {
    if (!person) return;
    try {
      await host.perform({ type: "contact.create", sourceId, name: person.name, ...(person.member?.email && { emails: [person.member.email] }) });
      setChanged((n) => n + 1);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "The contact couldn't be added.");
    }
  };

  if (!person) {
    return (
      <section className="person-page" aria-label="Person">
        {problem ? (
          <p role="alert" className="said failed">
            {problem}
          </p>
        ) : (
          <p className="person-none">Reading…</p>
        )}
      </section>
    );
  }
  const photo = person.contacts.find((c) => c.photo)?.photo;
  const what = person.member ? `Member · ${person.member.role}` : person.contacts.length ? "One of your contacts" : "Mentioned by name";
  const now = Date.now();
  // A guest and a viewer can't make a note, so the page has nothing for them to press.
  const canWrite = host.workspace.role === "admin" || host.workspace.role === "editor";
  // Where to add them to the member's own contacts, when they aren't there: the first contacts data source that takes changes, or one that would once connected again.
  const contactSources = sources.filter((s) => s.kind === "contacts" && s.state === "connected");
  const addTo = contactSources.find((s) => s.writable);
  const couldAddTo = contactSources.find((s) => s.reconnectToWrite);

  return (
    <section className="person-page" aria-label={person.name}>
      <header className="person-head">
        {photo ? <img className="person-photo" src={photo} alt="" referrerPolicy="no-referrer" /> : <span className="person-photo" aria-hidden="true">{initialsOf(person.name)}</span>}
        <div className="person-title">
          <h1>{person.name}</h1>
          <p className="person-what">
            {what}
            {person.member?.email && (
              <>
                {" · "}
                <a href={`mailto:${person.member.email}`}>{person.member.email}</a>
              </>
            )}
          </p>
        </div>
        {canWrite && (
          <button type="button" className="button primary person-new" onClick={() => void newNote()}>
            New note about {person.name}
          </button>
        )}
      </header>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {person.contacts.map((card) => (
        <ContactSection
          key={`${card.sourceId} ${card.id}`}
          host={host}
          card={card}
          source={sources.find((s) => s.id === card.sourceId)}
          onConnect={(source) => void connectToEdit(source)}
          onSaved={(saved, change) => {
            // A contact renamed is found by its new name: the page goes there, as a mention of that name would.
            if (change.name !== undefined && !person.member) return app.go(personPath(saved.name), { replace: true });
            setChanged((n) => n + 1);
          }}
        />
      ))}
      {!person.contacts.length && (addTo ?? couldAddTo) && (
        <section className="person-contact person-not-contact" aria-label="Not in your contacts">
          <p className="person-whose">{person.name} isn't in your contacts.</p>
          {addTo ? (
            <button type="button" className="button small" onClick={() => void addToContacts(addTo.id)}>
              Add to my contacts
            </button>
          ) : (
            <button type="button" className="button small" onClick={() => void connectToEdit(couldAddTo!)}>
              Connect again to edit contacts
            </button>
          )}
        </section>
      )}

      {person.todos.length > 0 && (
        <section className="person-todos" aria-label="Open todos">
          <h2>Open todos</h2>
          <TodoList
            host={host}
            app={app}
            query={person.todoQuery}
            label={`Open todos assigned to ${person.name}`}
            none={null}
            onOpen={(todo, beside) => (beside && app.openBeside ? app.openBeside({ kind: "note", id: todo.noteId }, "right") : openAt(todo.noteId, todo.line))}
            // A tag's chip opens the Todos page, narrowed to their todos with that tag.
            onTag={(name) => app.go(`/todos?${new URLSearchParams({ q: `${person.todoQuery} #${name}` })}`)}
          />
        </section>
      )}

      <section className="person-mentions" aria-label="Mentioned in">
        <h2>Mentioned in</h2>
        <QueryBar
          host={host}
          app={app}
          scope="notes"
          value={typed}
          label={`Search the notes that mention ${person.name}`}
          placeholder={`Search the notes that mention ${person.name}`}
          problem={found?.query === query ? found.problem : null}
          onChange={(text, how) => {
            setTyped(text);
            if (how === "set" || !text.trim()) setQuery(text.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery(wanted);
          }}
        />
        {query ? (
          found?.answer && (
            <ul aria-label="Found">
              {found.answer.results.length === 0 && <li className="person-none">No note that mentions {person.name} matches.</li>}
              {found.answer.results.map(({ note }) => (
                <li key={note.id}>
                  <button type="button" className="person-line" onClick={() => app.openNote(note.id, { focus: true })}>
                    <span className="person-text">{note.title || "Untitled"}</span>
                    <span className="person-note">{ago(note.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul aria-label="Lines">
            {person.mentionedIn.length === 0 && <li className="person-none">No note you can see mentions {person.name}.</li>}
            {person.mentionedIn.map((m) => (
              <li key={`${m.noteId}/${m.line}`}>
                <button type="button" className="person-line" onClick={() => openAt(m.noteId, m.line)}>
                  <span className="person-text">{m.text}</span>
                  <span className="person-note">
                    {m.noteTitle || "Untitled"} · {ago(m.updatedAt, now)}
                  </span>
                </button>
              </li>
            ))}
            {person.more && <li className="person-none">The latest {person.mentionedIn.length} are listed. Search to find older ones.</li>}
          </ul>
        )}
      </section>
    </section>
  );
}
