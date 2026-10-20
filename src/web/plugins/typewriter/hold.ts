import { Facet, RangeSetBuilder, Transaction, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from "@codemirror/view";

/** Where the cursor's line is kept, as a share of the pane's height from its top, whether the other blocks are dimmed, and whether vim's zt, zz and zb set where it is kept. Null is off. */
export type Hold = { at: number; dim: boolean; asked: boolean } | null;

/** The note editor the member is writing in: the one with focus, or the one that had it last, as while the command palette has it. */
export class Writing {
  last: EditorView | null = null;
  // The same plugin in every hold, so that a new hold still knows which editor it is.
  readonly tracking = ViewPlugin.define((view) => {
    if (view.hasFocus) this.last = view;
    return {
      update: (update: ViewUpdate) => {
        if (update.focusChanged && view.hasFocus) this.last = view;
      },
      destroy: () => {
        if (this.last === view) this.last = null;
      },
    };
  });
}

/** Where a pane is on screen, how tall it is inside and how far it is scrolled. */
export interface Pane {
  top: number;
  height: number;
  scrollTop: number;
}

/** A row of text on screen. */
export interface Row {
  top: number;
  bottom: number;
}

/** Where a row as tall as `size` has its middle when held at `at`, from the pane's top: inside the pane, so 0 has its top at the pane's top and 1 its foot at the pane's foot. */
export const heldMiddle = (pane: Pane, size: number, at: number) => Math.min(Math.max(at * pane.height, size / 2), pane.height - size / 2);

/** The scroll that puts `row` at the height `at` of the pane. */
export const heldScroll = (pane: Pane, row: Row, at: number) => pane.scrollTop + (row.top + row.bottom) / 2 - (pane.top + heldMiddle(pane, row.bottom - row.top, at));

/** The height, in percent of the pane from its top, that a line with its middle at `middle` is at now, as a hold takes it. */
export const heightOf = (pane: Pane, middle: number) => Math.min(100, Math.max(0, Math.round((100 * (middle - pane.top)) / pane.height)));

/**
 * The room above the first row and under the last that lets each be held at `at` and no further: `lead` is how far the first row is
 * from the top of what scrolls, and `trail` how far the last is from the foot, without the room.
 */
export const roomFor = (pane: Pane, at: number, first: { size: number; lead: number }, last: { size: number; trail: number }) => ({
  above: Math.max(0, heldMiddle(pane, first.size, at) - first.size / 2 - first.lead),
  below: Math.max(0, pane.height - heldMiddle(pane, last.size, at) - last.size / 2 - last.trail),
});

/** A run of lines, by number. */
export interface Lines {
  first: number;
  last: number;
}

/** The lines of the paragraph `pos` is in: the run of lines with words around it. A blank line is a paragraph of its own. */
export function paragraphAt(state: EditorState, pos: number): Lines {
  const { doc } = state;
  const blank = (n: number) => !/\S/.test(doc.line(n).text);
  let first = doc.lineAt(pos).number;
  let last = first;
  if (blank(first)) return { first, last };
  while (first > 1 && !blank(first - 1)) first--;
  while (last < doc.lines && !blank(last + 1)) last++;
  return { first, last };
}

const LISTS = new Set(["BulletList", "OrderedList"]);
/** The markdown blocks that hold others. A line in one and in no block inside it, as a blank line between blocks or a quote's `>` alone, is lit alone. */
const HOLDERS = new Set(["Document", "Blockquote", ...LISTS]);

/**
 * The lines of the markdown block `pos` is in, by the note's syntax tree: a list item's own lines without the lists inside it, or the
 * whole of the innermost block around the line, such as a heading, a paragraph, a code block or a table. Where the tree isn't
 * parsed past the line yet, as far down a long note, it is the paragraph.
 */
export function blockAt(state: EditorState, pos: number): Lines {
  const { doc } = state;
  const line = doc.lineAt(pos);
  const tree = syntaxTree(state);
  // Parsed to the start of the next line at least, where a parse stops only between blocks.
  if (tree.length < Math.min(doc.length, line.to + 1)) return paragraphAt(state, pos);
  const linesOf = (node: { from: number; to: number }): Lines => ({ first: doc.lineAt(node.from).number, last: doc.lineAt(node.to).number });
  // From the end of the line's words, which are in its block where its start may be a list's or a quote's mark.
  const end = tree.resolveInner(line.from + line.text.trimEnd().length, -1);
  let leaf: typeof end | null = null;
  for (let node: typeof end | null = end; node; node = node.parent) {
    if (node.name === "ListItem") {
      const own = linesOf(node);
      for (let inner = node.firstChild; inner; inner = inner.nextSibling) {
        if (!LISTS.has(inner.name)) continue;
        const nested = linesOf(inner);
        if (nested.first > line.number) own.last = Math.min(own.last, nested.first - 1);
        else if (nested.last < line.number) own.first = Math.max(own.first, nested.last + 1);
      }
      return own;
    }
    // Between a list's items.
    if (LISTS.has(node.name)) break;
    if (!leaf && node.type.is("Block") && !HOLDERS.has(node.name)) leaf = node;
  }
  return leaf ? linesOf(leaf) : { first: line.number, last: line.number };
}

/** The runs of lines that dimming leaves lit, in order: every block a range of the selection touches, from its start's to its end's. */
export function litLines(state: EditorState): Lines[] {
  const runs = state.selection.ranges.map((range) => ({ first: blockAt(state, range.from).first, last: blockAt(state, range.to).last })).sort((a, b) => a.first - b.first);
  const lit: Lines[] = [];
  for (const run of runs) {
    const before = lit.at(-1);
    if (before && run.first <= before.last + 1) before.last = Math.max(before.last, run.last);
    else lit.push(run);
  }
  return lit;
}

/** What scrolls a note's editor: the nearest box around it that scrolls, since the editor itself never does. */
export function paneOf(view: EditorView): HTMLElement | null {
  for (let el = view.scrollDOM.parentElement; el; el = el.parentElement) if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  return null;
}

const paneNow = (pane: HTMLElement): Pane => ({ top: pane.getBoundingClientRect().top + pane.clientTop, height: pane.clientHeight, scrollTop: pane.scrollTop });

const middleOf = (row: Row) => (row.top + row.bottom) / 2;

/** The cursor's line's height in its pane now, for keeping it there, or null when the member hasn't a note's line in view. */
export function heightNow(writing: Writing): number | null {
  const view = writing.last?.dom.isConnected ? writing.last : null;
  const pane = view && paneOf(view);
  const row = pane && view.coordsAtPos(view.state.selection.main.head);
  return pane && row ? heightOf(paneNow(pane), middleOf(row)) : null;
}

/** Where a line was on screen: a place in it, and how far its middle was from the pane's top. */
interface Spot {
  pos: number;
  middle: number;
}

/** Where each held editor's cursor's line was last, or the line at its pane's top when the cursor's was out of sight, for turning the hold off without moving it. */
const spots = new WeakMap<EditorView, Spot>();

/** A line kept where it is on screen, measured once the editor's layout can be read. */
function spotNow(view: EditorView, box: Pane): Spot | null {
  const head = view.state.selection.main.head;
  const row = view.coordsAtPos(head);
  if (row && row.bottom > box.top && row.top < box.top + box.height) return { pos: head, middle: middleOf(row) - box.top };
  const pos = view.lineBlockAtHeight(box.top - view.documentTop).from;
  const top = view.coordsAtPos(pos, 1);
  return top && { pos, middle: middleOf(top) - box.top };
}

/** The hold one editor is given, with whom to tell a height vim asked for. */
interface Holding {
  at: number;
  asked: boolean;
  writing: Writing;
  /** Keeps the height, in percent; false when it couldn't be. */
  keep: (height: number) => boolean;
}

const holding = Facet.define<Holding, Holding | undefined>({ combine: (all) => all[0] });

/** The heights vim's zt, zz and zb ask for, by the user event of their scroll. */
const ASKED: Partial<Record<string, number>> = { "scroll.cursor.start": 0, "scroll.cursor.center": 0.5, "scroll.cursor.end": 1 };

const ROOM = ["--typewriter-above", "--typewriter-below"] as const;

interface Measured {
  pane: HTMLElement;
  above: number | null;
  below: number | null;
  scrollTop: number | null;
}

/**
 * Holds the cursor's line at its height in one editor and keeps the room above the first line and under the last. It is the same
 * plugin in every hold, so a new height or dimming changes only what it measures, and the room stays as it was in between.
 */
class Keeper implements PluginValue {
  /** The height held: the hold's, or the one vim asked for until it comes back as the hold's. */
  at: number;
  /** Whether the line is at its height and the pane hasn't been moved by hand since, so the line goes back there when the text or the pane changes size. */
  held: boolean;
  /** What is to be put at the height in the next measure. */
  target: SelectionRange | null = null;
  pane: HTMLElement | null = null;
  readonly frame: number;
  watching: ResizeObserver | null = null;
  readonly measure = { key: this, read: () => this.read(), write: (measured: Measured | null) => measured && this.write(measured) };
  readonly byHand = () => void (this.held = false);
  readonly scrolled = () => this.view.requestMeasure(this.measure);

  constructor(readonly view: EditorView) {
    this.at = this.given().at;
    this.held = this.inUse();
    if (this.held) this.target = view.state.selection.main;
    view.requestMeasure(this.measure);
    // The pane is looked for once the editor is in the page. A pane being watched is told its size at once.
    this.frame = requestAnimationFrame(() => {
      const pane = paneOf(view);
      if (!pane) return;
      this.pane = pane;
      this.watching = new ResizeObserver(() => {
        this.rehold();
        view.requestMeasure(this.measure);
      });
      this.watching.observe(pane);
      for (const type of ["wheel", "touchmove", "pointerdown"]) pane.addEventListener(type, this.byHand, { passive: true });
      pane.addEventListener("scroll", this.scrolled, { passive: true });
    });
  }

  given() {
    return this.view.state.facet(holding)!;
  }

  /** Whether this is the editor the member is writing in. */
  inUse() {
    return this.view.hasFocus || this.given().writing.last === this.view;
  }

  /** Brings the line back to its height if it was there, in the editor being written in: another's pane is left as it is. */
  rehold() {
    if (!this.held || !this.inUse()) return;
    if (!this.view.hasFocus) {
      this.target = this.view.state.selection.main;
      this.view.requestMeasure(this.measure);
      return;
    }
    // With focus the editor keeps its lines in place itself as their heights change, and adds that to any scroll made as it measures
    // but one it was asked for, which it can't be while it updates.
    queueMicrotask(() => this.view.plugin(keeping) === this && this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main) }));
  }

  /** Puts `range` at the height in the next measure, or says it can't be: with no pane, the editor scrolls as it would. */
  scrollTo(range: SelectionRange) {
    if (!paneOf(this.view)) return false;
    this.target = range;
    this.held = true;
    this.view.requestMeasure(this.measure);
    return true;
  }

  update(update: ViewUpdate) {
    const was = update.startState.facet(holding);
    const now = this.given();
    if (was && was.at !== now.at) {
      this.at = now.at;
      this.rehold();
    }
    for (const tr of update.transactions) {
      const asked = now.asked ? ASKED[tr.annotation(Transaction.userEvent) ?? ""] : undefined;
      if (asked === undefined || asked === this.at) continue;
      const before = this.at;
      this.at = asked;
      // Not while the editor is updating: keeping the height makes a new hold for every editor.
      queueMicrotask(() => {
        if (!now.keep(asked * 100) && this.at === asked) this.at = before;
      });
    }
    // Text that changes size with nothing typed, as for a new text size or a picture loading.
    if (update.geometryChanged && !update.transactions.length) this.rehold();
    if (update.geometryChanged || update.viewportChanged || was !== now) this.view.requestMeasure(this.measure);
  }

  read(): Measured | null {
    const { view } = this;
    const pane = paneOf(view);
    // A pane not shown has no height to make room in.
    if (!pane?.clientHeight) return null;
    const box = paneNow(pane);
    const style = getComputedStyle(view.contentDOM);
    const padding = { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) };
    const content = view.contentDOM.getBoundingClientRect();
    // The first and last rows are measured while they are drawn; one far off the screen keeps the room it had.
    const start = view.coordsAtPos(0, 1);
    const end = view.coordsAtPos(view.state.doc.length, -1);
    const first = { size: start ? start.bottom - start.top : 0, lead: start ? start.top - (box.top - box.scrollTop) - padding.top : 0 };
    const last = { size: end ? end.bottom - end.top : 0, trail: end ? content.bottom - padding.bottom - end.bottom : 0 };
    const room = roomFor(box, this.at, first, last);
    const above = start && Math.round(room.above);
    const below = end && Math.round(room.below);
    // New room above moves everything under it, so the scroll moves with it and what is on screen stays where it is.
    const shift = above === null ? 0 : above - padding.top;
    let scrollTop = shift ? box.scrollTop + shift : null;
    const target = this.target;
    this.target = null;
    if (target) {
      const row = view.coordsAtPos(target.head, target.assoc || (target.head > target.anchor ? -1 : 1)) ?? this.estimate(target.head);
      scrollTop = heldScroll(box, { top: row.top + shift, bottom: row.bottom + shift }, this.at);
    }
    const spot = spotNow(view, box);
    if (spot) spots.set(view, spot);
    return { pane, above, below, scrollTop };
  }

  /** Where the line holding `pos` is by the editor's reckoning, for one not drawn yet. */
  estimate(pos: number): Row {
    const block = this.view.lineBlockAt(pos);
    return { top: this.view.documentTop + block.top, bottom: this.view.documentTop + block.bottom };
  }

  write({ pane, above, below, scrollTop }: Measured) {
    const { style } = this.view.contentDOM;
    if (above !== null) style.setProperty(ROOM[0], `${above}px`);
    if (below !== null) style.setProperty(ROOM[1], `${below}px`);
    if (scrollTop !== null) pane.scrollTop = scrollTop;
  }

  // The room is left on the text: it is drawn only while the editor is held, and a new hold begins from it.
  destroy() {
    cancelAnimationFrame(this.frame);
    this.watching?.disconnect();
    for (const type of ["wheel", "touchmove", "pointerdown"]) this.pane?.removeEventListener(type, this.byHand);
    this.pane?.removeEventListener("scroll", this.scrolled);
  }
}

const keeping = ViewPlugin.fromClass(Keeper);

/** With the hold off, puts the line that was held back where it was on screen, which the room going away would move: as far as the top of the note lets it. */
const leaving = ViewPlugin.define((view) => {
  const spot = spots.get(view);
  spots.delete(view);
  if (spot)
    view.requestMeasure({
      read: () => {
        const pane = paneOf(view);
        const row = pane?.clientHeight && view.coordsAtPos(Math.min(spot.pos, view.state.doc.length), 1);
        return pane && row ? { pane, scrollTop: pane.scrollTop + middleOf(row) - paneNow(pane).top - spot.middle } : null;
      },
      write: (left) => {
        if (left) left.pane.scrollTop = left.scrollTop;
      },
    });
  return {};
});

const DIM = Decoration.line({ class: "cm-typewriter-dim" });

function dimmed(view: EditorView): DecorationSet {
  const lit = litLines(view.state);
  const builder = new RangeSetBuilder<Decoration>();
  let done = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.number > done && !lit.some((run) => line.number >= run.first && line.number <= run.last)) builder.add(line.from, line.from, DIM);
      done = line.number;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const dimming = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = dimmed(view);
    }
    update(update: ViewUpdate) {
      // A tree parsed further can find the block a line is in where it had only the paragraph.
      if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = dimmed(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Typewriter mode in one note's editor: every scroll the editor asks for puts the cursor's line at the hold's height instead. With
 * `asked`, a scroll with the user event `scroll.cursor.start`, `.center` or `.end`, as vim's zt, zz and zb send, sets the height,
 * and `keep` is told it in percent. Off, it only notes the editor being written in and leaves a line that was held where it is.
 */
export function typewriter(hold: Hold, writing: Writing, keep: (height: number) => boolean): Extension[] {
  if (!hold) return [writing.tracking, leaving];
  return [
    writing.tracking,
    holding.of({ at: hold.at, asked: hold.asked, writing, keep }),
    keeping,
    EditorView.scrollHandler.of((view, range) => view.plugin(keeping)?.scrollTo(range) ?? false),
    EditorView.editorAttributes.of({ class: "cm-typewriter" }),
    hold.dim ? dimming : [],
  ];
}
