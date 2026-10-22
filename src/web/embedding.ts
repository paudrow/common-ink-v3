import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, Facet, Prec, StateField, Transaction, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { aloneIn, aloneOn, boxOf, keptBelow } from "./below.ts";
import { closeOptions, fitSettingsButton, optionsOn, settingsOf, type Options } from "./embedOptions.ts";
import { blocksIn, inlineIn, rewriteOf, sameWritten, type Written } from "../core/embedSyntax.ts";
import { following } from "./following.ts";
import type { AddressEmbed, Drawn, Embed, Embedded } from "./plugin-api.ts";
import { isReading } from "./readOnly.ts";

type ByName = ReadonlyMap<string, Embed>;

/** An embed that draws something in its line or as a block. */
type Drawing = Embed & Required<Pick<Embed, "render">>;

const drawing = (embed: Embed | undefined): embed is Drawing => !!embed?.render;

/** The embeds plugins have registered, by name. */
const registered = Facet.define<readonly Embed[], ByName>({ combine: (values) => new Map(values.flat().map((e) => [e.name, e])) });

/** What plugins show for an address alone on a line, in the order they were registered. */
const addressed = Facet.define<readonly AddressEmbed[], readonly AddressEmbed[]>({ combine: (values) => values.flat() });

/** What each drawn embed gave back: how to stop it, and how to change it where it stands if it knows how. */
const live = new WeakMap<HTMLElement, Drawn>();

/** The embed the note writes where `el` is drawn now, which may not be what `el` was drawn from. */
function writtenAt(view: EditorView, el: HTMLElement, block: boolean): Written | undefined {
  // For an element that has left the editor, CodeMirror answers with an end of the note, where an embed just like this one may be written.
  if (!view.dom.contains(el)) return undefined;
  const pos = view.posAtDOM(el);
  if (block) return view.state.field(blocks).all.find((b) => b.to === pos);
  const line = view.state.doc.lineAt(pos);
  return inlineIn(line.text, line.from).find((w) => w.from === pos);
}

/** The element an embed draws in, inside the card the host draws around it. */
const drawingIn = (frame: HTMLElement) => frame.querySelector<HTMLElement>(".embed")!;
/** The room an embed keeps below its line, where what it shows is, as a third-party plugin's frame is: what its options open beneath. */
function roomOf(frame: HTMLElement): HTMLElement | null {
  const next = frame.closest(".cm-line")?.nextElementSibling;
  // The room's box is the size of what is drawn over it; the room around it has the gaps.
  return next instanceof HTMLElement && next.classList.contains("embed-below-room") ? (next.querySelector<HTMLElement>("[data-below]") ?? next) : null;
}

const optionsIn = (frame: HTMLElement) => frame.querySelector<HTMLButtonElement>(".embed-options");

/**
 * An embed's drawing. The element CodeMirror keeps is a frame the host owns, and in it a card: an
 * inline embed's card is the frame itself, with the drawing and then the options button on one row,
 * and a block's card has a head with the embed's title and the options button, and the drawing under it.
 */
class EmbedWidget extends WidgetType {
  constructor(
    private readonly embed: Drawing,
    private readonly written: Written,
    private readonly source: string,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: EmbedWidget) {
    return other.embed === this.embed && other.readOnly === this.readOnly && sameWritten(other.written, this.written);
  }

  override toDOM(view: EditorView) {
    const { block } = this.written;
    const frame = document.createElement(block ? "div" : "span");
    frame.className = block ? "embed-frame embed-frame-block" : "embed-frame embed-card";
    const card = block ? frame.appendChild(document.createElement("div")) : frame;
    // The title is drawn from this and not written in the card, so an embed adds no words to its line.
    const titled = block ? card.appendChild(document.createElement("div")) : frame;
    if (block) {
      card.className = "embed-card";
      titled.className = "embed-head";
    }
    titled.dataset.title = this.embed.title;
    // What a block keeps below it is the rest of its card, so the card ends open and that closes it.
    if (block && this.embed.below) frame.classList.add("embed-joined");
    const el = card.appendChild(document.createElement(block ? "div" : "span"));
    el.className = block ? "embed embed-block" : "embed";
    el.dataset.embed = this.embed.name;
    // A press on the card that is on nothing the embed drew puts the cursor in the embed as written.
    frame.addEventListener("click", (e) => {
      if (e.target === frame || e.target === card || e.target === titled) pressed.get(frame)?.();
    });
    this.draw(frame, el, view, (handed) => this.embed.render(el, handed));
    return frame;
  }

  /**
   * Shows a changed embed in the element the one before it had, so nothing is taken out of the note
   * and put back. An embed that said how to change what it drew is asked to. Any other is drawn
   * again in the same element, and what had focus in it has it again.
   */
  override updateDOM(frame: HTMLElement, view: EditorView) {
    const el = frame.querySelector<HTMLElement>(".embed");
    if (!el || el.dataset.embed !== this.embed.name || (el.tagName === "DIV") !== this.written.block) return false;
    const was = live.get(el);
    if (was?.update) {
      this.draw(frame, el, view, (handed) => (was.update!(handed), was));
      return true;
    }
    const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    this.draw(frame, el, view, (handed) => {
      was?.stop?.();
      el.replaceChildren();
      el.removeAttribute("title");
      return this.embed.render(el, handed);
    });
    if (focused !== undefined) [...el.querySelectorAll<HTMLElement>("[data-focus]")].find((e) => e.dataset.focus === focused)?.focus();
    return true;
  }

  private draw(frame: HTMLElement, el: HTMLElement, view: EditorView, show: (handed: Embedded) => ReturnType<Drawing["render"]>) {
    const { embed, written } = this;
    /** What the note says here now, if it is still what this was drawn from. */
    const still = () => {
      const now = writtenAt(view, frame, written.block);
      return now && sameWritten(now, written) ? now : undefined;
    };
    const rewrite = (next: { config?: string; body?: string }) => {
      const now = !view.state.readOnly && still();
      const changes = now && rewriteOf(now, next);
      if (changes && changes.length) view.dispatch({ changes, userEvent: "input.embed" });
    };
    const edit = (at?: number) => {
      const now = still();
      if (!now) return;
      const anchor = at === undefined || !now.block ? now.configFrom : now.bodyFrom + Math.max(0, Math.min(at, now.body.length));
      view.focus();
      view.dispatch({ selection: { anchor }, scrollIntoView: true, annotations: placed.of(true) });
    };
    pressed.set(frame, () => edit());
    let drawing = true;
    try {
      const drawn = show({
        config: written.config,
        body: written.body,
        noteId: view.state.facet(noteOf),
        readOnly: this.readOnly,
        update(next) {
          // The editor can't be changed while it is drawing, which is when `render` runs.
          if (drawing) queueMicrotask(() => rewrite(next));
          else rewrite(next);
        },
        edit,
      });
      live.set(el, typeof drawn === "function" ? { stop: drawn } : (drawn ?? {}));
    } catch (err) {
      // An embed that can't be drawn is shown as it is written, with why on hover.
      live.get(el)?.stop?.();
      live.delete(el);
      el.replaceChildren(this.source);
      el.title = `${embed.title} couldn't be shown: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      drawing = false;
    }
    this.fitOptions(frame, still, rewrite);
  }

  /**
   * Gives the card its settings button, or takes it away, to fit what the note says of the embed now,
   * and says what is wrong with its config: a red edge on the card, a line under a block's head, and a
   * warning on the button. It is drawn all the same, as its own reading of the config allows.
   */
  private fitOptions(frame: HTMLElement, still: () => Written | undefined, rewrite: (next: { config?: string; body?: string }) => void) {
    const { embed, written } = this;
    const settings = settingsOf(embed);
    const problems = settings?.problems({ config: written.config, body: written.body }) ?? [];
    const card = written.block ? frame.querySelector<HTMLElement>(".embed-card")! : frame;
    card.classList.toggle("embed-invalid", problems.length > 0);
    let said = card.querySelector<HTMLElement>(":scope > .embed-problems");
    if (written.block && problems.length) {
      said ??= card.insertBefore(document.createElement("p"), card.querySelector(".embed-head")?.nextSibling ?? null);
      said.className = "embed-problems";
      said.textContent = problems.join(" ");
    } else said?.remove();
    const optionsFor = (now: Written | undefined): Options | null => (now && settings && !this.readOnly ? optionsOn(embed.title, settings, now, rewrite) : null);
    // What is drawn now is what the note says now. Where it is in the note can't be asked while the note is being drawn.
    fitSettingsButton(frame.querySelector<HTMLElement>(".embed-head") ?? frame, "embed-options", optionsFor(written), {
      under: () => roomOf(frame) ?? frame.querySelector<HTMLElement>(".embed-card") ?? frame,
      read: () => optionsFor(still()),
    });
  }

  override destroy(frame: HTMLElement) {
    const el = drawingIn(frame);
    live.get(el)?.stop?.();
    live.delete(el);
    const button = optionsIn(frame);
    if (button) closeOptions(button);
  }

  /** What happens inside an embed is the embed's, so a click on it doesn't move the cursor. */
  override ignoreEvent() {
    return true;
  }
}

/** What a press on a frame's own card, off what the embed drew, does now. */
const pressed = new WeakMap<HTMLElement, () => void>();

const widgetFor = (state: EditorState, embed: Drawing, written: Written) => new EmbedWidget(embed, written, state.sliceDoc(written.from, written.to), state.readOnly);

/** On a cursor the host puts in an embed itself, which is where it says and nowhere else. */
const placed = Annotation.define<true>();

/**
 * Whether the cursor has been put anywhere. A note opens with its cursor at its start, where nobody
 * put it, and nothing is shown as written for that: an embed at the top of a note would open as
 * text, and move under the first press on the note. From the first time the cursor is placed or
 * something is typed, its place counts, whether or not the keyboard is still in the note: a press on
 * an embed's own button takes the keyboard out of the text, and what is shown as written above that
 * embed must not go from under the pointer.
 */
const used = StateField.define<boolean>({
  create: () => false,
  // An embed's own rewrite of its text is no use of the cursor: a press on its button leaves the cursor wherever it was.
  update: (value, tr) => value || tr.selection !== undefined || (tr.isUserEvent("input") && !tr.isUserEvent("input.embed")) || tr.isUserEvent("delete"),
});

/** With the cursor on it, an embed is shown as it is written, so it can be changed, as the markup around it is. */
const cursorOn = (state: EditorState, { from, to }: Pick<Written, "from" | "to">) => state.field(used) && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const unseen = Decoration.replace({});
const asText = Decoration.mark({ class: "embed-written" });
/** A drawn embed's text, shown after its drawing while the cursor is on it. */
const asSource = Decoration.mark({ class: "embed-source" });
/** A line that is one such embed and nothing else is only as tall as its text as written. */
const alone = Decoration.line({ class: "embed-alone" });

/**
 * An inline embed's drawing is a widget of its own before the embed's text, and the text is hidden
 * after it. With the cursor on the embed its text is shown where it is written, after the drawing,
 * which stays the element it was, doing what it was doing.
 */
function inlineDrawn(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { state } = view;
  const byName = state.facet(registered);
  const drawnBlocks = drawnBy(state, state.field(blocks).all);
  for (const { from, to } of view.visibleRanges) {
    for (const written of inlineIn(state.sliceDoc(from, to), from)) {
      const embed = byName.get(written.name);
      if (!embed || embed.block || /Code/.test(syntaxTree(state).resolveInner(written.from, 1).name)) continue;
      // A block's body is the block's to draw.
      if (drawnBlocks.some((b) => b.from <= written.from && b.to >= written.to)) continue;
      const lone = aloneIn(state, written);
      // All of it is below its line: there is nothing of it in the line but its text, while the cursor is on it. A line it is alone on is out of sight with the cursor elsewhere, and shown with the cursor anywhere on it.
      if ((!drawing(embed) || (lone && embed.below?.alone)) && boxOf(embed, written)) {
        ranges.push(((lone ? aloneOn(state, written.from, state.field(used)) : cursorOn(state, written)) ? asText : unseen).range(written.from, written.to));
        if (lone) ranges.push(alone.range(state.doc.lineAt(written.from).from));
        continue;
      }
      if (!drawing(embed)) continue;
      ranges.push(Decoration.widget({ widget: widgetFor(state, embed, written), side: -1 }).range(written.from));
      ranges.push((cursorOn(state, written) ? asSource : unseen).range(written.from, written.to));
    }
  }
  return Decoration.set(ranges, true);
}

const inline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDrawn(view);
    }
    update(update: ViewUpdate) {
      const changed = update.docChanged || update.viewportChanged || update.selectionSet || update.startState.field(used) !== update.state.field(used);
      if (changed || update.startState.facet(registered) !== update.state.facet(registered) || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = inlineDrawn(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

interface Blocks {
  /** Every block the note writes, whether or not a plugin draws it. */
  all: readonly Written[];
  /** Where the block starts whose markdown is shown, because the cursor is in it. */
  revealed: number | null;
  drawn: DecorationSet;
}

const drawnBy = (state: EditorState, all: readonly Written[]) => all.filter((b) => state.facet(registered).get(b.name)?.block && drawing(state.facet(registered).get(b.name)));

/**
 * A block's drawing is a widget of its own under the block's lines, and the lines are hidden above
 * it. So the drawing is never taken out to show the markdown: with the cursor in the lines they are
 * shown above it, and it is lower by them and no more.
 */
function blocksDrawn(state: EditorState, all: readonly Written[], revealed: number | null): DecorationSet {
  const byName = state.facet(registered);
  /** Each of a shown block's lines is marked as written, to be drawn as an inline embed's text is. */
  const shown = (written: Written) => {
    const lines: Range<Decoration>[] = [];
    for (let n = state.doc.lineAt(written.from).number; n <= state.doc.lineAt(written.to).number; n++) lines.push(asWritten.range(state.doc.line(n).from));
    return lines;
  };
  return Decoration.set(
    drawnBy(state, all).flatMap((written) => [
      ...(written.from === revealed ? shown(written) : [Decoration.replace({ block: true }).range(written.from, written.to)]),
      Decoration.widget({ widget: widgetFor(state, byName.get(written.name) as Drawing, written), block: true, side: 1 }).range(written.to),
    ]),
    true,
  );
}

const asWritten = Decoration.line({ class: "embed-source-line" });

/** Decorations that take whole lines can only come from the state, so the blocks are kept here. */
const blocks: StateField<Blocks> = StateField.define<Blocks>({
  create(state) {
    const all = blocksIn(state.doc.toString());
    return { all, revealed: null, drawn: blocksDrawn(state, all, null) };
  },
  update(value, tr) {
    const all = tr.docChanged ? blocksIn(tr.state.doc.toString()) : value.all;
    const { head } = tr.state.selection.main;
    const revealed = tr.state.field(used) ? (all.find((b) => head >= b.from && head <= b.to)?.from ?? null) : null;
    if (all === value.all && revealed === value.revealed && tr.startState.facet(registered) === tr.state.facet(registered) && tr.startState.readOnly === tr.state.readOnly) return value;
    return { all, revealed, drawn: blocksDrawn(tr.state, all, revealed) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.drawn),
});

/** The drawn blocks whose lines are hidden. */
const hidden = (state: EditorState) => drawnBy(state, state.field(blocks).all).filter((b) => b.from !== state.field(blocks).revealed);

/** Whether `pos` is on the line right above `block` or right below it. */
function nextTo(state: EditorState, pos: number, block: Written): "above" | "below" | null {
  const line = state.doc.lineAt(pos);
  return line.to + 1 === block.from ? "above" : line.from - 1 === block.to ? "below" : null;
}

/** Where the cursor comes into `block` from the line next to it: its first line from above and its last from below, as far along as it was. */
function into(state: EditorState, block: Written, from: "above" | "below", pos: number): number {
  const line = state.doc.lineAt(from === "above" ? block.from : block.to);
  return Math.min(line.from + pos - state.doc.lineAt(pos).from, line.to);
}

/**
 * Whether a move from the line `side` of `block` to `head` is a step of one line that way: `head` is
 * in the block, in a hidden block that follows it with no line between, or on the first line past those.
 */
function steps(state: EditorState, block: Written, side: "above" | "below", head: number): boolean {
  const blocks = hidden(state);
  let [start, end] = [block.from, block.to];
  for (let next; side === "above" && (next = blocks.find((b) => b.from === end + 1)); ) end = next.to;
  for (let next; side === "below" && (next = blocks.find((b) => b.to === start - 1)); ) start = next.from;
  if (head >= start && head <= end) return true;
  return side === "above" ? head > end && state.doc.lineAt(head).from === end + 1 : head < start && state.doc.lineAt(head).to === start - 1;
}

/**
 * A block's hidden lines have no height, so a move by rows goes over them. Vim's j and k take the
 * cursor from the line next to a block to the line on its far side, or to wherever in it vim's own
 * count of lines falls, and say nothing of what they are: such a move goes to the block's nearest
 * line instead, which shows its lines. A key, a press, a search and the like say what they are, and
 * go where they say, and so does a cursor the host places itself.
 */
const steppingIn = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.newSelection.main.empty || tr.annotation(Transaction.userEvent) !== undefined || tr.annotation(placed)) return tr;
  const state = tr.startState;
  const { head } = tr.newSelection.main;
  const from = state.selection.main.head;
  for (const block of hidden(state)) {
    const side = nextTo(state, from, block);
    if (!side || !steps(state, block, side, head)) continue;
    const anchor = into(state, block, side, from);
    return state.doc.lineAt(anchor).from === state.doc.lineAt(head).from ? tr : [tr, { selection: { anchor }, sequential: true }];
  }
  return tr;
});

/** The arrow keys go into a block's hidden lines as into any others: Down on the last row of the line above it, and Up on the first row of the line below. */
const arrowsIn = Prec.high(
  keymap.of(
    (["above", "below"] as const).map((side) => ({
      key: side === "above" ? "ArrowDown" : "ArrowUp",
      run(view: EditorView) {
        const { state } = view;
        const { main } = state.selection;
        const block = main.empty && state.selection.ranges.length === 1 ? hidden(state).find((b) => nextTo(state, main.head, b) === side) : undefined;
        if (!block) return false;
        const line = state.doc.lineAt(main.head);
        const moved = view.moveVertically(main, side === "above").head;
        // On a line that wraps, the key moves within the line until its last row.
        if (moved >= line.from && moved <= line.to && moved !== main.head) return false;
        view.dispatch({ selection: { anchor: into(state, block, side, main.head) }, scrollIntoView: true, userEvent: "select" });
        return true;
      },
    })),
  ),
);

/** The note an editor holds, which each embed drawn in it is told. */
const noteOf = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });

/** Vim's gd on an embed in a line clicks what the embed marked `data-follow`: a file's link, a reference's chip. */
const pressedAt = following.of((view) => {
  const { head } = view.state.selection.main;
  for (const frame of view.contentDOM.querySelectorAll<HTMLElement>(".embed-frame.embed-card")) {
    // A frame of an editor inside an embed is that editor's.
    if (frame.closest(".cm-editor") !== view.dom) continue;
    const written = writtenAt(view, frame, false);
    if (!written || head < written.from || head >= written.to) continue;
    const follows = drawingIn(frame).querySelector<HTMLElement>("[data-follow]");
    follows?.click();
    return !!follows;
  }
  return false;
});

/**
 * Draws each `::name{config}` and each `:::name{config}` block in note `noteId` with the embed registered
 * under that name, and keeps what an embed draws below its line. A name nobody registered stays as
 * text. Which embeds there are is said with `embedsAre`.
 */
export const embedding = (noteId: string): Extension => [noteOf.of(noteId), used, blocks, steppingIn, arrowsIn, pressedAt, Prec.lowest(inline), keptBelow((state) => ({ noteId: state.facet(noteOf), embeds: state.facet(registered), addresses: state.facet(addressed), blocks: state.field(blocks).all, written: state.field(used) && !isReading(state) }))];

export const embedsAre = (embeds: readonly (Embed | AddressEmbed)[]): Extension => [registered.of(embeds.filter((e): e is Embed => !("claims" in e))), addressed.of(embeds.filter((e): e is AddressEmbed => "claims" in e))];
