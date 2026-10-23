import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages as known } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { withSpaceRuns } from "./plugins/lib/markdownSpaces.ts";

export interface CodeOptions {
  /** The file's name, which says what language it is in. */
  path: string;
  text: string;
  label: string;
  /** Told the text as it is after each change made in it. Without it the file is only read. */
  onChange?: (text: string) => void;
  onSave?: () => void;
}

export interface Shown {
  /** Puts `text` in the place of what is shown, which `onChange` is not told of. */
  set: (text: string) => void;
  destroy: () => void;
}

const external = Annotation.define<boolean>();

/** One file of a plugin's source in the app's editor library, in its language's colors, to read or to change. */
export function codeView(parent: HTMLElement, { path, text, label, onChange, onSave }: CodeOptions): Shown {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        language.of(path.endsWith(".json") ? json() : []),
        syntaxHighlighting(classHighlighter),
        EditorView.contentAttributes.of({ "aria-label": label, ...(!onChange && { "aria-readonly": "true", tabindex: "0" }) }),
        onChange
          ? [
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) onChange(u.state.doc.toString());
              }),
            ]
          : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      ],
    }),
  });
  // The app takes Mod-s for itself on the window, before the editor is asked, and stops it there. So it is listened for there too.
  const saving = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !(e.target instanceof Node) || !view.dom.contains(e.target)) return;
    e.preventDefault();
    onSave?.();
  };
  if (onSave) addEventListener("keydown", saving, true);
  let destroyed = false;
  const description = path.endsWith(".json") ? null : LanguageDescription.matchFilename(withSpaceRuns(known), path);
  // A grammar that can't be fetched leaves the file in one color, which is still the file.
  description?.load().then(
    (support) => void (destroyed || view.dispatch({ effects: language.reconfigure(support) })),
    () => {},
  );
  return {
    set: (next) => {
      if (view.state.doc.toString() !== next) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, annotations: external.of(true) });
    },
    destroy: () => {
      destroyed = true;
      removeEventListener("keydown", saving, true);
      view.destroy();
    },
  };
}
