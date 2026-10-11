import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { drawnInView, ghost, ghostLook, lineTouched } from "../lib/live.ts";

const hidden = Decoration.replace({});
const code = Decoration.mark({ class: "md-code" });
const quote = Decoration.line({ class: "md-quote" });
const rule = Decoration.line({ class: "md-rule" });
const hang = Decoration.mark({ class: "md-hang" });

/** Marks inside a line that say how the text beside them reads, and nothing else. */
const MARKS = new Set(["EmphasisMark", "StrikethroughMark", "SubscriptMark", "SuperscriptMark"]);

/** Where a link may go when it is opened. Anything else in a note stays text. */
export const opens = (url: string) => /^(https?:\/\/|mailto:)/i.test(url);

const link = (url: string) => Decoration.mark({ class: "md-link", attributes: opens(url) ? { "data-href": url, title: `${url}\n${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}-click to open` } : {} });

/**
 * Draws markdown where it is written, and shows a line as written while the cursor is on it. HTML
 * in a note is never drawn: it stays the text it is.
 *
 * Nothing moves when the cursor comes to a line or leaves it. A mark at the start of a line is
 * never taken out of it: a heading's `#`s hang in the margin, drawn or not, and a quote's `>` and a
 * rule's dashes keep their place and are only not painted. So the first word of every line is where
 * it was. A mark inside a line (`**`, a backtick, a link's address) is taken out, and the words
 * after it on that line close up by its width.
 */
function marks(view: EditorView): Range<Decoration>[] {
  const { state } = view;
  const drawn: Range<Decoration>[] = [];
  const off = (pos: number) => !lineTouched(state, pos);
  const hide = (from: number, to: number) => from < to && off(from) && drawn.push(hidden.range(from, to));
  const spaceAfter = (to: number) => to + /^[ \t]*/.exec(state.sliceDoc(to, state.doc.lineAt(to).to))![0].length;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const { name } = node;
        if (MARKS.has(name)) hide(node.from, node.to);
        else if (name === "HeaderMark" && node.node.parent?.name.startsWith("ATXHeading")) {
          if (node.from === node.node.parent.from) {
            const end = spaceAfter(node.to);
            drawn.push(hang.range(node.from, end));
            if (off(node.from)) drawn.push(ghost.range(node.from, end));
          } else hide(node.from - /[ \t]*$/.exec(state.sliceDoc(node.node.parent.from, node.from))![0].length, node.to);
        } else if (name === "QuoteMark") {
          if (off(node.from)) drawn.push(ghost.range(node.from, node.to));
        } else if (name === "Blockquote") {
          for (let line = state.doc.lineAt(Math.max(node.from, from)); line.from <= Math.min(node.to, to); line = state.doc.line(line.number + 1)) {
            drawn.push(quote.range(line.from));
            if (line.number >= state.doc.lines) break;
          }
        } else if (name === "InlineCode") {
          drawn.push(code.range(node.from, node.to));
          for (const mark of node.node.getChildren("CodeMark")) hide(mark.from, mark.to);
        } else if (name === "HorizontalRule") {
          if (off(node.from)) drawn.push(rule.range(state.doc.lineAt(node.from).from), ghost.range(node.from, node.to));
        } else if (name === "Escape") hide(node.from, node.from + 1);
        else if (name === "Image") return false;
        else if (name === "Link" || name === "Autolink") {
          const [open, close] = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          if (!open || !close || !url) return;
          const text = name === "Link" ? { from: open.to, to: close.from } : url;
          if (text.from < text.to) drawn.push(link(state.sliceDoc(url.from, url.to)).range(text.from, text.to));
          hide(open.from, text.from);
          hide(text.to, node.to);
        } else if (name === "URL" && !["Link", "Autolink", "Image", "LinkReference"].includes(node.node.parent?.name ?? "")) {
          drawn.push(link(state.sliceDoc(node.from, node.to)).range(node.from, node.to));
        }
        return;
      },
    });
  }
  return drawn;
}

/** ⌘-click, or Ctrl-click, opens a link in a new tab. A plain click puts the cursor in it. */
const following = EditorView.domEventHandlers({
  mousedown(event) {
    const href = (event.metaKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-href]")?.dataset.href : undefined;
    if (!href || !opens(href)) return false;
    window.open(href, "_blank", "noopener,noreferrer");
    event.preventDefault();
    return true;
  },
});

const look = EditorView.baseTheme({
  ".md-code": { backgroundColor: "var(--bg-side)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".md-quote": { borderLeft: "3px solid var(--line-strong)", paddingLeft: "0.6em !important", color: "var(--muted)" },
  ".md-rule": { backgroundImage: "linear-gradient(var(--line-strong), var(--line-strong))", backgroundSize: "100% 1px", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  // In the margin, against the heading's first letter, and small enough that six of them fit there.
  ".md-hang": { position: "absolute", transform: "translateX(-100%) scale(0.6)", transformOrigin: "right center", whiteSpace: "pre", fontWeight: "400" },
});

export const markdownMarks: Extension = [drawnInView(marks), following, look, ghostLook];
