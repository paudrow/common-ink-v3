import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, RangeSet, RangeValue, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { drawnInView, touched, writable } from "../lib/live.ts";
import { mathBlocksIn, type Formula } from "../math/syntax.ts";
import { indent, itemAt, move, outdent, type Edit, type Item, type Lines } from "./outline.ts";

const linesIn = (doc: Text): Lines => ({ count: doc.lines, at: (n) => doc.line(n + 1).text });

const mathOf = new WeakMap<Text, Formula[]>();

/**
 * The bullet on line `n` of the note, counting from 0, if the note's markdown has a list item
 * there. A line that only looks like one, in a code block or a block of math, is not a bullet:
 * nothing draws it as one, and no bullet key moves it.
 */
function bulletAt(state: EditorState, n: number): Item | null {
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

class Toggle extends WidgetType {
  constructor(private readonly isFolded: boolean) {
    super();
  }

  override eq(other: Toggle) {
    return other.isFolded === this.isFolded;
  }

  override toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "bullet-toggle";
    el.textContent = this.isFolded ? "▸" : "▾";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.isFolded ? "Unfold" : "Fold");
    el.setAttribute("aria-expanded", String(!this.isFolded));
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

/** The mark stays in the line and a dot is painted over it, so a bullet's text is where it is when the mark is shown. */
const dot = Decoration.mark({ class: "bullet-dot" });
/** A task's box is its mark enough: its bullet's mark keeps its room and is painted as nothing. Only where the box is drawn, which is at the start of a line. */
const blank = Decoration.mark({ class: "bullet-blank" });

/** A dot for each bullet's mark, or nothing on a task's, except the mark the cursor is on, and a fold toggle beside each bullet with something under it. */
const bullets = drawnInView((view) => {
  const { state } = view;
  const drawn: Range<Decoration>[] = [];
  const isFolded = new Set(state.field(folds).folds.map((f) => f.from));
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "ListMark") return;
        const line = state.doc.lineAt(node.from);
        const item = bulletAt(state, line.number - 1);
        if (item && item.end - item.line > 1) drawn.push(Decoration.widget({ widget: new Toggle(isFolded.has(line.from)), side: -1 }).range(node.from));
        if (node.node.parent?.parent?.name === "BulletList" && !touched(state, node.from, node.to)) drawn.push((node.node.nextSibling?.name === "Task" && !state.sliceDoc(line.from, node.from).trim() ? blank : dot).range(node.from, node.to));
      },
    });
  }
  return drawn;
}, (update) => update.startState.field(folds).folds !== update.state.field(folds).folds);

const look = EditorView.baseTheme({
  // The mark's own letter is there and not painted, as a ghost is, and the dot is painted over it.
  ".bullet-dot, .bullet-blank": { position: "relative", WebkitTextFillColor: "transparent" },
  ".bullet-dot::before": { content: '"•"', position: "absolute", left: "0", right: "0", textAlign: "center", WebkitTextFillColor: "var(--muted)" },
  ".bullet-toggle": { position: "absolute", marginLeft: "-1.15em", width: "1em", textAlign: "center", color: "var(--muted)", cursor: "pointer", userSelect: "none", fontSize: "0.85em", opacity: "0.55" },
  ".bullet-toggle:hover, .bullet-toggle[aria-expanded=false]": { opacity: "1", color: "var(--accent)" },
  ".bullet-folded": { marginLeft: "0.4em", padding: "0 0.4em", borderRadius: "4px", backgroundColor: "var(--accent-soft)", color: "var(--accent)", cursor: "pointer" },
});

/** The note editor that has the keyboard, if its cursor is on a bullet. */
function onBullet(): { view: EditorView; line: number } | null {
  const view = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null;
  if (!view || view.contentDOM !== document.activeElement || !view.state.field(folds, false)) return null;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  return bulletAt(view.state, line) ? { view, line } : null;
}

type Make = (lines: Lines, line: number) => Edit | null;

/** The edit a bullet key would make now, and where: nothing when the cursor isn't on a bullet, the note can't be changed, or the bullet has nowhere to go. */
function ready(make: Make) {
  const at = onBullet();
  const made = at && writable(at.view.state) ? make(linesIn(at.view.state.doc), at.line) : null;
  return at && made ? { ...at, made } : null;
}

/** Makes an outline edit in the editor as the member's own: the lines change, the cursor stays on its bullet, and folded bullets stay folded where they land. */
function edit(make: Make) {
  const at = ready(make);
  if (!at) return;
  const { view, line, made } = at;
  const { state } = view;
  const [from, to] = [state.doc.line(made.from + 1).from, state.doc.line(made.to).to];
  const insert = made.lines.join("\n");
  const head = state.selection.main.head;
  const column = Math.max(0, head - state.doc.line(line + 1).from + made.shift);
  const after = state.update({ changes: { from, to, insert } }).state.doc;
  const landed = (n: number) => after.line(made.after(n) + 1);
  const cursor = landed(line);
  const foldedLines = state.field(folds).folds.map((f) => state.doc.lineAt(f.from).number - 1);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: Math.min(cursor.from + column, cursor.to) },
    effects: foldsAre.of(foldedLines.map((n) => landed(n).from)),
    scrollIntoView: true,
    userEvent: "move.bullet",
  });
}

const MAKES = { indent, outdent, moveUp: (lines, line) => move(lines, line, -1), moveDown: (lines, line) => move(lines, line, 1) } satisfies Record<string, Make>;

/** A key that moves a bullet is the bullet's even when there is nowhere to move it, so the editor's own Alt+arrow doesn't move the line out from over what is under it. */
const KEPT: readonly string[] = ["moveUp", "moveDown"];

/**
 * Each bullet key's command: what it does, and whether the key is its now. Tab and Shift+Tab with
 * nothing to do are left to whatever else would take them, so Tab on the first bullet of a list is
 * the browser's Tab.
 */
export const bulletCommands = {
  ...(Object.fromEntries(Object.entries(MAKES).map(([name, make]) => [name, { when: () => (KEPT.includes(name) ? onBullet() !== null : ready(make) !== null), run: () => edit(make) }])) as Record<keyof typeof MAKES, { when: () => boolean; run: () => void }>),
  toggleFold: {
    /** A bullet folds when it has something under it. */
    when() {
      const at = onBullet();
      const item = at && bulletAt(at.view.state, at.line);
      return !!item && item.end - item.line > 1;
    },
    run() {
      const at = onBullet();
      if (at) at.view.dispatch({ effects: toggleFold.of(at.view.state.doc.line(at.line + 1).from) });
    },
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
  return [restored, clickingFolded, bullets, keeping, look];
}
