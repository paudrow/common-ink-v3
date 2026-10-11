import { syntaxTree } from "@codemirror/language";
import { EditorState, Facet, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { keptBelow } from "./below.ts";
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
    const el = document.createElement(this.written.block ? "div" : "span");
    el.className = this.written.block ? "embed embed-block" : "embed";
    el.dataset.embed = this.embed.name;
    this.draw(el, view, (handed) => this.embed.render(el, handed));
    return el;
  }

  /**
   * Shows a changed embed in the element the one before it had, so nothing is taken out of the note
   * and put back. An embed that said how to change what it drew is asked to. Any other is drawn
   * again in the same element, and what had focus in it has it again.
   */
  override updateDOM(el: HTMLElement, view: EditorView) {
    if (el.dataset.embed !== this.embed.name || (el.tagName === "DIV") !== this.written.block) return false;
    const was = live.get(el);
    if (was?.update) {
      this.draw(el, view, (handed) => (was.update!(handed), was));
      return true;
    }
    const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    this.draw(el, view, (handed) => {
      was?.stop?.();
      el.replaceChildren();
      el.removeAttribute("title");
      return this.embed.render(el, handed);
    });
    if (focused !== undefined) [...el.querySelectorAll<HTMLElement>("[data-focus]")].find((e) => e.dataset.focus === focused)?.focus();
    return true;
  }

  private draw(el: HTMLElement, view: EditorView, show: (handed: Embedded) => ReturnType<Embed["render"]>) {
    const { embed, written } = this;
    /** What the note says here now, if it is still what this was drawn from. */
    const still = () => {
      const now = writtenAt(view, el, written.block);
      return now && sameWritten(now, written) ? now : undefined;
    };
    const rewrite = (next: { config?: string; body?: string }) => {
      const now = !view.state.readOnly && still();
      const changes = now && rewriteOf(now, next);
      if (changes && changes.length) view.dispatch({ changes, userEvent: "input.embed" });
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
        edit() {
          const now = still();
          if (!now) return;
          view.focus();
          view.dispatch({ selection: { anchor: now.block ? now.bodyFrom : now.configFrom }, effects: now.block ? revealing.of(now.from) : [], scrollIntoView: true });
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
  }

  override destroy(el: HTMLElement) {
    live.get(el)?.stop?.();
    live.delete(el);
  }

  /** What happens inside an embed is the embed's, so a click on it doesn't move the cursor. */
  override ignoreEvent() {
    return true;
  }
}

const widgetFor = (state: EditorState, embed: Embed, written: Written) => new EmbedWidget(embed, written, state.sliceDoc(written.from, written.to), state.readOnly);

/** With the cursor on it, an inline embed is shown as it is written, so it can be changed, as the markup around it is. */
const cursorOn = (state: EditorState, focused: boolean, { from, to }: { from: number; to: number }) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

function inlineDrawn(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const byName = state.facet(registered);
  const drawnBlocks = state.field(blocks).all.filter((b) => byName.get(b.name)?.block);
  for (const { from, to } of view.visibleRanges) {
    for (const written of inlineIn(state.sliceDoc(from, to), from)) {
      const embed = byName.get(written.name);
      // One with something kept below it is shown as written with the cursor anywhere on its line, as markdown is: what is below stays.
      const line = embed?.below && state.doc.lineAt(written.from);
      if (!embed || embed.block || cursorOn(state, view.hasFocus, line ?? written) || /Code/.test(syntaxTree(state).resolveInner(written.from, 1).name)) continue;
      // A block's body is the block's to draw.
      if (drawnBlocks.some((b) => b.from <= written.from && b.to >= written.to)) continue;
      builder.add(written.from, written.to, Decoration.replace({ widget: widgetFor(state, embed, written) }));
    }
  }
  return builder.finish();
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
 * Keeps the cursor out of a block's hidden lines, where it couldn't be seen and a key would break
 * the block. A cursor sent into them, by an arrow key or by vim, lands on the far side instead.
 * Only `edit` puts it there, which shows the lines.
 */
const steppingOver = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.newSelection.main.empty || tr.effects.some((e) => e.is(revealing))) return tr;
  const { all, revealed } = tr.startState.field(blocks);
  const { head } = tr.newSelection.main;
  const hidden = drawnBy(tr.startState, all).find((b) => b.from !== revealed && head >= b.from && head <= b.to);
  if (!hidden) return tr;
  const after = hidden.to < tr.startState.doc.length ? hidden.to + 1 : null;
  const before = hidden.from > 0 ? hidden.from - 1 : null;
  const anchor = tr.startState.selection.main.head <= hidden.from ? (after ?? before) : (before ?? after);
  return anchor === null ? tr : [tr, { selection: { anchor }, sequential: true }];
});

/**
 * Draws each `::name{config}` and each `:::name{config}` block in a note with the embed registered
 * under that name, and keeps what an embed draws below its line. A name nobody registered stays as
 * text. Which embeds there are is said with `embedsAre`.
 */
export const embedding: Extension = [blocks, steppingOver, inline, keptBelow((state) => ({ embeds: state.facet(registered), blocks: state.field(blocks).all }))];

export const embedsAre = (embeds: readonly Embed[]): Extension => registered.of(embeds);
