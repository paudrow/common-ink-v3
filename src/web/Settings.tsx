import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { forceLinting, lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { chordLabel } from "./keybindings.ts";
import type { Setting, SettingValue } from "./plugin-api.ts";
import type { Host, MemberSettings } from "./pluginHost.ts";
import { documentOf, readSetting, type Declared, type Problem } from "./settings.ts";
import type { SettingsStatus, SettingsStore } from "./settingsStore.ts";

const statusLabel = (status: SettingsStatus) => {
  switch (status.kind) {
    case "loading":
      return "Loading your settings…";
    case "unread":
      return "Your settings couldn't be loaded, so nothing can be changed here";
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "retrying":
      return "Couldn't save. Retrying…";
    case "refused":
      return `Not saved, and put back as it was: ${status.message}`;
  }
};
const NOT_JSON = "Settings are one JSON object, such as {}.";

interface Props {
  host: Host;
  store: SettingsStore;
  mac: boolean;
}

/**
 * Where a member changes their settings: as options drawn from the schema, or as the JSON itself.
 * Both show the one document. It belongs to the app, so it is here whatever is turned off.
 */
export function Settings({ host, store, mac }: Props) {
  const ids = useId();
  const { settings } = useSyncExternalStore(host.subscribe, host.contributions);
  const text = useSyncExternalStore(store.subscribe, store.text);
  const status = useSyncExternalStore(store.subscribe, store.status);
  const unread = status.kind === "loading" || status.kind === "unread";
  const [view, setView] = useState<"options" | "json">("options");
  /** JSON the member is typing that isn't an object yet. It is kept here, unsaved, until it is one. */
  const [draft, setDraft] = useState<string | null>(null);

  const typed = (next: string) => {
    if (documentOf(next) && store.replace(next)) setDraft(null);
    else setDraft(next);
  };

  return (
    <section className="mode-view settings">
      <h1>Settings</h1>
      <p className="soon">Yours alone, in this workspace. Only what you change from a default is kept, and you can change it here or as JSON.</p>
      <div className="settings-bar">
        <div role="tablist" aria-label="Views of your settings" className="tabs">
          {(["options", "json"] as const).map((v) => (
            <button key={v} type="button" role="tab" id={`${ids}-${v}`} aria-selected={view === v} aria-controls={`${ids}-panel`} onClick={() => setView(v)}>
              {v === "options" ? "Options" : "JSON"}
            </button>
          ))}
        </div>
        <span role="status" className="save-state">
          {draft === null || unread ? statusLabel(status) : "Not saved until the JSON is fixed"}
        </span>
      </div>
      {((draft !== null && !unread) || settings.problems.length > 0) && (
        <ul aria-label="Problems" className="settings-problems">
          {draft !== null && !unread && <li>The JSON can't be read. {NOT_JSON} Your settings stay as they were until it can.</li>}
          {(draft === null || unread) &&
            settings.problems.map((p, i) => (
              <li key={i} data-kind={p.kind}>
                <code>{p.key}</code> {p.reason}
              </li>
            ))}
        </ul>
      )}
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${view}`}>
        {view === "options" ? (
          <Options settings={settings} locked={unread ? "unread" : draft !== null ? "json" : null} mac={mac} onSet={host.setSetting} onShowJson={() => setView("json")} />
        ) : (
          <JsonEditor value={draft ?? text} problems={draft === null ? settings.problems : null} onChange={typed} />
        )}
      </div>
    </section>
  );
}

const describe = (setting: Setting, value: SettingValue, mac: boolean) => {
  if (setting.type === "boolean") return value ? "on" : "off";
  if (setting.type === "chords") return (value as readonly string[]).map((chord) => chordLabel(chord, mac)).join(", ") || "no key";
  return String(value);
};

interface OptionsProps {
  settings: MemberSettings;
  /** Why nothing can be changed here: the JSON can't be read, or the stored settings haven't been. */
  locked: "json" | "unread" | null;
  mac: boolean;
  onSet: Host["setSetting"];
  onShowJson: () => void;
}

function Options({ settings, locked, mac, onSet, onShowJson }: OptionsProps) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = settings.declared.filter((d) => !needle || `${d.setting.title}\n${d.key}\n${d.group.name}`.toLowerCase().includes(needle));
  const groups = [...new Map(shown.map((d) => [d.group.id, d.group])).values()];
  const unknown = settings.problems.filter((p) => p.kind === "unknown");

  return (
    <>
      {locked === "json" && (
        <p role="alert" className="settings-locked">
          The JSON has a mistake in it, so nothing can be changed here until it is fixed.{" "}
          <button type="button" className="button small" onClick={onShowJson}>
            Show the JSON
          </button>
        </p>
      )}
      <input type="search" className="filter" aria-label="Filter settings" placeholder={`Filter ${settings.declared.length} settings`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <fieldset disabled={locked !== null} className="settings-groups">
        {groups.map((group) => {
          const rows = shown.filter((d) => d.group.id === group.id);
          return (
            <section key={group.id} aria-label={group.name} className="settings-group">
              <h2>{group.name}</h2>
              {rows.some((d) => !d.active) && <p className="soon">{group.name} is off, so its options change nothing until it is on.</p>}
              {rows.map((d) => (
                <Row
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
          );
        })}
        {unknown.length > 0 && !needle && (
          <section aria-label="Not recognized" className="settings-group">
            <h2>Not recognized</h2>
            <p className="soon">These are in your JSON and do nothing. They are kept until you remove them.</p>
            {unknown.map((p) => (
              <div key={p.key} className="setting">
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
    </>
  );
}

interface RowProps {
  declared: Declared;
  value: SettingValue;
  /** Whether the member's document has this key, valid or not. */
  modified: boolean;
  problems: readonly Problem[];
  mac: boolean;
  onSet: (value: SettingValue | undefined) => void;
}

function Row({ declared: { key, setting, active }, value, modified, problems, mac, onSet }: RowProps) {
  const id = useId();
  const [refused, setRefused] = useState<string | null>(null);
  const set = (next: unknown) => {
    const read = readSetting(setting, next);
    setRefused("reason" in read ? read.reason : null);
    if ("value" in read) onSet(read.value);
  };
  const control = { id, "aria-invalid": refused !== null || problems.some((p) => p.kind === "invalid") || undefined, "aria-describedby": `${id}-about` };

  return (
    <div className="setting" data-modified={modified || undefined} data-inactive={!active || undefined}>
      <div className="setting-head">
        <label htmlFor={id}>{setting.title}</label>
        <code>{key}</code>
      </div>
      {setting.description && <p className="setting-about">{setting.description}</p>}
      <div className="setting-control">
        {setting.type === "boolean" ? (
          <input type="checkbox" {...control} checked={value as boolean} onChange={(e) => set(e.target.checked)} />
        ) : setting.type === "string" && setting.enum ? (
          <select {...control} value={value as string} onChange={(e) => set(e.target.value)}>
            {setting.enum.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <Typed key={JSON.stringify(value)} control={control} setting={setting} value={value} onSet={set} />
        )}
        <span id={`${id}-about`} className="setting-default">
          {setting.type === "chords" && `${describe(setting, value, mac)}. `}Default: {describe(setting, setting.default, mac)}
        </span>
        {modified && (
          <button type="button" className="button small" aria-label={`Reset ${setting.title}`} onClick={() => (setRefused(null), onSet(undefined))}>
            Reset
          </button>
        )}
      </div>
      {refused && <p className="error">{refused}. Nothing was changed.</p>}
      {problems.map((p, i) => (
        <p key={i} className="error">
          {p.reason}
        </p>
      ))}
    </div>
  );
}

/** A setting that is typed: it is set when the member presses Enter or leaves the field, not on each key. */
function Typed({ control, setting, value, onSet }: { control: object; setting: Setting; value: SettingValue; onSet: (value: unknown) => void }) {
  const written = setting.type === "chords" ? (value as readonly string[]).join(", ") : String(value);
  const [typed, setTyped] = useState(written);
  const numeric = setting.type === "number" || setting.type === "integer";
  const commit = () => {
    if (typed === written) return;
    if (setting.type === "chords") onSet(typed.split(",").map((chord) => chord.trim()).filter(Boolean));
    else onSet(numeric ? (typed.trim() === "" ? null : Number(typed)) : typed);
  };
  return (
    <input
      {...control}
      type={numeric ? "number" : "text"}
      min={numeric ? setting.minimum : undefined}
      max={numeric ? setting.maximum : undefined}
      placeholder={setting.type === "chords" ? "mod+shift+k" : undefined}
      value={typed}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
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
  onChange: (text: string) => void;
}

function JsonEditor({ value, problems, onChange }: JsonProps) {
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
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: external.of(true) });
    forceLinting(view);
  }, [value, problems]);

  return <div className="settings-json" ref={parent} />;
}
