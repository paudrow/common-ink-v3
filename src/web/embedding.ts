import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, Facet, Prec, StateEffect, StateField, Transaction, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { keptBelow } from "./below.ts";
import { closeOptions, refreshOptions, toggleOptions, type Options } from "./embedOptions.ts";
import { blocksIn, inlineIn, rewriteOf, sameWritten, type Written } from "./embedSyntax.ts";
import type { Drawn, Embed, Embedded } from "./plugin-api.ts";

type ByName = ReadonlyMap<string, Embed>;

/** The embeds plugins have registered, by name. */
const registered = Facet.define<readonly Embed[], ByName>({ combine: (values) => new Map(values.flat().map((e) => [e.name, e])) });

/** What each drawn embed gave back: how to stop it, and how to change it where it stands if it knows how. */
const live = new WeakMap<HTMLElement, Drawn>();

/** The embed the note writes where `el` is drawn now, which may not be what `el` was drawn from. */
function writtenAt(view: EditorView, el: HTMLElement, block: boolean): Written | undefined {
  // For an element that has left the editor, CodeMirror answers with an end of the note, where an embed just like this one may be written.
  if (!view.dom.contains(el)) return undefined;
  const pos = view.posAtDOM(el);
  if (block) return view.state.field(blocks).all.find((b) => b.from === pos);
  const line = view.state.doc.lineAt(pos);
  return inlineIn(line.text, line.from).find((w) => w.from === pos);
}

/** How each options button reads its embed's options now. */
const optionsOf = new WeakMap<HTMLElement, () => Options | null>();

/**
 * An embed's drawing. The element CodeMirror keeps is a frame the host owns: the embed draws in the
 * frame's first element, and its options button, when it has one, is the frame's second.
 */
class EmbedWidget extends WidgetType {
  constructor(
    private readonly embed: Embed,
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
    frame.className = block ? "embed-frame embed-frame-block" : "embed-frame";
    const el = frame.appendChild(document.createElement(block ? "div" : "span"));
    el.className = block ? "embed embed-block" : "embed";
    el.dataset.embed = this.embed.name;
    this.draw(frame, el, view, (handed) => this.embed.render(el, handed));
    return frame;
  }

  /**
   * Shows a changed embed in the element the one before it had, so nothing is taken out of the note
   * and put back. An embed that said how to change what it drew is asked to. Any other is drawn
   * again in the same element, and what had focus in it has it again.
   */
  override updateDOM(frame: HTMLElement, view: EditorView) {
    const el = frame.firstElementChild as HTMLElement | null;
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

  private draw(frame: HTMLElement, el: HTMLElement, view: EditorView, show: (handed: Embedded) => ReturnType<Embed["render"]>) {
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
    const edit = () => {
      const now = still();
      if (!now) return;
      view.focus();
      view.dispatch({ selection: { anchor: now.block ? now.bodyFrom : now.configFrom }, effects: now.block ? revealing.of(now.from) : [], scrollIntoView: true });
    };
    let drawing = true;
    try {
      const drawn = show({
        config: written.config,
        body: written.body,
        readOnly: this.readOnly,
        update(next) {
          // The editor can't be changed while it is drawing, which is when `render` runs.
          if (drawing) queueMicrotask(() => rewrite(next));
          else rewrite(next);
        },
        edit,
        leave(to) {
          const now = still();
          const anchor = now?.block ? beside(view.state, now, to) : null;
          if (anchor === null) return;
          view.focus();
          view.dispatch({ selection: { anchor }, scrollIntoView: true, annotations: placed.of(true) });
        },
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
    this.fitOptions(frame, still, rewrite, edit);
  }

  /** Gives the frame its options button, or takes it away, to fit what the note says of the embed now. */
  private fitOptions(frame: HTMLElement, still: () => Written | undefined, rewrite: (next: { config?: string; body?: string }) => void, edit: () => void) {
    const { embed, written } = this;
    const fieldsOf = (now: Written) => {
      try {
        return embed.options?.fields({ config: now.config, body: now.body }) ?? [];
      } catch {
        return [];
      }
    };
    let button = frame.querySelector<HTMLButtonElement>(":scope > .embed-options");
    if (this.readOnly || !(written.block || fieldsOf(written).length)) {
      if (button) closeOptions(button);
      button?.remove();
      frame.classList.remove("with-options");
      return;
    }
    frame.classList.add("with-options");
    if (!button) {
      const made = (button = frame.appendChild(document.createElement("button")));
      made.type = "button";
      made.className = "embed-options";
      made.setAttribute("aria-haspopup", "dialog");
      made.setAttribute("aria-expanded", "false");
      made.addEventListener("click", () => toggleOptions(made, () => optionsOf.get(made)?.() ?? null));
    }
    button.title = `Options for ${embed.title}`;
    button.setAttribute("aria-label", button.title);
    optionsOf.set(button, () => {
      const now = still();
      if (!now) return null;
      return {
        title: embed.title,
        fields: fieldsOf(now),
        edit,
        set(id, value) {
          try {
            const next = embed.options!.set({ config: now.config, body: now.body }, id, value);
            if (typeof next === "string") return next;
            rewrite(next);
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
      };
    });
    refreshOptions(button);
  }

  override destroy(frame: HTMLElement) {
    const el = frame.firstElementChild as HTMLElement;
    live.get(el)?.stop?.();
    live.delete(el);
    const button = frame.querySelector<HTMLElement>(":scope > .embed-options");
    if (button) closeOptions(button);
  }

  /** What happens inside an embed is the embed's, so a click on it doesn't move the cursor. */
  override ignoreEvent() {
    return true;
  }
}

const widgetFor = (state: EditorState, embed: Embed, written: Written) => new EmbedWidget(embed, written, state.sliceDoc(written.from, written.to), state.readOnly);

/** With the cursor on it, an inline embed is shown as it is written, so it can be changed, as the markup around it is. */
const cursorOn = (state: EditorState, focused: boolean, { from, to }: { from: number; to: number }) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const unseen = Decoration.replace({});
const asWritten = Decoration.mark({ class: "embed-source" });

/**
 * With the cursor on it an inline embed is shown as written and its drawing is taken out, as markup
 * is. A `live` embed's drawing is doing something that would be lost that way, so it is a widget of
 * its own before the embed's text, and the text is hidden after it: with the cursor on it the text is
 * shown after the drawing, which stays the element it was, where it was, doing what it was doing.
 */
function inlineDrawn(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { state } = view;
  const byName = state.facet(registered);
  const drawnBlocks = state.field(blocks).all.filter((b) => byName.get(b.name)?.block);
  for (const { from, to } of view.visibleRanges) {
    for (const written of inlineIn(state.sliceDoc(from, to), from)) {
      const embed = byName.get(written.name);
      if (!embed || embed.block || /Code/.test(syntaxTree(state).resolveInner(written.from, 1).name)) continue;
      // A block's body is the block's to draw.
      if (drawnBlocks.some((b) => b.from <= written.from && b.to >= written.to)) continue;
      // One with something kept below it is shown as written with the cursor anywhere on its line, as markdown is: what is below stays.
      const line = embed.below && state.doc.lineAt(written.from);
      const on = cursorOn(state, view.hasFocus, line || written);
      const widget = widgetFor(state, embed, written);
      if (embed.live) ranges.push(Decoration.widget({ widget, side: -1 }).range(written.from), (on ? asWritten : unseen).range(written.from, written.to));
      else if (!on) ranges.push(Decoration.replace({ widget }).range(written.from, written.to));
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
      const changed = update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged;
      if (changed || update.startState.facet(registered) !== update.state.facet(registered) || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = inlineDrawn(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Asks for a block to be shown as written, under its drawing, with the cursor in it. The number is where the block starts. */
const revealing = StateEffect.define<number>({ map: (from, changes) => changes.mapPos(from) });

interface Blocks {
  /** Every block the note writes, whether or not a plugin draws it. */
  all: readonly Written[];
  /** Where the block starts whose markdown is shown, because the member asked to edit it and the cursor is still in it. */
  revealed: number | null;
  drawn: DecorationSet;
}

const drawnBy = (state: EditorState, all: readonly Written[]) => all.filter((b) => state.facet(registered).get(b.name)?.block);

/**
 * A block's drawing is a widget of its own above the block's lines, and the lines are hidden under
 * it. So the drawing is never taken out to show the markdown: the lines are shown or hidden beneath it.
 */
function blocksDrawn(state: EditorState, all: readonly Written[], revealed: number | null): DecorationSet {
  const byName = state.facet(registered);
  return Decoration.set(
    drawnBy(state, all).flatMap((written) => [
      Decoration.widget({ widget: widgetFor(state, byName.get(written.name)!, written), block: true, side: -1 }).range(written.from),
      ...(written.from === revealed ? [] : [Decoration.replace({ block: true }).range(written.from, written.to)]),
    ]),
    true,
  );
}

/** Decorations that take whole lines can only come from the state, so the blocks are kept here. */
const blocks: StateField<Blocks> = StateField.define<Blocks>({
  create(state) {
    const all = blocksIn(state.doc.toString());
    return { all, revealed: null, drawn: blocksDrawn(state, all, null) };
  },
  update(value, tr) {
    const all = tr.docChanged ? blocksIn(tr.state.doc.toString()) : value.all;
    const asked = tr.effects.reduce<number | null>((was, e) => (e.is(revealing) ? e.value : was), value.revealed === null ? null : tr.changes.mapPos(value.revealed));
    const { head } = tr.state.selection.main;
    // It stays shown for as long as the cursor is in it.
    const revealed = all.some((b) => b.from === asked && head >= b.from && head <= b.to) ? asked : null;
    if (all === value.all && revealed === value.revealed && tr.startState.facet(registered) === tr.state.facet(registered) && tr.startState.readOnly === tr.state.readOnly) return value;
    return { all, revealed, drawn: blocksDrawn(tr.state, all, revealed) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.drawn),
});

/**
 * Where the cursor goes on the far side of `block`: the end of the line above it or the start of the
 * line below, past any other block whose lines are hidden there. Null where the note has no such line.
 */
function beside(state: EditorState, block: Written, to: "above" | "below"): number | null {
  const drawn = unrevealed(state);
  for (let at: Written | undefined = block; at; ) {
    const pos: number = to === "above" ? at.from - 1 : at.to + 1;
    if (pos < 0 || pos > state.doc.length) return null;
    at = drawn.find((b) => pos >= b.from && pos <= b.to);
    if (!at) return pos;
  }
  return null;
}

/** On a cursor the host puts beside a block itself, which is then not sent into the block. */
const placed = Annotation.define<true>();

const unrevealed = (state: EditorState) => drawnBy(state, state.field(blocks).all).filter((b) => b.from !== state.field(blocks).revealed);

/** Whether `pos` is on the line right above `block` or right below it. */
function nextTo(state: EditorState, pos: number, block: Written): "above" | "below" | null {
  const line = state.doc.lineAt(pos);
  return line.to + 1 === block.from ? "above" : line.from - 1 === block.to ? "below" : null;
}

/** Asks the drawing of the block starting at `block` to take the keyboard. `over` is where the cursor goes if it doesn't. */
const entering = StateEffect.define<{ block: number; from: "above" | "below"; over: number | null }>();

/**
 * Keeps the cursor out of a block's hidden lines, where it couldn't be seen and a key would break
 * the block. A cursor sent into them, by an arrow key or by vim, lands on the far side instead.
 * Coming from the line next to a block whose drawing takes the keyboard, it stays where it is and
 * the drawing is asked to. Only `edit` puts the cursor in the lines, which shows them.
 */
const steppingOver = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.newSelection.main.empty || tr.annotation(placed) || tr.effects.some((e) => e.is(revealing))) return tr;
  const state = tr.startState;
  const { head } = tr.newSelection.main;
  const from = state.selection.main.head;
  const drawn = unrevealed(state);
  const hidden = drawn.find((b) => head >= b.from && head <= b.to);
  // Vim's j and k take the cursor from the line above a block to the line below it by themselves, and back, and say nothing of what they are. A key, a press, a search and the like say, and go where they say.
  const passed = hidden || tr.annotation(Transaction.userEvent) !== undefined ? undefined : drawn.find((b) => (nextTo(state, from, b) === "above" && state.doc.lineAt(head).from - 1 === b.to) || (nextTo(state, from, b) === "below" && state.doc.lineAt(head).to + 1 === b.from));
  const block = hidden ?? passed;
  if (!block) return tr;
  const side = from <= block.from ? "above" : "below";
  const over = passed ? head : (beside(state, block, side === "above" ? "below" : "above") ?? beside(state, block, side));
  if (nextTo(state, from, block) && !tr.isUserEvent("select.pointer") && state.facet(registered).get(block.name)?.entered)
    return [tr, { selection: state.selection, effects: entering.of({ block: block.from, from: side, over }), sequential: true }];
  return passed || over === null ? tr : [tr, { selection: { anchor: over }, sequential: true }];
});

/**
 * The arrow keys go over a block's hidden lines by themselves, so a block that takes the keyboard is
 * entered here: Down on the last row of the line above it, and Up on the first row of the line below.
 */
const arrowsIn = Prec.high(
  keymap.of(
    (["above", "below"] as const).map((side) => ({
      key: side === "above" ? "ArrowDown" : "ArrowUp",
      run(view: EditorView) {
        const { state } = view;
        const { main } = state.selection;
        const block = main.empty && state.selection.ranges.length === 1 ? unrevealed(state).find((b) => nextTo(state, main.head, b) === side && state.facet(registered).get(b.name)?.entered) : undefined;
        const line = state.doc.lineAt(main.head);
        const moved = view.moveVertically(main, side === "above").head;
        // On a line that wraps, the key moves within the line until its last row.
        if (!block || (moved >= line.from && moved <= line.to && moved !== main.head)) return false;
        view.dispatch({ effects: entering.of({ block: block.from, from: side, over: beside(state, block, side === "above" ? "below" : "above") }) });
        return true;
      },
    })),
  ),
);

const entry = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      for (const tr of update.transactions)
        for (const effect of tr.effects) {
          if (!effect.is(entering)) continue;
          const { block, from, over } = effect.value;
          // Focus leaves the note here, and the note can't be changed while it is being updated.
          queueMicrotask(() => {
            const { view } = update;
            const frame = [...view.contentDOM.querySelectorAll<HTMLElement>(".embed-frame-block")].find((f) => view.posAtDOM(f) === block);
            let took = false;
            try {
              took = (frame && live.get(frame.firstElementChild as HTMLElement)?.enter?.(from)) === true;
            } catch {
              // A drawing that can't take the keyboard is gone over.
            }
            if (!took && over !== null) view.dispatch({ selection: { anchor: over }, scrollIntoView: true, annotations: placed.of(true) });
          });
        }
    }
  },
);

/**
 * Draws each `::name{config}` and each `:::name{config}` block in a note with the embed registered
 * under that name, and keeps what an embed draws below its line. A name nobody registered stays as
 * text. Which embeds there are is said with `embedsAre`.
 */
export const embedding: Extension = [blocks, steppingOver, arrowsIn, entry, inline, keptBelow((state) => ({ embeds: state.facet(registered), blocks: state.field(blocks).all }))];

export const embedsAre = (embeds: readonly Embed[]): Extension => registered.of(embeds);
