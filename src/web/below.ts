import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { keep } from "./belowIdentity.ts";
import { inlineIn, rewriteOf, type Written } from "./embedSyntax.ts";
import { guardFrames } from "./frameGuard.ts";
import type { Below, BelowBox, Embed } from "./plugin-api.ts";

/** One embed with something kept below its line. */
interface Shown {
  id: number;
  from: number;
  name: string;
  /** What the note says of it. While this stays the same, what is drawn for it is left alone. */
  source: string;
  /** The end of the line it is kept under. */
  at: number;
  embed: Embed & { below: Below };
  written: Written;
  box: BelowBox;
}

let ids = 0;

/** Above and below each box, in pixels. */
const GAP = 6;

const sameBox = (a: BelowBox, b: BelowBox) => ("ratio" in a ? "ratio" in b && a.ratio === b.ratio : "height" in b && a.height === b.height);

/** How tall each box was when last measured, for the ones sized by their width. */
const heights = new Map<number, number>();

/**
 * The room kept in the note for what is drawn below a line. It is only room: what fills it is an
 * element outside the note's text, which CodeMirror never makes again or moves.
 */
class BoxWidget extends WidgetType {
  constructor(
    readonly id: number,
    private readonly box: BelowBox,
  ) {
    super();
  }

  override eq(other: BoxWidget) {
    return other.id === this.id && sameBox(other.box, this.box);
  }

  override get estimatedHeight() {
    const inner = "height" in this.box ? this.box.height : heights.get(this.id);
    return inner === undefined ? -1 : inner + 2 * GAP;
  }

  override toDOM() {
    const el = document.createElement("div");
    el.className = "embed-below-room";
    el.style.paddingBlock = `${GAP}px`;
    const box = el.appendChild(document.createElement("div"));
    box.dataset.below = String(this.id);
    if ("ratio" in this.box) box.style.aspectRatio = String(this.box.ratio);
    else box.style.height = `${this.box.height}px`;
    return el;
  }

  override ignoreEvent() {
    return true;
  }
}

interface Reading {
  embeds: ReadonlyMap<string, Embed>;
  blocks: readonly Written[];
}

function boxOf(embed: Embed & { below: Below }, written: Written): BelowBox | null {
  try {
    const box = embed.below.box({ config: written.config, body: written.body });
    if (!box) return null;
    const size = "ratio" in box ? box.ratio : box.height;
    return Number.isFinite(size) && size > 0 ? box : null;
  } catch {
    return null;
  }
}

function read(state: EditorState, { embeds, blocks }: Reading, before: readonly Shown[], moved: (pos: number) => number): Shown[] {
  const has = (embed: Embed | undefined): embed is Embed & { below: Below } => !!embed?.below;
  const drawnBlocks = blocks.filter((b) => embeds.get(b.name)?.block);
  const found: Written[] = drawnBlocks.filter((b) => has(embeds.get(b.name)));
  if ([...embeds.values()].some((e) => !e.block && has(e))) {
    for (const written of inlineIn(state.doc.toString())) {
      const embed = embeds.get(written.name);
      if (!has(embed) || embed.block || drawnBlocks.some((b) => b.from <= written.from && b.to >= written.to)) continue;
      if (/Code/.test(syntaxTree(state).resolveInner(written.from, 1).name)) continue;
      found.push(written);
    }
    found.sort((a, b) => a.from - b.from);
  }
  const boxed = found.flatMap((written) => {
    const embed = embeds.get(written.name) as Embed & { below: Below };
    const box = boxOf(embed, written);
    return box ? [{ written, embed, box, from: written.from, name: written.name, source: `${written.config}\n${written.body}` }] : [];
  });
  // An embed another plugin now draws is not the one that was there, whatever the note says.
  const same = before.filter((was) => embeds.get(was.embed.name) === was.embed);
  const kept = keep(same, boxed, moved, () => ++ids);
  return boxed.map((one, index) => ({ ...one, id: kept[index]!, at: state.doc.lineAt(one.written.to).to }));
}

/**
 * Keeps what embeds draw below their lines: a video, a frame. Each has room kept for it in the note,
 * under the line that writes it, whether or not the cursor is on that line, and is drawn once in an
 * element of its own. Typing anywhere else, lines coming and going, the cursor, other people's
 * changes and scrolling leave that element alone: it is only moved to where its room is. When the
 * note says something else of that embed, it is drawn again in the same element. `reading` says which embeds there are and which
 * blocks the note writes.
 */
export function keptBelow(reading: (state: EditorState) => Reading): Extension {
  const rooms = (shown: readonly Shown[]) => Decoration.set(shown.map((s): Range<Decoration> => Decoration.widget({ widget: new BoxWidget(s.id, s.box), block: true, side: 1 }).range(s.at)), true);

  const field = StateField.define<{ shown: readonly Shown[]; rooms: DecorationSet; reading: Reading }>({
    create(state) {
      const now = reading(state);
      const shown = read(state, now, [], (pos) => pos);
      return { shown, rooms: rooms(shown), reading: now };
    },
    update(value, tr) {
      const now = reading(tr.state);
      const reread = tr.docChanged || now.embeds !== value.reading.embeds || now.blocks !== value.reading.blocks || syntaxTree(tr.startState) !== syntaxTree(tr.state);
      if (!reread) return value;
      const shown = read(tr.state, now, value.shown, (pos) => tr.changes.mapPos(pos, 1));
      return { shown, rooms: rooms(shown), reading: now };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.rooms),
  });

  interface Place {
    left: number;
    top: number;
    width: number;
    height: number;
  }
  interface Live {
    /** The box, which is placed over the room. */
    el: HTMLElement;
    /** Where the embed draws, inside the box. */
    drawn: HTMLElement;
    /** What the note said of the embed when this was drawn. */
    source: string;
    stop: (() => void) | void;
    unguard: () => void;
    place?: Place;
  }

  const layer = ViewPlugin.fromClass(
    class {
      readonly dom: HTMLElement;
      readonly live = new Map<number, Live>();
      readonly measure: { key: object; read: (view: EditorView) => Map<number, Place & { seen: boolean }>; write: (places: Map<number, Place & { seen: boolean }>, view: EditorView) => void };

      constructor(view: EditorView) {
        this.dom = view.scrollDOM.appendChild(document.createElement("div"));
        this.dom.className = "embed-below-layer";
        this.measure = { key: this, read: (v) => this.places(v), write: (places, v) => this.place(places, v) };
        this.settle(view);
      }

      update(update: ViewUpdate) {
        this.settle(update.view);
      }

      /** Takes out what the note no longer writes as it was, and asks where the rest go. */
      settle(view: EditorView) {
        const shown = new Set(view.state.field(field).shown.map((s) => s.id));
        for (const [id, live] of this.live) if (!shown.has(id)) this.drop(id, live);
        view.requestMeasure(this.measure);
      }

      drop(id: number, live: Live) {
        this.stop(live);
        live.unguard();
        live.el.remove();
        this.live.delete(id);
        heights.delete(id);
      }

      /** Where each one's room is, from the room itself when it is on screen and from the note's heights when it isn't. */
      places(view: EditorView) {
        const places = new Map<number, Place & { seen: boolean }>();
        const base = view.scrollDOM.getBoundingClientRect();
        const [dx, dy] = [view.scrollDOM.scrollLeft - base.left, view.scrollDOM.scrollTop - base.top];
        for (const { id, at } of view.state.field(field).shown) {
          const room = view.contentDOM.querySelector<HTMLElement>(`[data-below="${id}"]`);
          if (room) {
            const rect = room.getBoundingClientRect();
            heights.set(id, rect.height);
            places.set(id, { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height, seen: rect.bottom > 0 && rect.top < window.innerHeight });
            continue;
          }
          const was = this.live.get(id)?.place;
          const line = view.lineBlockAt(at);
          const part = (Array.isArray(line.type) ? line.type : [line]).find((b) => b.widget instanceof BoxWidget && b.widget.id === id);
          if (was && part) places.set(id, { ...was, top: view.documentTop + part.top + GAP + dy, seen: false });
        }
        return places;
      }

      place(places: Map<number, Place & { seen: boolean }>, view: EditorView) {
        for (const shown of view.state.field(field).shown) {
          const place = places.get(shown.id);
          let live = this.live.get(shown.id);
          // Nothing is drawn until its room has been on screen, so a note costs only what was looked at.
          if (!live && place?.seen) {
            const el = document.createElement("div");
            el.className = "embed-below";
            el.dataset.embed = shown.embed.name;
            // In the page before it is drawn in: a frame made in an element that is put in later would load twice.
            this.dom.append(el);
            const drawn = el.appendChild(document.createElement("div"));
            drawn.className = "embed-below-drawn";
            const { id } = shown;
            const made: Live = (live = { el, drawn, source: shown.source, stop: undefined, unguard: guardFrames(el, () => this.taken(made, id, view)).stop });
            this.live.set(id, made);
            this.draw(made, shown, view);
          }
          if (!live) continue;
          // The note says something else of it now: it is drawn again, in the element and the place it has.
          if (live.source !== shown.source) {
            this.stop(live);
            live.drawn.replaceChildren();
            this.draw(live, shown, view);
          }
          // With no room, as inside something else that is drawn, it is kept and not shown.
          live.el.style.visibility = place ? "" : "hidden";
          if (!place) continue;
          const was = live.place;
          if (was && was.left === place.left && was.top === place.top && was.width === place.width && was.height === place.height) continue;
          live.place = { left: place.left, top: place.top, width: place.width, height: place.height };
          Object.assign(live.el.style, { left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px`, height: `${place.height}px` });
        }
      }

      draw(live: Live, { id, embed, written, source }: Shown, view: EditorView) {
        live.source = source;
        let drawing = true;
        /** Rewrites the embed in the note, if the note still says of it what this was drawn from. */
        const rewrite = (next: { config?: string; body?: string }) => {
          const now = view.state.field(field, false)?.shown.find((s) => s.id === id);
          if (!now || now.source !== source || view.state.readOnly || this.live.get(id) !== live) return;
          const changes = rewriteOf(now.written, next);
          if (changes.length) view.dispatch({ changes, userEvent: "input.embed" });
        };
        try {
          live.stop = embed.below.render(live.drawn, {
            config: written.config,
            body: written.body,
            readOnly: view.state.readOnly,
            // The editor can't be changed while it is being measured, which is when this is drawn.
            update: (next) => (drawing ? queueMicrotask(() => rewrite(next)) : rewrite(next)),
          });
        } catch (err) {
          live.drawn.replaceChildren(`${embed.title} couldn't be shown: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          drawing = false;
        }
      }

      /** A frame in it took the keyboard from the member: it is stopped, and says so, until the member asks for it again. */
      taken(live: Live, id: number, view: EditorView) {
        this.stop(live);
        const shown = view.state.field(field, false)?.shown.find((s) => s.id === id);
        const notice = document.createElement("div");
        notice.className = "embed-below-stopped";
        notice.setAttribute("role", "alert");
        const again = document.createElement("button");
        again.type = "button";
        again.textContent = "Show it again";
        again.addEventListener("click", () => {
          const now = view.state.field(field, false)?.shown.find((s) => s.id === id);
          if (!now || this.live.get(id) !== live) return;
          live.drawn.replaceChildren();
          this.draw(live, now, view);
        });
        notice.append(`${shown?.embed.title ?? "This"} was stopped: it tried to take the keyboard while you were typing.`, again);
        live.drawn.replaceChildren(notice);
      }

      stop(live: Live) {
        const stop = live.stop;
        live.stop = undefined;
        try {
          stop?.();
        } catch {
          // An embed that can't stop cleanly is still taken out.
        }
      }

      destroy() {
        for (const [id, live] of this.live) this.drop(id, live);
        this.dom.remove();
      }
    },
  );

  return [field, layer];
}
