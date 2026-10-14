import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chips, type Chip, type Token } from "../lib/chips.ts";
import { BOX_EM } from "./lists.ts";

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

/**
 * A checkbox that writes `[x]` or `[ ]` when it is clicked. It is drawn over the `[ ]` it stands for, larger than that is wide,
 * and a press anywhere on its row's height and a little to either side of it is a press on it. It knows nothing else about
 * the line, which is the todos plugin's to draw (#18).
 */
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
    // The keyboard stays in the note: a box ticked with the pointer is not somewhere the next key goes.
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (event.target !== box) box.click();
    });
    // The tick is an element of its own, so it is painted in the theme's ink.
    el.append(box, document.createElement("i"));
  },
};

const look = EditorView.baseTheme({
  // Drawn here and not by the browser, so it is one size and one look on every system, in light and in dark. It is as wide
  // as the box, and so is the `[ ]`, `[x]` or `[X]` it stands for when that is shown as written, so neither moves the words.
  ".md-chip.md-chip-task": { width: `${BOX_EM}em` },
  ".md-chip.md-chip-task > :last-child": { inset: "0 -0.35em", paddingLeft: "0.35em", justifyContent: "flex-start", cursor: "pointer" },
  ".md-chip-task input": {
    appearance: "none",
    boxSizing: "border-box",
    flex: "none",
    margin: "0",
    width: `${BOX_EM}em`,
    height: `${BOX_EM}em`,
    font: "inherit",
    border: "1.5px solid color-mix(in srgb, var(--muted) 75%, transparent)",
    borderRadius: "0.28em",
    backgroundColor: "var(--bg-elev)",
    cursor: "pointer",
  },
  ".md-chip-task:hover input:enabled": { borderColor: "var(--accent)" },
  ".md-chip-task input:checked": { borderColor: "var(--accent)", backgroundColor: "var(--accent)" },
  ".md-chip-task i": { display: "none", position: "absolute", left: "50%", top: "50%", width: "0.3em", height: "0.58em", margin: "-0.37em 0 0 -0.15em", boxSizing: "border-box", border: "solid var(--on-accent)", borderWidth: "0 0.13em 0.13em 0", transform: "rotate(45deg)", pointerEvents: "none" },
  ".md-chip-task input:checked + i": { display: "block" },
  ".md-chip-task input:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
  ".md-chip-task input:disabled": { cursor: "default", opacity: "0.7" },
  ".md-chip-task:has(input:disabled) > :last-child": { cursor: "default" },
});

export const taskCheckboxes: Extension = [chips(checkbox), look];
