import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_SEARCH_LENGTH, useInspected, writtenMention, type App, type ContactCard, type PersonPage as Person, type PluginHost, type Results, type Showing } from "../../plugin-api.ts";
import { QueryBar } from "../lib/QueryBar.tsx";
import { fieldsOf, initialsOf } from "./fields.ts";

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

/** One of the asker's contacts that is this person: all it holds, which the asker alone is shown. */
function ContactDetails({ card, provider }: { card: ContactCard; provider: string | undefined }) {
  return (
    <section className="person-contact" aria-label={`Your contact ${card.name}`}>
      <p className="person-whose">From your contacts. Only you see this.</p>
      <dl className="person-fields">
        {fieldsOf(card).map((field) => (
          <div key={field.key} className="person-field" data-field={field.key}>
            <dt>{field.label}</dt>
            <dd>
              {field.values.map((value) => (
                <div key={value}>{field.href ? <a href={field.href(value)} {...(field.key === "urls" && { target: "_blank", rel: "noopener noreferrer" })}>{value}</a> : value}</div>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {card.url && /^https:\/\//.test(card.url) && (
        <a className="person-source" href={card.url} target="_blank" rel="noopener noreferrer">
          Open in {provider ?? "its contacts"}
        </a>
      )}
    </section>
  );
}

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

  // Read on opening, and again a while after notes stop changing: each read lists the member's contacts again from where they are kept.
  const read = useRef<string | null>(null);
  useEffect(() => {
    // An answer is kept unless the page is of someone else by then: a read made before notes changed again is still the latest there is.
    const ask = () =>
      host.perform({ type: "person.read", who }).then(
        (answer) => read.current === who && (setPerson(answer), setProblem(null)),
        (err: unknown) => read.current === who && setProblem(err instanceof Error ? err.message : "This person couldn't be read."),
      );
    const again = read.current === who;
    read.current = who;
    const timer = again ? setTimeout(() => void ask(), REREAD_MS) : (void ask(), undefined);
    return () => clearTimeout(timer);
  }, [host, who, version]);
  useEffect(() => {
    if (!person?.contacts.length) return;
    host.perform({ type: "source.list" }).then((r) => setSources(r.sources), () => {});
  }, [host, person?.contacts.length]);

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
        <ContactDetails key={`${card.sourceId} ${card.id}`} card={card} provider={sources.find((s) => s.id === card.sourceId)?.provider} />
      ))}

      {person.todos.length > 0 && (
        <section className="person-todos" aria-label="Open todos">
          <h2>Open todos</h2>
          <ul>
            {person.todos.map((todo) => (
              <li key={`${todo.noteId}/${todo.line}`}>
                <button type="button" className="person-line" onClick={() => openAt(todo.noteId, todo.line)}>
                  <span className="person-text">{todo.words || "Nothing written"}</span>
                  <span className="person-note">{todo.noteTitle || "Untitled"}</span>
                </button>
              </li>
            ))}
          </ul>
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
