import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { forceLinting, lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, panels } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { forEditor, usable } from "./editorExtensions.ts";
import type { Host } from "./pluginHost.ts";
import { readOnly } from "./readOnly.ts";
import type { Problem } from "./settings.ts";
import { statusLabel, type SettingsStore } from "./settingsStore.ts";
import { changeBetween } from "./textChange.ts";

/** Where the member's settings JSON is open as a document of its own, in a tab. */
export const SETTINGS_FILE = "/settings.json";

export const NOT_JSON = "Settings are one JSON object, such as {}.";

/** A change that came from the store, which is no typing to hand back to it. */
const fromStore = Annotation.define<boolean>();

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

/**
 * The member's settings as JSON, in an editor drawn as a note's is, with the plugins for how an editor is worked: vim's keys,
 * typewriter scrolling, line numbers. It is no note. It is the settings store's text, so it is in no listing, search, folder
 * or export, and no agent can read it. Typing that is a JSON object is saved and applies at once. Typing that isn't is the
 * store's draft: it is marked where it stops being JSON, saved nowhere, and the settings stay as they were until it is one.
 */
export function SettingsFile({ store, host }: { store: SettingsStore; host: Host }) {
  const text = useSyncExternalStore(store.subscribe, store.text);
  const draft = useSyncExternalStore(store.subscribe, store.draft);
  const status = useSyncExternalStore(store.subscribe, store.status);
  const { settings, editorExtensions } = useSyncExternalStore(host.subscribe, host.contributions);
  const unread = status.kind === "loading" || status.kind === "unread";
  const value = draft ?? text;
  const problems = draft === null ? settings.problems : null;

  const parent = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [lock] = useState(() => new Compartment());
  const [added] = useState(() => new Compartment());
  const mine = useMemo(() => forEditor({ noteId: SETTINGS_FILE }), []);
  const { extensions, refused } = useMemo(() => mine(usable(editorExtensions.filter((e) => e.anyText)).taken), [mine, editorExtensions]);
  const now = useRef({ problems, extensions });
  now.current = { problems, extensions };

  useEffect(() => {
    const view = (viewRef.current = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: store.draft() ?? store.text(),
        extensions: [
          lock.of(readOnly),
          // Before the editor's own keys, so a plugin's keys are tried first.
          added.of(now.current.extensions),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          json(),
          jsonHighlighting,
          lintGutter(),
          linter((v) => diagnose(v.state, now.current.problems), { delay: 100 }),
          EditorView.lineWrapping,
          panels({ bottomContainer: foot.current ?? undefined }),
          EditorView.contentAttributes.of({ "aria-label": "Settings JSON" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromStore))) store.type(u.state.doc.toString());
          }),
        ],
      }),
    }));
    // Once it is on screen, for a tab the member opened: a tab is drawn before it is shown, and one drawn again in another pane on a reload
    // is not where they are. A field the member has gone to meanwhile keeps the cursor.
    const shown = requestAnimationFrame(() => location.pathname === SETTINGS_FILE && (document.activeElement === document.body || !document.activeElement) && view.focus());
    return () => {
      cancelAnimationFrame(shown);
      viewRef.current = null;
      view.destroy();
    };
  }, [store, lock, added]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const change = changeBetween(view.state.doc.toString(), value);
    // Not filtered, so the settings as they arrive reach an editor that is still locked.
    // Not in the editor's history either: an undo takes back the member's typing, never the settings as they arrived.
    if (change) view.dispatch({ changes: change, filter: false, annotations: [fromStore.of(true), Transaction.addToHistory.of(false)] });
    forceLinting(view);
  }, [value, problems]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lock.reconfigure(unread ? readOnly : []) });
  }, [unread, lock]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: added.reconfigure(extensions) });
  }, [extensions, added]);

  useEffect(() => {
    for (const [extension, err] of refused) host.fail(extension, err);
  }, [refused, host]);

  const broken = draft !== null && !unread;
  return (
    <section className="settings-file" aria-label="Settings (JSON)">
      <div className="note-scroll">
        <div className="settings-file-head">
          <p className="soon">Yours alone, in this workspace. Only what you change from a default is kept.</p>
          {(broken || settings.problems.length > 0) && (
            <ul aria-label="Problems" className="settings-problems">
              {broken ? (
                <li>The JSON can't be read. {NOT_JSON} Your settings stay as they were until it can.</li>
              ) : (
                settings.problems.map((p, i) => (
                  <li key={i} data-kind={p.kind}>
                    <code>{p.key}</code> {p.reason}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <div className="editor" ref={parent} />
      </div>
      <div className="note-foot">
        <div className="note-panels" ref={foot} />
        {status.kind === "unread" && (
          <button type="button" className="button small" onClick={() => void store.load()}>
            Try again
          </button>
        )}
        <span role="status" className="settings-file-state" data-failed={broken || status.kind === "refused" || status.kind === "unread" || undefined}>
          {broken ? "Not saved until the JSON is fixed" : statusLabel(status)}
        </span>
      </div>
    </section>
  );
}
