import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { drawnInView, inCode, redraw } from "../lib/live.ts";

/**
 * What stands before a list item's own words on its line: the indent, the mark, the space after it,
 * and a task's `[ ]`. Nothing for a line that isn't the first of an item.
 */
export function leadIn(line: string): string {
  return /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line)?.[0] ?? "";
}

/** `lead` with each tab as the spaces it takes, since a tab is as wide as the room to the next stop and not a letter of the font. */
export function spaced(lead: string, tabSize: number): string {
  let out = "";
  for (const ch of lead) out += ch === "\t" ? " ".repeat(tabSize - (out.length % tabSize)) : ch;
  return out;
}

/** How much further in each level of a list starts than the level it is under, in the text's own size. */
export const STEP_EM = 1.5;

/** How wide a task's box is, in the text's own size. */
export const BOX_EM = 1.1;

/** How far a task's words start after its box, in the text's own size. */
export const TASK_GAP_EM = 0.6;

/** The face and size each editor's lines are set in, read once it is on the page, where its styles are. */
interface Face {
  font: string;
  size: number;
}
const faces = new WeakMap<EditorView, Face>();
const widths = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;

function faceOf(view: EditorView): Face {
  const style = getComputedStyle(view.contentDOM);
  return { font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, size: parseFloat(style.fontSize) };
}

/** How wide `text` is in `font`. */
function widthOf(font: string, text: string): number {
  const key = `${font}\n${text}`;
  let width = widths.get(key);
  if (width === undefined) {
    pen ??= document.createElement("canvas").getContext("2d");
    if (!pen) return 0;
    pen.font = font;
    width = pen.measureText(text).width;
    widths.set(key, width);
  }
  return width;
}

/** Where an item's words start: how many letters in a line under them is written, and how far in the words are drawn. */
interface Start {
  column: number;
  hang: number;
}

const hangs = (width: number) => Decoration.line({ class: "md-item", attributes: { style: `--md-hang: ${width.toFixed(3)}px` } });
const indented = (width: number) => Decoration.mark({ class: "md-item-indent", attributes: { style: `width: ${width.toFixed(3)}px` } });
/** A task's `[ ]`, `[x]` or `[X]` as written: as wide as the box drawn in its place, whatever its letters' widths. */
const boxed = Decoration.mark({ class: "md-task-box" });
/** The space after a task's box, made as wide as the gap after the box asks, the same with the box drawn or written. */
const gap = (width: number) => Decoration.mark({ class: "md-task-gap", attributes: { style: `padding-right: ${width.toFixed(3)}px` } });

/**
 * A list item hangs: the rows its words wrap onto start under its first word, not under its mark.
 * The line is padded by the width of what stands before the words and its first row is pulled back
 * by the same, so the first row starts at the line's edge, mark and all, and only the rows after it
 * move in.
 *
 * Each level of a list starts a step further in than the level it is under, however little the note
 * indents it: two spaces are a few pixels in the text's face, too few to tell a level from the next.
 * The indent is a box of that width with the note's own spaces in it. A line written under an
 * item's words, indented to them, starts where they do. All of it is the same with the cursor on
 * the line or off it, so the cursor coming to a line moves nothing.
 *
 * Only where the item begins its line: an item in a quote (`> - words`) is laid out as any line is.
 */
const hanging = drawnInView(
  (view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    const face = faces.get(view);
    if (face === undefined) {
      // An editor is made before it is put on the page. Its lines are drawn again in the frame it arrives in, before that frame is painted.
      requestAnimationFrame(() => {
        if (!view.dom.isConnected || faces.has(view)) return;
        faces.set(view, faceOf(view));
        view.dispatch({ effects: redraw.of(null) });
      });
      return drawn;
    }
    const { font, size } = face;
    const columns = (text: string) => spaced(text, state.tabSize);
    const items = new Set<number>();
    /** The lines written under an item's first, each with the item it is nearest inside. */
    const under = new Map<number, Start>();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter(node) {
          if (node.name !== "ListItem") return;
          const line = state.doc.lineAt(node.from);
          if (items.has(line.from)) return;
          const lead = leadIn(line.text);
          if (!lead) return;
          items.add(line.from);
          under.delete(line.from);
          let depth = 0;
          for (let up = node.node.parent; up; up = up.parent) if (up.name === "ListItem") depth++;
          const indent = /^[ \t]*/.exec(lead)![0];
          const written = widthOf(font, columns(indent));
          // A level is a step whatever the note's spaces are: three under a number are wider than a step in a monospaced face.
          const wide = depth ? depth * STEP_EM * size : written;
          // A task's words start a box and a gap after its `[`, whether it is `[ ]`, `[x]` or `[X]`, so ticking it moves nothing. The box is
          // as wide as it is drawn, written or not, so no letter's width is in it, measured or laid out.
          const task = /(\[[ xX]\])([ \t]+)$/.exec(lead);
          const space = task ? widthOf(font, task[2]!) : 0;
          const room = task ? Math.max(0, TASK_GAP_EM * size - space) : 0;
          const before = task ? lead.slice(0, task.index) : lead;
          const hang = wide + widthOf(font, columns(before)) - written + (task ? BOX_EM * size + space + room : 0);
          if (!hang) return;
          drawn.push(hangs(hang).range(line.from));
          if (task) drawn.push(boxed.range(line.from + task.index, line.from + task.index + 3), gap(room).range(line.from + lead.length - task[2]!.length, line.from + lead.length));
          if (indent && (wide !== written || indent.includes("\t"))) drawn.push(indented(wide).range(line.from, line.from + indent.length));
          // What is written under an item is indented to its mark, not to a task's box, and is drawn under the words all the same.
          const start = { column: columns(/^[ \t]*\S+[ \t]+/.exec(lead)![0]).length, hang };
          for (let at = line; at.to < Math.min(node.to, to); ) {
            at = state.doc.line(at.number + 1);
            if (at.from >= from && !items.has(at.from)) under.set(at.from, start);
          }
        },
      });
    }
    for (const [at, { column, hang }] of under) {
      const line = state.doc.lineAt(at);
      const indent = /^[ \t]*/.exec(line.text)![0];
      const over = columns(indent).length - column;
      // Not a line the item's words run onto with no indent, and not code, whose lines start where its block has them start.
      if (indent.length === line.length || over < 0 || inCode(state, at + indent.length)) continue;
      const wide = hang + widthOf(font, " ".repeat(over));
      drawn.push(hangs(wide).range(at), indented(wide).range(at, at + indent.length));
    }
    return drawn;
  },
  // The size of the text can change under an editor: a setting, a zoom, a card made wider.
  (update) => {
    const { view } = update;
    const was = faces.get(view);
    if (!update.geometryChanged || !was) return false;
    const face = faceOf(view);
    if (face.font === was.font) return false;
    faces.set(view, face);
    return true;
  },
);

// 6px is the padding CodeMirror gives every line on the left.
const look = EditorView.baseTheme({
  // Not a line of a code block that opens on an item's line: a block's lines all start where the block has them start.
  ".cm-line.md-item:not(.code-line)": { paddingLeft: "calc(6px + var(--md-hang)) !important", textIndent: "calc(-1 * var(--md-hang))" },
  // The pull is the line's own. A box in the line, a checkbox or a clock, would take it for its first row too.
  ".cm-line.md-item > *": { textIndent: "0" },
  // An indent is a box as wide as its level asks. A tab in it is as wide as the spaces it stands for: left in the line, it
  // would be as wide as the way to the next stop, and the stops are counted from where the line's rows start, which the
  // pull has put to the right of the indent.
  ".md-item-indent": { display: "inline-block", whiteSpace: "pre", overflow: "hidden", verticalAlign: "bottom" },
  ".md-task-box": { display: "inline-block", width: `${BOX_EM}em`, whiteSpace: "pre" },
});

export const hangingLists: Extension = [hanging, look];
