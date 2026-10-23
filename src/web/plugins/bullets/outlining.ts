import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, RangeSet, RangeValue, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { BOX_PATTERN, isReading } from "../../plugin-api.ts";
import { drawnInView, touched, writable } from "../lib/live.ts";
import { mathBlocksIn, type Formula } from "../math/syntax.ts";
import { hasUnder, indent, itemAt, leading, move, outdent, parentOf, textStart, type Edit, type Item, type Lines } from "./outline.ts";

export const linesIn = (doc: Text): Lines => ({ count: doc.lines, at: (n) => doc.line(n + 1).text });

const mathOf = new WeakMap<Text, Formula[]>();

/**
 * The bullet on line `n` of the note, counting from 0, if the note's markdown has a list item
 * there. A line that only looks like one, in a code block or a block of math, is not a bullet:
 * nothing draws it as one, and no bullet key moves it.
 */
export function bulletAt(state: EditorState, n: number): Item | null {
  const item = itemAt(linesIn(state.doc), n);
  if (!item) return null;
  const line = state.doc.line(n + 1);
  const mark = line.from + /^[ \t]*/.exec(line.text)![0].length;
  if ((ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state)).resolveInner(mark, 1).name !== "ListMark") return null;
  let math = mathOf.get(state.doc);
  if (!math) mathOf.set(state.doc, (math = mathBlocksIn(state.doc.iterLines())));
  return math.some((block) => block.from <= line.from && block.to >= line.to) ? null : item;
}

/** A fold as it is kept between visits: the line the folded bullet was on and what it said, so a note that has changed since unfolds what no longer matches. */
export interface Kept {
  line: number;
  text: string;
}

class Folded extends RangeValue {
  override startSide = -1;
  override eq() {
    return true;
  }
}
const folded = new Folded();

const toggleFold = StateEffect.define<number>();
/** Says which lines are folded, by where each starts, in place of whatever was. */
const foldsAre = StateEffect.define<readonly number[]>();

interface Fold {
  /** Where the folded bullet's line starts and ends, and where what is under it ends. From `line.to` to `to` is hidden. */
  from: number;
  shown: number;
  to: number;
}

/** What each mark folds now. A mark on a line that is no longer a bullet with something under it folds nothing. */
function foldsOf(state: EditorState, marks: RangeSet<Folded>): Fold[] {
  const folds: Fold[] = [];
  for (let cursor = marks.iter(); cursor.value; cursor.next()) {
    const line = state.doc.lineAt(cursor.from);
    const item = line.from === cursor.from ? bulletAt(state, line.number - 1) : null;
    if (!item || item.end - item.line < 2) continue;
    const fold = { from: line.from, shown: line.to, to: state.doc.line(item.end).to };
    // A fold inside another is hidden with it.
    if (!folds.length || fold.from > folds[folds.length - 1]!.to) folds.push(fold);
  }
  return folds;
}

/** Whether the bullet whose line starts at `from` is folded in this editor. */
export const isFolded = (state: EditorState, from: number) => state.field(folds).folds.some((f) => f.from === from);

class Ellipsis extends WidgetType {
  override toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "bullet-folded";
    el.textContent = "…";
    el.title = "Unfold";
    el.setAttribute("aria-label", "Unfold");
    el.setAttribute("role", "button");
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ effects: toggleFold.of(view.state.doc.lineAt(view.posAtDOM(el)).from) });
    });
    return el;
  }

  override ignoreEvent() {
    return true;
  }
}
const ellipsis = Decoration.replace({ widget: new Ellipsis() });

/**
 * Folds the bullets whose lines start at `froms`, beside what is already folded. A cursor in what
 * they hide goes to the end of the bullet's line, as a fold opens for a cursor inside it.
 */
function fold(view: EditorView, froms: readonly number[], only = false) {
  const { state } = view;
  const kept = only ? [] : state.field(folds).folds.map((f) => f.from);
  const hiding = froms.map((from) => state.doc.lineAt(from)).find((line) => {
    const item = bulletAt(state, line.number - 1);
    return item && state.selection.ranges.some((r) => r.to > line.to && r.from <= state.doc.line(item.end).to);
  });
  view.dispatch({ effects: foldsAre.of([...new Set([...kept, ...froms])]), selection: hiding && { anchor: hiding.to } });
}

/** What is drawn beside a bullet that has something under it, to fold or unfold it with a click. Its arrow is drawn by its look, so it is no letter of the line. */
class Disclosure extends WidgetType {
  constructor(readonly open: boolean) {
    super();
  }

  override eq(other: Disclosure) {
    return other.open === this.open;
  }

  override toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "bullet-disclosure";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.open ? "Fold" : "Unfold");
    el.setAttribute("aria-expanded", String(this.open));
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const from = view.state.doc.lineAt(view.posAtDOM(el)).from;
      if (this.open) fold(view, [from]);
      else view.dispatch({ effects: toggleFold.of(from) });
    });
    return el;
  }

  override ignoreEvent() {
    return true;
  }
}
const disclosures = [new Disclosure(true), new Disclosure(false)].map((widget) => Decoration.widget({ widget, side: -1 }));

interface Folds {
  marks: RangeSet<Folded>;
  folds: readonly Fold[];
  drawn: DecorationSet;
}

function made(state: EditorState, marks: RangeSet<Folded>): Folds {
  let folds = foldsOf(state, marks);
  // Nothing is typed over or deleted where it can't be seen: a fold opens when the cursor lands in it, and when a
  // selection takes in any of what it hides, so what a key is about to delete is on screen first.
  const entered = folds.filter((f) => state.selection.ranges.some((r) => r.to > f.shown && r.from <= f.to));
  if (entered.length) folds = folds.filter((f) => !entered.includes(f));
  // Marks that fold nothing are dropped, so a line doesn't fold itself later when something is put under it.
  const kept = folds.length === marks.size ? marks : RangeSet.of(folds.map((f) => folded.range(f.from)));
  return { marks: kept, folds, drawn: Decoration.set(folds.map((f) => ellipsis.range(f.shown, f.to))) };
}

/**
 * Which bullets are folded in this editor. A fold is how the note is shown and never part of its
 * text. It is kept by where its line starts, so it stays with the line as the note changes around it.
 */
const folds = StateField.define<Folds>({
  create: (state) => made(state, RangeSet.empty),
  update(value, tr) {
    let marks = value.marks;
    if (tr.docChanged) {
      // A change to what is folded opens it, so nothing is typed where it can't be seen.
      const changed = value.folds.filter((f) => tr.changes.touchesRange(f.shown + 1, f.to));
      if (changed.length) marks = marks.update({ filter: (from) => !changed.some((f) => f.from === from) });
      marks = marks.map(tr.changes);
    }
    for (const effect of tr.effects) {
      if (effect.is(foldsAre)) marks = RangeSet.of(effect.value.map((from) => folded.range(from)), true);
      else if (effect.is(toggleFold)) {
        const at = effect.value;
        let was = false;
        marks = marks.update({ filter: (from) => !(from === at && (was = true)) });
        if (!was) marks = marks.update({ add: [folded.range(at)] });
      }
    }
    return marks === value.marks && !tr.docChanged && !tr.selection ? value : made(tr.state, marks);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.drawn),
});

/** A click past the end of a folded bullet's line is a click on that line, not in what is folded after it. */
const clickingFolded = EditorState.transactionFilter.of((tr) => {
  const value = tr.startState.field(folds, false);
  const head = !tr.docChanged && tr.selection?.main.empty && tr.isUserEvent("select.pointer") ? tr.selection.main.head : -1;
  const fold = head < 0 ? undefined : value?.folds.find((f) => f.to === head);
  return fold ? [tr, { selection: { anchor: fold.shown } }] : tr;
});

/** The mark stays in the line and a dot is painted over it, so a bullet's text is where it is when the mark is shown. */
const dot = Decoration.mark({ class: "bullet-dot" });
/** A numbered item's number is left as it is, and marked as what a bullet is dragged by. */
const number = Decoration.mark({ class: "bullet-number" });
/** A task's box is its mark enough: its bullet's mark keeps its room and is painted as nothing. Only where the box is drawn, which is at the start of a line. */
const blank = Decoration.mark({ class: "bullet-blank" });
/** A line that starts with a bullet and a task's box, whatever mark the box holds, and the space after it: a box with none yet is drawn as written. */
const TASK = new RegExp(`^\\s*[-*+]\\s+${BOX_PATTERN}[ \\t]`);

/** A dot for each bullet's mark, or nothing on a task's, and a numbered item's number marked as itself, except the mark the cursor is on, and a disclosure before each mark with something under it. */
const bullets = drawnInView(
  (view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    const lines = linesIn(state.doc);
    const folded = new Set(state.field(folds).folds.map((f) => f.from));
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter(node) {
          if (node.name !== "ListMark") return;
          const line = state.doc.lineAt(node.from);
          // One disclosure to a line, before its first mark, as in `- - x`.
          const first = node.from === line.from + leading(line.text).length;
          if (first && !isReading(state) && hasUnder(lines, line.number - 1)) drawn.push(disclosures[folded.has(line.from) ? 1 : 0]!.range(node.from));
          if (touched(state, node.from, node.to)) return;
          if (node.node.parent?.parent?.name === "BulletList") drawn.push((TASK.test(line.text) ? blank : dot).range(node.from, node.to));
          else if (node.node.parent?.parent?.name === "OrderedList") drawn.push(number.range(node.from, node.to));
        },
      });
    }
    return drawn;
  },
  (update) => update.startState.field(folds).folds !== update.state.field(folds).folds,
);

const look = EditorView.baseTheme({
  // The mark's own letter is there and not painted, as a ghost is, and the dot is painted over it.
  ".bullet-dot, .bullet-blank": { position: "relative", WebkitTextFillColor: "transparent" },
  ".bullet-dot::before": { content: '"•"', position: "absolute", left: "0", right: "0", textAlign: "center", WebkitTextFillColor: "var(--muted)" },
  // Out in the margin before the mark, so the line's text is where it is with or without it. Shown where the pointer is, and on a folded bullet.
  // Just before the mark and pulled out to its left by as much as it is wide, so it stays beside the mark however the line is indented and the text doesn't move.
  ".bullet-disclosure": { display: "inline-block", width: "1em", marginLeft: "-1.3em", marginRight: "0.3em", textAlign: "center", cursor: "pointer", opacity: "0", userSelect: "none" },
  ".bullet-disclosure::before": { content: '"▾"', color: "var(--muted)" },
  // Where the lists draw a bullet's dot further into its mark, in the column a task's box stands in, the disclosure goes along.
  ".cm-line.md-item-dotted .bullet-disclosure": { position: "relative", left: "var(--md-dot-at, 0)", zIndex: "1" },
  // A task's mark and the space after it are painted as nothing, so the disclosure goes past them, beside the box.
  ".cm-line:has(.bullet-blank) .bullet-disclosure": { position: "relative", left: "2ch", zIndex: "1" },
  ".bullet-disclosure[aria-expanded=false]::before": { content: '"▸"' },
  ".cm-line:hover .bullet-disclosure, .bullet-disclosure[aria-expanded=false]": { opacity: "1" },
  "@media (hover: none)": { ".bullet-disclosure": { opacity: "0.6" } },
  ".bullet-folded": { marginLeft: "0.4em", padding: "0 0.4em", borderRadius: "4px", backgroundColor: "var(--accent-soft)", color: "var(--accent)", cursor: "pointer" },
});

/** A member who can only read the note folds its bullets by their key too, so its text takes the keyboard. A reading, as a folder's card is, is no place for keys. */
const reachable = EditorView.contentAttributes.of((view) => (view.state.facet(EditorView.editable) || isReading(view.state) ? null : { tabindex: "0" }));

/** The note editor with bullets that last had the keyboard. */
let last: EditorView | null = null;
// Kept as it gives the keyboard up, to the palette say: an editor given the keyboard as it opens, as after a reload, has no update that says it took it.
const remembered = EditorView.domEventHandlers({
  blur(_, view) {
    last = view;
    return false;
  },
});

/**
 * The note editor that has the keyboard, if it has bullets. `orLast` takes the one that had it last
 * as well, for a command run from the palette, which has the keyboard until it has run it.
 */
function focused(orLast = false): EditorView | null {
  const view = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null;
  if (view && view.contentDOM === document.activeElement && view.state.field(folds, false)) return view;
  return orLast && last?.dom.isConnected ? last : null;
}

/**
 * The note editor that has the keyboard, if its selection starts on a bullet, and the lines of that
 * selection: from the line it starts on to the last line it takes anything of.
 */
function onBullet(orLast = false): { view: EditorView; line: number; last: number } | null {
  const view = focused(orLast);
  if (!view) return null;
  const { doc, selection } = view.state;
  const { from, to, empty } = selection.main;
  const line = doc.lineAt(from).number - 1;
  const end = doc.lineAt(to);
  const last = Math.max(line, end.number - 1 - (!empty && end.from === to ? 1 : 0));
  return bulletAt(view.state, line) ? { view, line, last } : null;
}

type Make = (lines: Lines, line: number, last: number) => Edit | null;

/** The edit a bullet key would make now, and where: nothing when the selection doesn't start on a bullet, the note can't be changed, or the bullet has nowhere to go. */
function ready(make: Make, orLast = false) {
  const at = onBullet(orLast);
  const made = at && writable(at.view.state) ? make(linesIn(at.view.state.doc), at.line, at.last) : null;
  return at && made ? { ...at, made } : null;
}

/** Makes the outline edit a bullet key would make now, if there is one. */
function edit(make: Make) {
  const at = ready(make, true);
  if (at) makeEdit(at.view, at.made);
}

/**
 * Makes an outline edit in the editor as the member's own: the lines change, the selection stays on
 * the text it was on, and folded bullets stay folded where they land. With `cursorAt`, the cursor
 * goes to the end of that line instead, wherever it lands, and the note scrolls only as far as it
 * takes to show it.
 */
export function makeEdit(view: EditorView, made: Edit, cursorAt?: number) {
  const { state } = view;
  const [from, to] = [state.doc.line(made.from + 1).from, state.doc.line(made.to).to];
  const insert = made.lines.join("\n");
  const after = state.update({ changes: { from, to, insert } }).state.doc;
  const landed = (n: number) => after.line(made.after(n) + 1);
  /** The place in the edited note of the place `pos`: as far past its line's text start as it was, or as far into the space before it. */
  const placed = (pos: number) => {
    const [was, now] = [state.doc.lineAt(pos), landed(state.doc.lineAt(pos).number - 1)];
    const [start, column] = [textStart(was.text), pos - was.from];
    const along = column >= start ? textStart(now.text) + column - start : column + leading(now.text).length - leading(was.text).length;
    return Math.min(now.from + Math.max(0, along), now.to);
  };
  const { anchor, head, to: end, empty } = state.selection.main;
  /** A selection that ends at the start of a line ends just past the newline of the last line it takes, which goes with that line. */
  const place = (pos: number) => (!empty && pos === end && pos > 0 && state.doc.lineAt(pos).from === pos ? placed(pos - 1) + 1 : placed(pos));
  const foldedLines = state.field(folds).folds.map((f) => state.doc.lineAt(f.from).number - 1);
  view.dispatch({
    changes: { from, to, insert },
    selection: cursorAt === undefined ? { anchor: place(anchor), head: place(head) } : { anchor: landed(cursorAt).to },
    effects: foldsAre.of(foldedLines.map((n) => landed(n).from)),
    scrollIntoView: true,
    userEvent: "move.bullet",
  });
}

const MAKES = {
  indent,
  outdent,
  moveUp: (lines, line, last) => move(lines, line, -1, last),
  moveDown: (lines, line, last) => move(lines, line, 1, last),
  moveRight: indent,
  moveLeft: outdent,
} satisfies Record<string, Make>;

/**
 * Keys that move a bullet are the bullet's even when there is nowhere to move it: the editor's own
 * Alt+↑ would move the line out from over what is under it, and its Alt+← and Alt+→ on a Mac move
 * the cursor a word. Off a bullet they are the editor's.
 */
const KEPT: readonly string[] = ["moveUp", "moveDown", "moveRight", "moveLeft"];

/**
 * Each bullet key's command: what it does, and whether the key is its now. Tab and Shift+Tab with
 * nothing to do are left to whatever else would take them: in a note, its own Tab, which keeps the
 * key there.
 */
export const bulletCommands = {
  ...(Object.fromEntries(Object.entries(MAKES).map(([name, make]) => [name, { when: () => (KEPT.includes(name) ? onBullet() !== null : ready(make) !== null), run: () => edit(make) }])) as Record<keyof typeof MAKES, { when: () => boolean; run: () => void }>),
  select: {
    when: () => onBullet() !== null,
    /** The bullet and everything under it, from the start of its line to the end of its last. Again, the bullet it is under, and so on out. */
    run() {
      const at = onBullet(true);
      if (!at) return;
      const { state } = at.view;
      const span = (item: Item) => ({ anchor: state.doc.line(item.line + 1).from, head: state.doc.line(item.end).to });
      const { from, to } = state.selection.main;
      const covered = (item: Item) => from <= span(item).anchor && to >= span(item).head;
      let item = bulletAt(state, at.line)!;
      for (let up = parentOf(linesIn(state.doc), item); up && covered(item); up = parentOf(linesIn(state.doc), up)) item = up;
      at.view.dispatch({ selection: span(item), scrollIntoView: true, userEvent: "select" });
    },
  },
  toggleFold: {
    /** A bullet folds when it has something under it. */
    when() {
      const at = onBullet();
      const item = at && bulletAt(at.view.state, at.line);
      return !!item && item.end - item.line > 1;
    },
    run() {
      const at = onBullet(true);
      if (at) at.view.dispatch({ effects: toggleFold.of(at.view.state.doc.line(at.line + 1).from) });
    },
  },
  foldAll: {
    when: () => focused() !== null,
    /** Every bullet with something under it that isn't itself under a bullet folded with it. */
    run() {
      const view = focused(true);
      if (!view) return;
      const { state } = view;
      const froms: number[] = [];
      for (let n = 0; n < state.doc.lines; n++) {
        const item = hasUnder(linesIn(state.doc), n) && bulletAt(state, n);
        if (!item) continue;
        froms.push(state.doc.line(n + 1).from);
        n = item.end - 1;
      }
      fold(view, froms, true);
    },
  },
  unfoldAll: {
    when: () => focused() !== null,
    run: () => focused(true)?.dispatch({ effects: foldsAre.of([]) }),
  },
};

/**
 * The bullets of one editor. `kept` is what was folded when the note was last open here, and
 * `keep` is told what is folded each time that changes.
 */
export function bulletEditing(kept: readonly Kept[], keep: (folded: Kept[]) => void): Extension {
  const restored = folds.init((state) =>
    made(
      state,
      RangeSet.of(
        kept.filter(({ line, text }) => line < state.doc.lines && state.doc.line(line + 1).text === text).map(({ line }) => folded.range(state.doc.line(line + 1).from)),
        true,
      ),
    ),
  );
  const keeping = EditorView.updateListener.of((update) => {
    const [was, now] = [update.startState.field(folds), update.state.field(folds)];
    if (was.folds === now.folds || (!was.folds.length && !now.folds.length)) return;
    keep(now.folds.map((f) => ({ line: update.state.doc.lineAt(f.from).number - 1, text: update.state.doc.lineAt(f.from).text })));
  });
  return [restored, clickingFolded, bullets, keeping, remembered, reachable, look];
}
