import { useEffect, useId, useReducer, useRef, useState } from "react";
import { MAX_SEARCH_LENGTH, useNow, type App, type PluginHost, type SearchMatch, type SearchResult } from "../../plugin-api.ts";
import { FoundNote, IncludeArchived, opening, reasonOf } from "../lib/FoundNote.tsx";
import { pieces } from "./marks.ts";
import { IDLE, addressOf, againLimit, askOf, reduce, type Ask } from "./request.ts";

/** How long typing rests before the search is asked, so a word is one search and not one a letter. */
const PAUSE_MS = 200;
/** How long the page waits before asking again a search the server answered while still indexing. Each ask indexes more. */
const INDEXING_PAUSE_MS = 1500;
const STILL_INDEXING = "Still indexing notes. Results may be missing some.";

/** A matched line, as the characters it is: each match in a `<mark>`, and nothing in it read as markdown or HTML. */
function Line({ match }: { match: SearchMatch }) {
  return (
    <span className="found-line">
      {pieces(match.text, match.marks).map((piece, i) => (piece.marked ? <mark key={i}>{piece.text}</mark> : piece.text))}
    </span>
  );
}

export function SearchPage({ host, app }: { host: PluginHost; app: App }) {
  const ids = useId();
  const now = useNow();
  const field = useRef<HTMLInputElement>(null);
  // The address is the search. Typing writes it there after a pause, and a link, a reload, or Back brings one back.
  const { query, includeArchived } = askOf(app.query);
  const [typed, setTyped] = useState(query);
  const [state, dispatch] = useReducer(reduce, IDLE);
  /** The query this page last put in the address. Any other one there came from outside, and is shown in the field. */
  const written = useRef(query);
  const optionId = (i: number) => `${ids}-result-${i}`;

  // After the palette that came here has given focus back to where it was.
  useEffect(() => field.current?.focus(), []);

  const goTo = (ask: Ask) => {
    written.current = ask.query;
    app.go(addressOf(ask), { replace: true });
  };
  const wanted = typed.trim().slice(0, MAX_SEARCH_LENGTH);

  useEffect(() => {
    if (query === written.current) return;
    written.current = query;
    setTyped(query);
  }, [query]);

  useEffect(() => {
    if (wanted === query) return;
    const timer = setTimeout(() => goTo({ query: wanted, includeArchived }), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, query, includeArchived]);

  const search = (ask: Ask, offset = 0) => {
    dispatch(offset ? { type: "moreAsked" } : { type: "asked", ask });
    if (!ask.query) return;
    host.perform({ type: "search", ...ask, offset }).then(
      ({ results, next, indexing }) => dispatch({ type: "answered", ask, offset, results, next, indexing }),
      (err: unknown) => dispatch({ type: "refused", ask, offset, message: reasonOf(err) }),
    );
  };
  useEffect(() => search({ query, includeArchived }), [host, query, includeArchived]);

  const listed = state.status === "listed" ? state : null;
  const shown: readonly SearchResult[] = listed?.results ?? (state.status === "searching" ? (state.before ?? []) : []);
  const at = listed && listed.results.length ? listed.at : null;

  const partial = listed?.indexing && listed.more !== "asking" ? listed : null;
  const partialAsk = partial?.ask;
  const partialResults = partial?.results;
  useEffect(() => {
    if (!partialAsk || !partialResults) return;
    let left = false;
    let timer: ReturnType<typeof setTimeout>;
    const again = () => {
      timer = setTimeout(() => {
        host.perform({ type: "search", ...partialAsk, offset: 0, limit: againLimit(partialResults.length) }).then(
          ({ results, next, indexing }) => !left && dispatch({ type: "reanswered", ask: partialAsk, results, next, indexing }),
          // The results on show stay, and the server is asked once more after the same pause.
          () => !left && again(),
        );
      }, INDEXING_PAUSE_MS);
    };
    again();
    return () => {
      left = true;
      clearTimeout(timer);
    };
  }, [host, partialAsk, partialResults]);
  useEffect(() => {
    if (at !== null) document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return (
    <section className="search-page" aria-label="Search">
      <h1>Search</h1>
      <div className="search-tools">
        <input
          ref={field}
          type="search"
          className="filter"
          role="combobox"
          aria-label="Search notes"
          aria-expanded={shown.length > 0}
          aria-controls={`${ids}-results`}
          aria-activedescendant={at !== null ? optionId(at) : undefined}
          aria-autocomplete="list"
          aria-describedby={`${ids}-syntax`}
          placeholder="Search the text of your notes"
          maxLength={MAX_SEARCH_LENGTH}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              dispatch({ type: "moved", by: e.key === "ArrowDown" ? 1 : -1 });
            } else if (e.key === "Enter") {
              e.preventDefault();
              // Enter before the pause is over asks for what is typed. It never opens a result of the search before.
              if (wanted !== query) goTo({ query: wanted, includeArchived });
              else if (listed && at !== null) app.openNote(listed.results[at]!.note.id, { focus: true });
            }
          }}
        />
        <p className="search-syntax" id={`${ids}-syntax`}>
          Words, <code>"a phrase"</code>, <code>#tag</code>, <code>+project</code>
        </p>
        <IncludeArchived checked={includeArchived} onChange={(checked) => goTo({ query: wanted, includeArchived: checked })} />
      </div>
      {state.status === "failed" ? (
        <p className="search-status" role="alert">
          {state.message}{" "}
          <button type="button" className="found-more" onClick={() => search(state.ask)}>
            Try again
          </button>
        </p>
      ) : (
        <p className="search-status" role="status">
          {state.status === "idle" && "Type to search the notes you can see: their text, todos, tags and projects."}
          {state.status === "searching" && "Searching…"}
          {listed &&
            (listed.results.length
              ? `${listed.results.length} ${listed.results.length === 1 ? "note" : "notes"}${listed.next === null ? "" : ", and more"}`
              : `No notes match “${listed.ask.query}”. ${listed.ask.includeArchived ? "Archived notes were included." : "Archived notes are left out unless you include them."}`)}
          {listed?.indexing && <span className="indexing"> {STILL_INDEXING}</span>}
        </p>
      )}
      <ul id={`${ids}-results`} className="found-list" role="listbox" aria-label="Results" aria-busy={state.status === "searching"}>
        {shown.map(({ note, matches }, i) => (
          <li key={note.id} id={optionId(i)} role="option" aria-selected={i === at} onPointerMove={() => dispatch({ type: "pointed", at: i })}>
            <a className="found-note" tabIndex={-1} {...opening(app, note)}>
              <FoundNote app={app} note={note} now={now} />
              {matches.map((match) => (
                <Line key={match.line} match={match} />
              ))}
            </a>
          </li>
        ))}
      </ul>
      {listed && listed.next !== null && (
        <div className="search-more">
          <button type="button" className="found-more" disabled={listed.more === "asking"} onClick={() => search(listed.ask, listed.next!)}>
            {listed.more === "asking" ? "Reading more…" : "More results"}
          </button>
          {typeof listed.more === "object" && <span role="alert">{listed.more.refused}</span>}
        </div>
      )}
    </section>
  );
}
