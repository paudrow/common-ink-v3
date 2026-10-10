import { ChangeSet, Text, type ChangeSpec } from "@codemirror/state";
import diff from "fast-diff";

export const toDoc = (text: string) => Text.of(text.split("\n"));

/** The edit that turns `from` into `to`, as a CodeMirror change set over `from`. */
export function changesBetween(from: string, to: string): ChangeSet {
  const specs: ChangeSpec[] = [];
  let pos = 0;
  for (const [kind, chunk] of diff(from, to)) {
    if (kind === diff.INSERT) {
      specs.push({ from: pos, insert: chunk });
    } else {
      if (kind === diff.DELETE) specs.push({ from: pos, to: pos + chunk.length });
      pos += chunk.length;
    }
  }
  return ChangeSet.of(specs, from.length);
}

export const applyChanges = (changes: ChangeSet, text: string) => changes.apply(toDoc(text)).toString();
