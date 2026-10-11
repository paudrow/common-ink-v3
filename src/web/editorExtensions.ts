import { EditorState, type Extension } from "@codemirror/state";
import type { EditorContext, EditorExtension } from "./plugin-api.ts";

/** An editor extension that was left out, with why, to hold against its plugin. */
export type Refused = [added: EditorExtension, error: unknown];

/** Throws for a value CodeMirror won't take, where an editor handed it would not start. */
function checked(extension: unknown): Extension {
  EditorState.create({ extensions: extension as Extension });
  return extension as Extension;
}

function sift<T>(added: readonly EditorExtension[], take: (one: EditorExtension) => T): { taken: T[]; refused: Refused[] } {
  const taken: T[] = [];
  const refused: Refused[] = [];
  for (const one of added) {
    try {
      taken.push(take(one));
    } catch (err) {
      refused.push([one, err]);
    }
  }
  return { taken, refused };
}

/** What can go on to the editors: each value CodeMirror takes, and every function, which is checked for each editor it is called for. */
export const usable = (added: readonly EditorExtension[]) => sift(added, (one) => (typeof one.extension === "function" || checked(one.extension), one));

/**
 * Reads what one editor is given, of the extensions `usable` let through. A function is called once
 * for the editor, however often its extensions are read again, so the state of what it built isn't
 * lost each time some plugin adds something. One that throws, or makes what CodeMirror won't take, is
 * left out of this editor.
 */
export function forEditor(editor: EditorContext): (added: readonly EditorExtension[]) => { extensions: Extension[]; refused: Refused[] } {
  const made = new WeakMap<EditorExtension, { extension: Extension } | { error: unknown }>();
  const make = ({ extension }: EditorExtension) => {
    if (typeof extension !== "function") return { extension: extension as Extension };
    try {
      return { extension: checked(extension(editor)) };
    } catch (error) {
      return { error };
    }
  };
  return (added) => {
    const { taken, refused } = sift(added, (one) => {
      const result = made.get(one) ?? make(one);
      made.set(one, result);
      if ("error" in result) throw result.error;
      return result.extension;
    });
    return { extensions: taken, refused };
  };
}
