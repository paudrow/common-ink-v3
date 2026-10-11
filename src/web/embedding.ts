import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Embed } from "./plugin-api.ts";

/** An embed as a note writes it, on one line: `::name{config}`. */
const WRITTEN = /::([a-z][a-z0-9-]*)\{([^{}\n]*)\}/g;

/** What each drawn embed asked to have stopped when it goes. */
const stops = new WeakMap<HTMLElement, () => void>();

class EmbedWidget extends WidgetType {
  constructor(
    private readonly embed: Embed,
    private readonly config: string,
    private readonly written: string,
  ) {
    super();
  }

  override eq(other: EmbedWidget) {
    return other.embed === this.embed && other.config === this.config;
  }

  override toDOM() {
    const el = document.createElement("span");
    el.className = "embed";
    el.dataset.embed = this.embed.name;
    try {
      const stop = this.embed.render(el, { config: this.config });
      if (stop) stops.set(el, stop);
    } catch (err) {
      // An embed that can't be drawn is shown as it is written, with why on hover.
      el.replaceChildren(this.written);
      el.title = `${this.embed.title} couldn't be shown: ${err instanceof Error ? err.message : String(err)}`;
    }
    return el;
  }

  override destroy(el: HTMLElement) {
    stops.get(el)?.();
  }

  /** What happens inside an embed is the embed's, so a click on it doesn't move the cursor. */
  override ignoreEvent() {
    return true;
  }
}

function drawn(view: EditorView, byName: ReadonlyMap<string, Embed>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    for (const match of state.sliceDoc(from, to).matchAll(WRITTEN)) {
      const start = from + match.index;
      const end = start + match[0].length;
      const embed = byName.get(match[1]!);
      // With the cursor on it, an embed is shown as it is written, so it can be changed.
      const editing = view.hasFocus && state.selection.ranges.some((r) => r.from <= end && r.to >= start);
      if (!embed || editing || /Code/.test(syntaxTree(state).resolveInner(start, 1).name)) continue;
      builder.add(start, end, Decoration.replace({ widget: new EmbedWidget(embed, match[2]!, match[0]) }));
    }
  }
  return builder.finish();
}

/** Draws each `::name{config}` in a note with the embed registered under that name. A name nobody registered stays as text. */
export function embedding(embeds: readonly Embed[]): Extension {
  if (!embeds.length) return [];
  const byName = new Map(embeds.map((e) => [e.name, e]));
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = drawn(view, byName);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = drawn(update.view, byName);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
