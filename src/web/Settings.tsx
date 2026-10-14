import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { forceLinting, lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KeyboardShortcuts } from "./KeyboardShortcuts.tsx";
import { SettingRow } from "./SettingRow.tsx";
import type { Host, MemberSettings } from "./pluginHost.ts";
import { readOnly } from "./readOnly.ts";
import { documentOf, type Problem } from "./settings.ts";
import { KEYBOARD, UNKNOWN, filterLayout, layoutOf } from "./settingsLayout.ts";
import { statusLabel, type SettingsStore } from "./settingsStore.ts";

const NOT_JSON = "Settings are one JSON object, such as {}.";

interface Props {
  host: Host;
  store: SettingsStore;
  mac: boolean;
  /** The address the app is at: `/settings`, or under it a category, such as `/settings/keyboard`, or `/settings/json`. */
  path: string;
  go: (path: string, options?: { replace?: boolean }) => void;
}

const ROOT = "/settings";
const JSON_VIEW = "json";

/**
 * Where a member changes their settings: by category, as options drawn from the schema and a table
 * of keyboard shortcuts, or as the JSON itself. All of it shows the one document. It belongs to the
 * app, so it is here whatever is turned off.
 */
export function Settings({ host, store, mac, path, go }: Props) {
  const { settings } = useSyncExternalStore(host.subscribe, host.contributions);
  const text = useSyncExternalStore(store.subscribe, store.text);
  const status = useSyncExternalStore(store.subscribe, store.status);
  const unread = status.kind === "loading" || status.kind === "unread";
  const at = path.slice(ROOT.length + 1);
  const asJson = at === JSON_VIEW;
  /** JSON the member is typing that isn't an object yet. It is kept here, unsaved, until it is one. */
  const [draft, setDraft] = useState<string | null>(null);

  const typed = (next: string) => {
    if (documentOf(next) && store.replace(next)) setDraft(null);
    else setDraft(next);
  };

  const problemList = ((draft !== null && !unread) || settings.problems.length > 0) && (
    <ul aria-label="Problems" className="settings-problems">
      {draft !== null && !unread && <li>The JSON can't be read. {NOT_JSON} Your settings stay as they were until it can.</li>}
      {(draft === null || unread) &&
        settings.problems.map((p, i) => (
          <li key={i} data-kind={p.kind}>
            <code>{p.key}</code> {p.reason}
          </li>
        ))}
    </ul>
  );

  return (
    <section className="mode-view settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <span role="status" className="save-state">
          {draft === null || unread ? statusLabel(status) : "Not saved until the JSON is fixed"}
        </span>
        <button type="button" className="button small" onClick={() => go(asJson ? ROOT : `${ROOT}/${JSON_VIEW}`)}>
          {asJson ? "Open settings (UI)" : "Open settings (JSON)"}
        </button>
      </div>
      <p className="soon">Yours alone, in this workspace. Only what you change from a default is kept.</p>
      {/* Above the JSON, where each is underlined. Under the options, where each is said at its own row too, so one that comes or goes with a change moves nothing above it. */}
      {asJson && problemList}
      {asJson ? (
        <JsonEditor value={draft ?? text} problems={draft === null ? settings.problems : null} locked={unread} onChange={typed} />
      ) : (
        <Options settings={settings} locked={unread ? "unread" : draft !== null ? "json" : null} mac={mac} picked={at} go={go} onSet={host.setSetting} />
      )}
      {!asJson && problemList}
    </section>
  );
}

interface OptionsProps {
  settings: MemberSettings;
  /** Why nothing can be changed here: the JSON can't be read, or the stored settings haven't been. */
  locked: "json" | "unread" | null;
  mac: boolean;
  /** The category the address names. One that isn't there reads as the first. */
  picked: string;
  go: Props["go"];
  onSet: Host["setSetting"];
}

/** One entry of the list of categories: where it goes, and how much of what is searched for it holds. */
interface Entry {
  id: string;
  name: string;
  /** Null when nothing is searched for. */
  found: number | null;
}

function Options({ settings, locked, mac, picked, go, onSet }: OptionsProps) {
  const [typed, setTyped] = useState("");
  const [modified, setModified] = useState(false);
  /** Whether the member picked one category out of what a search found. Searching again shows them all. */
  const [narrowed, setNarrowed] = useState(false);
  const needle = typed.trim().toLowerCase();
  const filtering = needle !== "" || modified;

  const whole = layoutOf(settings);
  const found = filtering ? filterLayout(whole, { needle, modified }, settings.document, mac) : whole;
  const unknown = filtering ? [] : settings.problems.filter((p) => p.kind === "unknown");
  const count = (id: string) => (id === KEYBOARD.id ? found.shortcuts.length : (found.categories.find((c) => c.id === id)?.rows.length ?? 0));
  const entry = ({ id, name }: { id: string; name: string }): Entry => ({ id, name, found: filtering ? count(id) : null });
  const listed = (plugins: boolean) => found.categories.filter((c) => (c.pluginId !== null) === plugins).map(entry);
  const own = [...listed(false), ...(found.shortcuts.length > 0 ? [entry(KEYBOARD)] : [])];
  const plugins = listed(true);
  const rest = unknown.length > 0 ? [entry(UNKNOWN)] : [];
  const entries = [...own, ...plugins, ...rest];
  const all = filtering && !narrowed;
  const current = all ? null : (entries.find((e) => e.id === picked) ?? entries[0] ?? null);
  const shown = (id: string) => all || current?.id === id;
  const total = found.categories.reduce((sum, c) => sum + c.rows.length, 0) + found.shortcuts.length;

  const pick = (id: string | null) => {
    setNarrowed(id !== null);
    if (id !== null) go(`${ROOT}/${id}`, { replace: true });
  };
  const search = (next: { typed?: string; modified?: boolean }) => {
    if (next.typed !== undefined) setTyped(next.typed);
    if (next.modified !== undefined) setModified(next.modified);
    setNarrowed(false);
  };
  const link = ({ id, name, found: n }: Entry) => (
    <a
      key={id}
      href={`${ROOT}/${id}`}
      aria-current={current?.id === id ? "page" : undefined}
      aria-label={n === null ? name : `${name}, ${n} found`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        pick(id);
      }}
    >
      <span>{name}</span>
      {n !== null && <span className="settings-count">{n}</span>}
    </a>
  );
  const option = ({ id, name, found: n }: Entry) => (
    <option key={id} value={id}>
      {n === null ? name : `${name} (${n})`}
    </option>
  );

  return (
    <>
      {locked === "json" && (
        <p role="alert" className="settings-locked">
          The JSON has a mistake in it, so nothing can be changed here until it is fixed.{" "}
          <button type="button" className="button small" onClick={() => go(`${ROOT}/${JSON_VIEW}`)}>
            Show the JSON
          </button>
        </p>
      )}
      <div className="settings-tools">
        <input type="search" className="filter" aria-label="Search settings" placeholder="Search settings and keyboard shortcuts" value={typed} onChange={(e) => search({ typed: e.target.value })} />
        <button type="button" className="button small" aria-pressed={modified} title="Show only what you changed from its default" onClick={() => search({ modified: !modified })}>
          Modified
        </button>
      </div>
      <div className="settings-body">
        <nav aria-label="Categories" className="settings-nav">
          {filtering && (
            <a
              href={ROOT}
              aria-current={all ? "page" : undefined}
              aria-label={`All results, ${total} found`}
              onClick={(e) => {
                e.preventDefault();
                pick(null);
              }}
            >
              <span>All results</span>
              <span className="settings-count">{total}</span>
            </a>
          )}
          {own.map(link)}
          {plugins.length > 0 && <h2>Plugins</h2>}
          {plugins.map(link)}
          {rest.map(link)}
        </nav>
        {/* The same list for a window too narrow to keep it beside the settings. Only one of the two is ever shown. */}
        <select className="settings-pick" aria-label="Category" value={current?.id ?? ""} onChange={(e) => pick(e.target.value || null)}>
          {filtering && <option value="">All results ({total})</option>}
          {own.map(option)}
          {plugins.length > 0 && <optgroup label="Plugins">{plugins.map(option)}</optgroup>}
          {rest.map(option)}
        </select>
        <fieldset disabled={locked !== null} className="settings-pane" data-list>
          {filtering && total === 0 && <p className="soon">{modified && !needle ? "You haven't changed anything from its default." : "No setting or keyboard shortcut matches."}</p>}
          {found.categories
            .filter((c) => shown(c.id))
            .map((category) => (
              <section key={category.id} aria-label={category.name} className="settings-group">
                <h2>
                  {category.name}
                  {category.pluginId !== null && (
                    <a
                      href={`/plugins/${category.pluginId}`}
                      className="settings-about-plugin"
                      onClick={(e) => {
                        e.preventDefault();
                        go(`/plugins/${category.pluginId}`);
                      }}
                    >
                      About this plugin
                    </a>
                  )}
                </h2>
                {category.rows.some((d) => !d.active) && <p className="soon">{category.name} is off, so its options change nothing until it is turned on on the Plugins page.</p>}
                {category.rows.map((d) => (
                  <SettingRow
                    key={d.key}
                    declared={d}
                    value={settings.values[d.key]!}
                    modified={Object.hasOwn(settings.document, d.key)}
                    problems={settings.problems.filter((p) => p.key === d.key)}
                    mac={mac}
                    onSet={(value) => onSet(d.key, value)}
                  />
                ))}
              </section>
            ))}
          {shown(KEYBOARD.id) && found.shortcuts.length > 0 && (
            <section aria-label={KEYBOARD.name} className="settings-group">
              <h2>{KEYBOARD.name}</h2>
              <p className="soon">Record a key for a command by pressing it. A key you choose is taken from a command that only had it by default.</p>
              <KeyboardShortcuts shortcuts={found.shortcuts} all={whole.shortcuts} mac={mac} onSet={onSet} />
            </section>
          )}
          {shown(UNKNOWN.id) && unknown.length > 0 && (
            <section aria-label={UNKNOWN.name} className="settings-group">
              <h2>{UNKNOWN.name}</h2>
              <p className="soon">These are in your JSON and do nothing. They are kept until you remove them.</p>
              {unknown.map((p) => (
                <div key={p.key} className="setting" data-row>
                  <div className="setting-head">
                    <code>{p.key}</code>
                    <button type="button" className="button small" aria-label={`Remove ${p.key}`} onClick={() => onSet(p.key, undefined)}>
                      Remove
                    </button>
                  </div>
                  <p className="error">{p.reason}</p>
                </div>
              ))}
            </section>
          )}
        </fieldset>
      </div>
    </>
  );
}

const external = Annotation.define<boolean>();

const jsonHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--accent)" },
    { tag: tags.string, color: "var(--added)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--danger)" },
  ]),
);

/** What to underline in the JSON: where it stops being JSON, or each key the schema has a problem with. */
function diagnose(state: EditorState, problems: readonly Problem[] | null): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
  if (!problems) {
    const broken: { from: number; to: number }[] = [];
    tree.iterate({ enter: (node) => void (node.type.isError && broken.push({ from: node.from, to: node.to })) });
    const at = broken[0];
    // A mistake at the very end has no text of its own, so the character before it is marked.
    const to = at ? Math.min(Math.max(at.to, at.from + 1), state.doc.length) : state.doc.length;
    const from = at ? Math.min(at.from, Math.max(0, to - 1)) : 0;
    return [{ from, to, severity: "error", message: at ? `This isn't JSON from here. ${NOT_JSON}` : NOT_JSON }];
  }
  const found: Diagnostic[] = [];
  for (let property = tree.topNode.firstChild?.firstChild; property; property = property.nextSibling) {
    const name = property.getChild("PropertyName");
    const value = property.lastChild;
    if (!name || !value) continue;
    const key = JSON.parse(state.sliceDoc(name.from, name.to)) as string;
    for (const p of problems.filter((p) => p.key === key)) {
      const on = p.kind === "unknown" ? name : value;
      found.push({ from: on.from, to: on.to, severity: p.kind === "invalid" ? "error" : "warning", message: p.reason });
    }
  }
  return found;
}

interface JsonProps {
  value: string;
  /** The schema's problems with `value`, or null when it isn't a JSON object and so has only that one. */
  problems: readonly Problem[] | null;
  /**
   * Whether nothing can be typed, as while the stored settings haven't been read: what was typed
   * then couldn't be saved, and kept as a draft it would be written over them a key after they came.
   */
  locked: boolean;
  onChange: (text: string) => void;
}

function JsonEditor({ value, problems, locked, onChange }: JsonProps) {
  const [lock] = useState(() => new Compartment());
  const parent = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const now = useRef({ value, problems, onChange });
  now.current = { value, problems, onChange };

  useEffect(() => {
    const view = (viewRef.current = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: now.current.value,
        extensions: [
          lock.of(locked ? readOnly : []),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          json(),
          jsonHighlighting,
          lintGutter(),
          linter((v) => diagnose(v.state, now.current.problems), { delay: 100 }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Settings JSON" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) now.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    }));
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Not filtered, so the settings as they arrive reach an editor that is still locked.
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, filter: false, annotations: external.of(true) });
    forceLinting(view);
  }, [value, problems]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lock.reconfigure(locked ? readOnly : []) });
  }, [locked, lock]);

  return <div className="settings-json" ref={parent} />;
}
