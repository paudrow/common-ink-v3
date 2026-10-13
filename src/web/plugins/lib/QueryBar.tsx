import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon, MAX_SEARCH_LENGTH, filterOf, keyNamed, keysFor, keysStarting, parseQuery, querySyntax, typingAt, wordsFor, writtenValue, type App, type Cmp, type FilterKey, type PluginHost, type QueryIn, type QueryKey, type QueryScope, type SortKey } from "../../plugin-api.ts";
import { builderReducer, readBuilder, termOf, withKey, type BuilderEvent, type Row } from "./queryRows.ts";

/** How long the field rests before a query that can't be read says so: a filter half typed is no mistake yet. */
const REST_MS = 700;
const MAX_OFFERS = 8;
const RELATIVE_DAYS = ["today", "yesterday", "tomorrow", "7d", "+7d"];

/** One thing offered while typing: what it reads as, what it means, and what it puts in the field. */
interface Offer {
  label: string;
  detail?: string;
  insert: string;
}

/** The names a query can be completed and built with, each read once it is first wanted: all of them are what the member can already list. */
interface Names {
  folders: { label: string; value: string }[];
  tags: string[];
  people: string[];
}

function useNames(host: PluginHost, app: App, scope: QueryScope, wanted: boolean): Names {
  const [read, setRead] = useState<{ tags: string[]; people: string[] }>({ tags: [], people: [] });
  useEffect(() => {
    if (!wanted) return;
    let left = false;
    const tags = scope === "todos" ? host.perform({ type: "todo.filters", includeArchived: true }).then((r) => [...r.tags]) : host.perform({ type: "tag.list", includeArchived: true }).then((r) => r.tags.map((t) => t.name));
    const people = host.perform({ type: "history.authors" }).then((authors) => [...new Set(authors.map((a) => a.name))]);
    // A list that can't be read leaves nothing to offer, and the query is still typed by hand.
    void Promise.all([tags.catch(() => []), people.catch(() => [])]).then(([t, p]) => !left && setRead({ tags: t, people: p }));
    return () => {
      left = true;
    };
  }, [host, scope, wanted]);
  const folders = useMemo(() => {
    const all = [...(app.folders?.byId.values() ?? [])];
    const count = new Map<string, number>();
    for (const f of all) count.set(f.name.toLowerCase(), (count.get(f.name.toLowerCase()) ?? 0) + 1);
    // A name two folders have, or one that can't be written in quotes, is said by the folder's id.
    return all.map((f) => ({ label: app.folders!.pathName(f.id), value: count.get(f.name.toLowerCase()) === 1 && !f.name.includes('"') ? f.name : f.id })).sort((a, b) => a.label.localeCompare(b.label));
  }, [app.folders]);
  return { folders, tags: read.tags, people: ["@me", ...read.people] };
}

/** The values a filter can be given, as what is shown and what is written. */
function valuesOf(key: QueryKey, scope: QueryScope, names: Names): { label: string; value: string; detail?: string }[] {
  const { value } = filterOf(key);
  if (value.type === "words") return wordsFor(key, scope).map((w) => ({ label: w.word, value: w.word, detail: w.means }));
  if (value.type === "number") return Array.from({ length: value.max - value.min + 1 }, (_, i) => ({ label: String(value.min + i), value: String(value.min + i) }));
  if (value.type === "day") return RELATIVE_DAYS.map((day) => ({ label: day, value: day }));
  if (value.type === "folder") return names.folders;
  return (value.type === "tag" ? names.tags : names.people).map((name) => ({ label: name, value: name }));
}

function offersAt(text: string, cursor: number, scope: QueryScope, names: Names): { from: number; to: number; offers: Offer[] } | null {
  const typing = typingAt(text, cursor, scope);
  if (!typing) return null;
  const { from, to, key, typed, lead } = typing;
  if (key === null) {
    const offers = keysStarting(typed, scope).map((name): Offer => ({ label: `${name}:`, detail: name === "no" ? "What it lacks: the same as -has:" : filterOf(keyNamed(name)!).means, insert: `${name}:` }));
    return offers.length ? { from, to, offers } : null;
  }
  const wanted = typed.toLowerCase();
  const offers = valuesOf(key, scope, names)
    // What is typed starts the value, or a word of what it is shown as, such as a folder along a path.
    .filter((v) => v.value.toLowerCase().startsWith(wanted) || v.label.toLowerCase().split(/[\s/]+/).some((word) => word.startsWith(wanted)))
    .filter((v) => v.value.toLowerCase() !== wanted)
    .slice(0, MAX_OFFERS)
    .map((v): Offer => ({ label: v.label, detail: v.detail, insert: `${lead === "#" ? "#" : ""}${lead === "#" ? v.value : writtenValue(v.value)} ` }));
  return offers.length ? { from, to, offers } : null;
}

const FIELD_NAMES: Partial<Record<FilterKey | "text", string>> = { text: "Words", is: "State", has: "Has" };
const fieldName = (key: FilterKey | "text") => FIELD_NAMES[key] ?? key[0]!.toUpperCase() + key.slice(1);
const COMPARISONS: { id: Cmp | "between"; label: string }[] = [
  { id: "=", label: "on" },
  { id: ">", label: "after" },
  { id: ">=", label: "on or after" },
  { id: "<", label: "before" },
  { id: "<=", label: "on or before" },
  { id: "between", label: "between" },
];

interface ValueProps {
  row: Row;
  scope: QueryScope;
  names: Names;
  label: string;
  value: string;
  onChange: (value: string) => void;
  listId: string;
  /** The element that says why the row can't be read, when it can't. */
  whyId: string | undefined;
}

function ValueField({ row, scope, names, label, value, onChange, listId, whyId }: ValueProps) {
  const wrong = { "aria-invalid": whyId ? true : undefined, "aria-describedby": whyId };
  if (row.key === "text") return <input type="text" aria-label={label} placeholder="words to find" value={value} onChange={(e) => onChange(e.target.value)} {...wrong} />;
  const kind = filterOf(row.key).value.type;
  const values = valuesOf(row.key, scope, names);
  if (kind === "words" || kind === "number" || kind === "folder") {
    const offered = value && !values.some((v) => v.value === value) ? [...values, { label: value, value }] : values;
    return (
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} {...wrong}>
        <option value="">Choose…</option>
        {offered.map((v) => (
          <option key={v.value} value={v.value} title={v.detail}>
            {v.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <input type="text" aria-label={label} list={listId} placeholder={kind === "day" ? "YYYY-MM-DD or today" : kind === "tag" ? "tag" : "name"} value={value} onChange={(e) => onChange(e.target.value)} {...wrong} />
      <datalist id={listId}>
        {values.map((v) => (
          <option key={v.value} value={v.value} />
        ))}
      </datalist>
    </>
  );
}

function Condition({ row, at, scope, names, act }: { row: Row; at: number; scope: QueryScope; names: Names; act: (event: BuilderEvent) => void }) {
  const ids = useId();
  const set = (change: Partial<Row>) => act({ type: "set", at, row: { ...row, ...change } });
  const compares = row.key !== "text" && filterOf(row.key).compares;
  const keys = keysFor(scope).filter((key) => !filterOf(key).top) as FilterKey[];
  const between = row.to !== undefined;
  const term = termOf(row, scope);
  const why = term && "why" in term ? term.why : null;
  return (
    <li className="query-row" role="group" aria-label={`Condition ${at + 1}`}>
      <select aria-label="Field" value={row.key} onChange={(e) => act({ type: "set", at, row: withKey(row, e.target.value as Row["key"]) })}>
        <option value="text">Words</option>
        {keys.map((key) => (
          <option key={key} value={key} title={filterOf(key).means}>
            {fieldName(key)}
          </option>
        ))}
      </select>
      <select aria-label="Is or is not" value={row.not ? "not" : "is"} onChange={(e) => set({ not: e.target.value === "not" })}>
        <option value="is">is</option>
        <option value="not">is not</option>
      </select>
      {compares && (
        <select
          aria-label="Comparison"
          value={between ? "between" : row.cmp}
          onChange={(e) => {
            const rest: Row = { key: row.key, not: row.not, cmp: row.cmp, value: row.value };
            act({ type: "set", at, row: e.target.value === "between" ? { ...rest, cmp: "=", to: row.to ?? "" } : { ...rest, cmp: e.target.value as Cmp } });
          }}
        >
          {COMPARISONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <ValueField row={row} scope={scope} names={names} label="Value" value={row.value} onChange={(value) => set({ value })} listId={`${ids}-values`} whyId={why ? `${ids}-why` : undefined} />
      {between && <ValueField row={row} scope={scope} names={names} label="To" value={row.to ?? ""} onChange={(to) => set({ to })} listId={`${ids}-to`} whyId={why ? `${ids}-why` : undefined} />}
      <button type="button" className="icon-button" aria-label={`Remove condition ${at + 1}`} title="Remove" onClick={() => act({ type: "remove", at })}>
        <Icon name="close" />
      </button>
      {why && (
        <p id={`${ids}-why`} className="query-why">
          {why}
        </p>
      )}
    </li>
  );
}

const UNSHOWN = {
  nested: "This query has groups, or AND and OR together, which rows can't show. It stays as it is typed: change it in the bar.",
  unread: "The query in the bar can't be read yet. Put it right there to build on it here.",
};

interface PanelProps {
  id: string;
  scope: QueryScope;
  text: string;
  names: Names;
  /** Puts a query in the bar and runs it. */
  run: (text: string) => void;
  close: () => void;
}

/** The builder: the bar's query as rows, each change written back to the bar, and the help. */
function Advanced({ id, scope, text, names, run, close }: PanelProps) {
  const ids = useId();
  const [builder, setBuilder] = useState(() => readBuilder(scope, text));
  const [helping, setHelping] = useState(false);
  // What is typed in the bar is read into the rows as it changes.
  if (builder.text !== text) setBuilder(builderReducer(builder, { type: "read", text }));
  const act = (event: BuilderEvent) => {
    const next = builderReducer(builder, event);
    setBuilder(next);
    if (next.text !== text) run(next.text);
  };
  const built = builder.built ?? (text.trim() ? null : { rows: [], match: "all" as const, in: [], sort: null });
  const looked = built?.in.length === 1 ? built.in[0]! : "";
  return (
    <div
      id={id}
      className="query-panel"
      role="group"
      aria-label={scope === "todos" ? "Advanced filter" : "Advanced search"}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close();
      }}
    >
      <header>
        <strong>Build a query</strong>
        <span>Each change is written in the bar.</span>
        <button type="button" className="icon-button query-help-toggle" aria-label="Query syntax" title="Query syntax" aria-expanded={helping} aria-controls={`${ids}-help`} onClick={() => setHelping(!helping)}>
          ?
        </button>
      </header>
      {helping && (
        <div id={`${ids}-help`} className="query-help" role="region" aria-label="Query syntax">
          <p>Everything the bar reads. Press an example to try it.</p>
          <table>
            <tbody>
              {querySyntax(scope).map((row) => (
                <tr key={row.form}>
                  <th scope="row">
                    <code>{row.form}</code>
                  </th>
                  <td>{row.means}</td>
                  <td>
                    <button type="button" className="query-example" title="Try this query" onClick={() => run(row.example)}>
                      {row.example}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {built ? (
        <>
          <ul className="query-rows">
            {built.rows.map((row, at) => (
              <Condition key={at} row={row} at={at} scope={scope} names={names} act={act} />
            ))}
          </ul>
          <div className="query-foot">
            <button type="button" className="button small" data-autofocus onClick={() => act({ type: "add" })}>
              <Icon name="plus" />
              Add a condition
            </button>
            <div role="radiogroup" aria-label="Match" className="segmented">
              {(["all", "any"] as const).map((match) => (
                <label key={match}>
                  <input type="radio" name={`${ids}-match`} checked={built.match === match} onChange={() => act({ type: "match", match })} />
                  <span>Match {match}</span>
                </label>
              ))}
            </div>
            <label>
              Words in
              <select aria-label="Words in" value={looked} onChange={(e) => act({ type: "in", in: e.target.value ? [e.target.value as QueryIn] : [] })}>
                <option value="">{scope === "todos" ? "the todo" : "title or text"}</option>
                <option value="title">the note's title</option>
                {scope === "notes" && <option value="body">the text</option>}
              </select>
            </label>
            <label>
              Sort
              <select aria-label="Sort" value={built.sort ?? ""} onChange={(e) => act({ type: "sort", sort: (e.target.value || null) as SortKey | null })}>
                <option value="">{scope === "todos" ? "Soonest due" : "Best match"}</option>
                {wordsFor("sort", scope).map((w) => (
                  <option key={w.word} value={w.word}>
                    {w.means}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : (
        <p className="query-unshown">{UNSHOWN[builder.unshown ?? "unread"]}</p>
      )}
    </div>
  );
}

export interface QueryBarProps {
  host: PluginHost;
  app: App;
  scope: QueryScope;
  /** What is in the field. */
  value: string;
  /** `set` when the whole query was put there at once, by the builder, an example or a completion's last word, and is to be run with no pause. */
  onChange: (text: string, how: "typed" | "set") => void;
  label: string;
  placeholder: string;
  /** What is shown in the field before what is typed, as the folder a search is of. */
  lead?: ReactNode;
  fieldRef?: Ref<HTMLInputElement>;
  /** Keys the field leaves to whoever holds it: every key while nothing is offered, and all but the ones that pick an offer while something is. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** What the server said of a query that reads and can't be answered, such as a folder nobody has. */
  problem?: string | null;
}

/**
 * The one field a query is typed in, for notes and for todos. It is a plain text field: it offers
 * the filter or the value being typed, says quietly under it where a query can't be read, and has
 * Advanced beside it, which opens the builder and the help.
 */
export function QueryBar({ host, app, scope, value, onChange, label, placeholder, lead, fieldRef, onKeyDown, problem }: QueryBarProps) {
  const ids = useId();
  const field = useRef<HTMLInputElement | null>(null);
  const advanced = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  /** The text whose offers were dismissed, so they stay away until it changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [rested, setRested] = useState(true);
  const caret = useRef<number | null>(null);
  const typing = cursor === null ? null : typingAt(value, cursor, scope);
  const typed = typing?.key ? filterOf(typing.key).value.type : null;
  // Tags and people are asked of the server only once something is about to offer them.
  const names = useNames(host, app, scope, open || typed === "tag" || typed === "person");

  useEffect(() => {
    setRested(false);
    const timer = setTimeout(() => setRested(true), REST_MS);
    return () => clearTimeout(timer);
  }, [value]);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    field.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const offered = cursor !== null && dismissed !== value ? offersAt(value, cursor, scope, names) : null;
  const at = offered && active !== null && active < offered.offers.length ? active : null;
  const parsed = useMemo(() => parseQuery(value, scope), [value, scope]);
  const error = !parsed.ok && (rested || cursor === null) ? parsed.error : null;

  const accept = (offer: Offer) => {
    if (!offered) return;
    const next = value.slice(0, offered.from) + offer.insert + value.slice(offered.to);
    caret.current = offered.from + offer.insert.length;
    setCursor(caret.current);
    setActive(null);
    // A filter's name is half a filter, so the field waits for its value. A value finishes it.
    onChange(next.slice(0, MAX_SEARCH_LENGTH), offer.insert.endsWith(":") ? "typed" : "set");
    field.current?.focus();
  };

  return (
    <div className="query-bar">
      <div className="query-line">
        <div className="finder-field">
          <Icon name="search" />
          {lead}
          <input
            ref={(el) => {
              field.current = el;
              if (typeof fieldRef === "function") fieldRef(el);
              else if (fieldRef) fieldRef.current = el;
            }}
            type="search"
            aria-label={label}
            aria-autocomplete="list"
            aria-controls={offered ? `${ids}-offers` : undefined}
            aria-activedescendant={at !== null ? `${ids}-offer-${at}` : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || problem ? `${ids}-error` : undefined}
            placeholder={placeholder}
            maxLength={MAX_SEARCH_LENGTH}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setCursor(e.target.selectionStart);
              setActive(null);
              onChange(e.target.value, "typed");
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onBlur={() => setCursor(null)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (offered) {
                const count = offered.offers.length;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive(e.key === "ArrowDown" ? (at === null ? 0 : (at + 1) % count) : at === null ? count - 1 : (at + count - 1) % count);
                  return;
                }
                // Tab takes what is offered first. Enter takes only what the arrows came to, and otherwise runs the query as typed.
                if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault();
                  accept(offered.offers[at ?? 0]!);
                  return;
                }
                if (e.key === "Enter" && at !== null) {
                  e.preventDefault();
                  accept(offered.offers[at]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setDismissed(value);
                  return;
                }
              }
              onKeyDown?.(e);
            }}
          />
        </div>
        <button ref={advanced} type="button" className="query-advanced" aria-expanded={open} aria-controls={`${ids}-panel`} onClick={() => setOpen(!open)}>
          Advanced
        </button>
        {offered && (
          <ul id={`${ids}-offers`} className="query-offers" role="listbox" aria-label="Completions">
            {offered.offers.map((offer, i) => (
              // The press is taken before the field loses the keyboard, so the offer is still there to take.
              <li key={offer.insert} id={`${ids}-offer-${i}`} role="option" aria-selected={i === at} onMouseDown={(e) => e.preventDefault()} onClick={() => accept(offer)}>
                <span>{offer.label}</span>
                {offer.detail && <small>{offer.detail}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(error || problem) && (
        <p id={`${ids}-error`} className="query-error" role="status">
          {error ? (
            <>
              {error.message}{" "}
              <code>
                {value.slice(0, error.from)}
                <mark>{value.slice(error.from, error.to) || " "}</mark>
                {value.slice(error.to)}
              </code>
            </>
          ) : (
            problem
          )}
        </p>
      )}
      {open && (
        <Advanced
          id={`${ids}-panel`}
          scope={scope}
          text={value}
          names={names}
          run={(text) => onChange(text, "set")}
          close={() => {
            setOpen(false);
            advanced.current?.focus();
          }}
        />
      )}
    </div>
  );
}
