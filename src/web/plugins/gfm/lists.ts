import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { drawnInView, redraw } from "../lib/live.ts";

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

/** The face and size each editor's lines are set in, read once it is on the page, where its styles are. */
const fonts = new WeakMap<EditorView, string>();
const widths = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;

function fontOf(view: EditorView) {
  const style = getComputedStyle(view.contentDOM);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
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

/**
 * A list item hangs: the rows its words wrap onto start under its first word, not under its mark.
 * The line is padded by the width of what stands before the words and its first row is pulled back
 * by the same, so the first row is exactly where it would be without this, mark and all, and only
 * the rows after it move in. That width is the text's own, as written, and a mark keeps its width
 * drawn or not, so the cursor coming to the line changes nothing.
 *
 * Only the line an item begins on hangs, and only where the item begins the line: an item in a quote
 * (`> - words`) and a second line written under an item's words are laid out as any line is.
 */
const hanging = drawnInView(
  (view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    const font = fonts.get(view);
    if (font === undefined) {
      // An editor is made before it is put on the page. Its lines are drawn again in the frame it arrives in, before that frame is painted.
      requestAnimationFrame(() => {
        if (!view.dom.isConnected || fonts.has(view)) return;
        fonts.set(view, fontOf(view));
        view.dispatch({ effects: redraw.of(null) });
      });
      return drawn;
    }
    const seen = new Set<number>();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter(node) {
          if (node.name !== "ListItem") return;
          const line = state.doc.lineAt(node.from);
          if (seen.has(line.from)) return;
          seen.add(line.from);
          const lead = leadIn(line.text);
          const width = lead && widthOf(font, spaced(lead, state.tabSize));
          if (!width) return;
          drawn.push(Decoration.line({ class: "md-item", attributes: { style: `--md-hang: ${width.toFixed(3)}px` } }).range(line.from));
          const indent = /^[ \t]*/.exec(lead)![0];
          if (indent.includes("\t")) {
            const wide = widthOf(font, spaced(indent, state.tabSize)).toFixed(3);
            drawn.push(Decoration.mark({ class: "md-item-tabs", attributes: { style: `width: ${wide}px` } }).range(line.from, line.from + indent.length));
          }
        },
      });
    }
    return drawn;
  },
  // The size of the text can change under an editor: a setting, a zoom, a card made wider.
  (update) => {
    const { view } = update;
    if (!update.geometryChanged || !fonts.has(view)) return false;
    const font = fontOf(view);
    if (font === fonts.get(view)) return false;
    fonts.set(view, font);
    return true;
  },
);

// 6px is the padding CodeMirror gives every line on the left.
const look = EditorView.baseTheme({
  // Not a line of a code block that opens on an item's line: a block's lines all start where the block has them start.
  ".cm-line.md-item:not(.code-line)": { paddingLeft: "calc(6px + var(--md-hang)) !important", textIndent: "calc(-1 * var(--md-hang))" },
  // The pull is the line's own. A box in the line, a checkbox or a clock, would take it for its first row too.
  ".cm-line.md-item > *": { textIndent: "0" },
  // An indent made of tabs is a box as wide as the spaces it stands for. A tab is as wide as the way to the next stop, and the
  // stops are counted from where the line's rows start, which the pull has put to the right of the indent: left in the
  // line, a tab would be narrower than it is without the pull, and the item would not start where its width says.
  ".md-item-tabs": { display: "inline-block", whiteSpace: "pre", overflow: "hidden", verticalAlign: "bottom" },
});

export const hangingLists: Extension = [hanging, look];
