import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chips, type Chip, type Token } from "../lib/chips.ts";

export interface Checkbox extends Token {
  checked: boolean;
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s)/;

/** The checkbox of a task list item on this line, if it is one: the `[ ]` or `[x]` after its list mark. */
export function checkboxIn(line: string, offset = 0): Checkbox[] {
  const match = TASK.exec(line);
  if (!match) return [];
  const from = offset + match[1]!.length;
  return [{ from, to: from + 3, checked: match[2] !== " " }];
}

/** A checkbox that writes `[x]` or `[ ]` when it is clicked. It knows nothing else about the line, which is the todos plugin's to draw (#18). */
const checkbox: Chip<Checkbox> = {
  id: "task",
  find: checkboxIn,
  keepsWidth: true,
  draw(el, token, source) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = token.checked;
    box.disabled = source.readOnly;
    box.setAttribute("aria-label", token.checked ? "Done" : "Not done");
    box.addEventListener("change", () => source.rewrite(box.checked ? "[x]" : "[ ]"));
    el.append(box);
  },
};

const look = EditorView.baseTheme({
  ".md-chip-task input": { margin: "0", width: "0.85em", height: "0.85em", accentColor: "var(--accent)", cursor: "pointer" },
});

export const taskCheckboxes: Extension = [chips(checkbox), look];
