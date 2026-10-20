import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { drawnInView, ghost, ghostLook, lineTouched, touched } from "../lib/live.ts";
import { MOD, openPage, opens } from "../lib/opening.ts";

const hidden = Decoration.replace({});
const code = Decoration.mark({ class: "md-code" });
/** A quote's line `depth` quotes in, pulled back by its `>`s when it has them so its words start where its wrapped rows do. */
const quoteLines = new Map<string, Decoration>();
const quote = (depth: number, pulled: boolean) => {
  const key = `${depth}${pulled}`;
  let line = quoteLines.get(key);
  if (!line) quoteLines.set(key, (line = Decoration.line({ class: "md-quote", attributes: { style: `--md-quote-hang: ${depth * QUOTE_EM}em; --md-quote-pull: ${pulled ? depth * QUOTE_EM : 0}em` } })));
  return line;
};
/** How much room each `>` and the space after it take, in the text's own size, whatever their letters' widths. */
const QUOTE_EM = 1;
const quoteMarks = Decoration.mark({ class: "md-quote-marks" });
const rule = Decoration.line({ class: "md-rule" });
const hangs = [1, 2, 3, 4, 5, 6].map((level) => Decoration.mark({ class: `md-hang md-hang-${level}` }));

/** Marks inside a line that say how the text beside them reads, and nothing else. */
const MARKS = new Set(["EmphasisMark", "StrikethroughMark", "SubscriptMark", "SuperscriptMark"]);

/** What those marks stand around. */
const WRAPS = new Set(["Emphasis", "StrongEmphasis", "Strikethrough"]);

const link = (url: string, written: boolean) => Decoration.mark({ class: "md-link", attributes: opens(url) ? { "data-href": url, title: `${url}\n${written ? `${MOD}-click to open` : "Click to open"}` } : {} });

/**
 * Draws markdown where it is written. What the cursor is on is shown as written, and only that: a
 * bold word shows its `**` with the cursor in the word or at its edge, and the link beside it stays
 * drawn. A heading's mark is the one thing that goes by its line. HTML in a note is never drawn: it
 * stays the text it is.
 *
 * A mark at the start of a line is never taken out of it: a heading's `#`s hang in the margin,
 * drawn or not, a quote's `>`s hang in the room before its words, and a rule's dashes keep their
 * place. A quote's and a rule's marks are only not painted. So the first word of every line is where
 * it was. A mark inside a line (`**`, a backtick, a link's
 * address) is taken out, and shown again with the cursor on its construct: the words before it on
 * the line stay where they are, and the words after it move over by the mark's width.
 */
function marks(view: EditorView): Range<Decoration>[] {
  const { state } = view;
  const drawn: Range<Decoration>[] = [];
  /** Whether the cursor is off the construct that is `of`. */
  const off = (of: { from: number; to: number }) => !touched(state, of.from, of.to);
  /** Takes a mark out of sight unless the cursor is on the construct it belongs to. */
  const hide = (from: number, to: number, of: { from: number; to: number }) => from < to && off(of) && drawn.push(hidden.range(from, to));
  /** `***both***` is two constructs written as one: the outermost of those with nothing but marks between their edges, so its marks show together. */
  const wholeOf = (of: { from: number; to: number; name: string; parent: { from: number; to: number; name: string; parent: unknown } | null }) => {
    let whole = of;
    for (let up = whole.parent; up && WRAPS.has(up.name) && /^[*_~]*$/.test(state.sliceDoc(up.from, whole.from) + state.sliceDoc(whole.to, up.to)); up = whole.parent) whole = up as typeof of;
    return whole;
  };
  const spaceAfter = (to: number) => to + /^[ \t]*/.exec(state.sliceDoc(to, state.doc.lineAt(to).to))![0].length;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const { name } = node;
        if (MARKS.has(name)) hide(node.from, node.to, wholeOf(node.node.parent ?? node.node));
        else if (name === "HeaderMark" && node.node.parent?.name.startsWith("ATXHeading")) {
          if (node.from === node.node.parent.from) {
            const end = spaceAfter(node.to);
            drawn.push(hangs[Number(node.node.parent.name.slice(-1)) - 1]!.range(node.from, end));
            if (!lineTouched(state, node.from)) drawn.push(ghost.range(node.from, end));
          } else if (!lineTouched(state, node.from)) drawn.push(hidden.range(node.from - /[ \t]*$/.exec(state.sliceDoc(node.node.parent.from, node.from))![0].length, node.to));
        } else if (name === "QuoteMark") {
          if (off(node)) drawn.push(ghost.range(node.from, node.to));
        } else if (name === "Blockquote" && !within(node.node, "Blockquote")) {
          // The outermost quote draws every line, a quote inside it as well: each line's `>`s say how deep it is.
          // A quote in a list item hangs nothing, since its lines are hung by the item's words.
          const listed = within(node.node, "ListItem");
          for (let line = state.doc.lineAt(Math.max(node.from, from)); line.from <= Math.min(node.to, to); line = state.doc.line(line.number + 1)) {
            const written = /^[ \t]*(?:>[ \t]?)*/.exec(line.text)![0];
            const depth = listed ? 0 : written.split(">").length - 1;
            drawn.push(quote(listed ? 0 : Math.max(depth, 1), depth > 0).range(line.from));
            if (depth) drawn.push(quoteMarks.range(line.from, line.from + written.length));
            if (line.number >= state.doc.lines) break;
          }
        } else if (name === "InlineCode") {
          drawn.push(code.range(node.from, node.to));
          for (const mark of node.node.getChildren("CodeMark")) hide(mark.from, mark.to, node);
        } else if (name === "HorizontalRule") {
          if (off(node)) drawn.push(rule.range(state.doc.lineAt(node.from).from), ghost.range(node.from, node.to));
        } else if (name === "Escape") hide(node.from, node.from + 1, node);
        else if (name === "Image") return false;
        else if (name === "Link" || name === "Autolink") {
          const [open, close] = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          if (!open || !close || !url) return;
          const text = name === "Link" ? { from: open.to, to: close.from } : url;
          if (text.from < text.to) drawn.push(link(state.sliceDoc(url.from, url.to), !off(node)).range(text.from, text.to));
          hide(open.from, text.from, node);
          hide(text.to, node.to, node);
        } else if (name === "URL" && !["Link", "Autolink", "Image", "LinkReference"].includes(node.node.parent?.name ?? "")) {
          drawn.push(link(state.sliceDoc(node.from, node.to), !off(node)).range(node.from, node.to));
        }
        return;
      },
    });
  }
  return drawn;
}

function within(node: { parent: { name: string; parent: unknown } | null }, name: string): boolean {
  for (let up = node.parent; up; up = up.parent as typeof up) if (up.name === name) return true;
  return false;
}

const LINKS = new Set(["Link", "Autolink", "URL"]);

/** Whether the cursor is on the link that has `pos` in it, which is then shown as written. */
function onLink(state: EditorState, pos: number) {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  while (node && !LINKS.has(node.name)) node = node.parent;
  return !!node && touched(state, node.from, node.to);
}

/**
 * A click on a drawn link opens it in a new tab. On a link the cursor is on, which is shown as
 * written, a plain click is for the cursor, and ⌘-click or Ctrl-click opens the link.
 */
const following = EditorView.domEventHandlers({
  mousedown(event, view) {
    const el = event.button === 0 && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-href]") : null;
    const href = el?.dataset.href;
    if (!el || !href || !opens(href)) return false;
    if (!(event.metaKey || event.ctrlKey) && onLink(view.state, view.posAtDOM(el))) return false;
    openPage(href);
    event.preventDefault();
    return true;
  },
});

const look = EditorView.baseTheme({
  ".md-code": { backgroundColor: "var(--code-bg)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".md-link[data-href]": { cursor: "pointer" },
  // A line's `>`s hang in a box as wide as its depth, in the room before its words, so a quote that wraps starts each row at one place.
  ".md-quote": { borderLeft: "3px solid var(--line-strong)", paddingLeft: "calc(0.6em + var(--md-quote-hang)) !important", textIndent: "calc(-1 * var(--md-quote-pull))", color: "var(--muted)" },
  ".md-quote > *": { textIndent: "0" },
  ".md-quote-marks": { display: "inline-block", width: "var(--md-quote-pull)", whiteSpace: "pre", verticalAlign: "bottom" },
  ".md-rule": { backgroundImage: "linear-gradient(var(--line-strong), var(--line-strong))", backgroundSize: "100% 1px", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  // In the margin, on the heading's first row: a box that reaches back as far as it is wide, with the mark at its right edge, so
  // it takes no room and the words start where they would without it. It stays in the line's flow, so a heading with no words
  // yet is as tall as one with words. The mark is at the heading's own size, and the deeper ones are drawn smaller so that six fit.
  ".md-hang": { display: "inline-block", width: "8rem", marginLeft: "-8rem", textAlign: "right", whiteSpace: "pre", transformOrigin: "right 72%" },
  ".md-hang span": { color: "var(--muted)" },
  ".md-hang-4": { transform: "scale(0.9)" },
  ".md-hang-5": { transform: "scale(0.75)" },
  ".md-hang-6": { transform: "scale(0.64)" },
});

export const markdownMarks: Extension = [drawnInView(marks), following, look, ghostLook];
