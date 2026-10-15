import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { keep } from "./belowIdentity.ts";
import { inlineIn, rewriteOf, type Written } from "./embedSyntax.ts";
import { guardFrames } from "./frameGuard.ts";
import type { AddressEmbed, Below, BelowBox, Embed } from "./plugin-api.ts";

/** One embed with something kept below its line. */
interface Shown {
  id: number;
  from: number;
  name: string;
  /** What the note says of it. While this stays the same, what is drawn for it is left alone. */
  source: string;
  /** The end of the line it is kept under. */
  at: number;
  embed: Kept;
  written: Written;
  box: BelowBox;
  /** Whether the note writes it as an address alone on a line, and not in an embed's syntax. */
  bare: boolean;
}

/** An embed with something to keep below its line, however the note writes it. */
type Kept = (Embed | AddressEmbed) & { below: Below };

let ids = 0;

/** Above and below each box, in pixels. A block's box has none above: it is the rest of the block's card. */
const GAP = 6;
const UNDER_CARD = 12;

const sameBox = (a: BelowBox, b: BelowBox) => a.maxWidth === b.maxWidth && ("ratio" in a ? "ratio" in b && a.ratio === b.ratio : "height" in b && a.height === b.height);

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
    /** Whether it is the rest of a block's card. */
    private readonly joined: boolean,
    /** Whether it is for an address alone on its line, which is out of sight while the cursor is elsewhere: the media is where that line was. */
    private readonly bare: boolean,
  ) {
    super();
  }

  override eq(other: BoxWidget) {
    return other.id === this.id && other.joined === this.joined && other.bare === this.bare && sameBox(other.box, this.box);
  }

  /** The room's padding above and below what is drawn in it. */
  get padding(): [number, number] {
    return this.joined ? [0, UNDER_CARD] : this.bare ? [0, GAP] : [GAP, GAP];
  }

  override get estimatedHeight() {
    const inner = "height" in this.box ? this.box.height : heights.get(this.id);
    return inner === undefined ? -1 : inner + this.padding[0] + this.padding[1];
  }

  override toDOM() {
    const el = document.createElement("div");
    el.className = this.joined ? "embed-below-room embed-below-room-joined" : "embed-below-room";
    el.style.paddingBlock = this.padding.map((px) => `${px}px`).join(" ");
    const box = el.appendChild(document.createElement("div"));
    box.dataset.below = String(this.id);
    this.size(box);
    return el;
  }

  /** A room that is only another size is the same element at that size, so what is over it is moved and not looked for again. */
  override updateDOM(el: HTMLElement) {
    const box = el.firstElementChild as HTMLElement | null;
    if (!box || box.dataset.below !== String(this.id) || el.classList.contains("embed-below-room-joined") !== this.joined || el.style.paddingBlock !== this.padding.map((px) => `${px}px`).join(" ")) return false;
    this.size(box);
    return true;
  }

  private size(box: HTMLElement) {
    box.style.aspectRatio = "ratio" in this.box ? String(this.box.ratio) : "";
    box.style.height = "height" in this.box ? `${this.box.height}px` : "";
    box.style.maxWidth = this.box.maxWidth ? `${this.box.maxWidth}px` : "";
  }

  override ignoreEvent() {
    return true;
  }
}

interface Reading {
  embeds: ReadonlyMap<string, Embed>;
  addresses: readonly AddressEmbed[];
  blocks: readonly Written[];
  /** Whether the cursor's line is shown as written: not before the cursor has been put anywhere, and never in a reading. */
  written: boolean;
}

function boxOf(embed: Kept, written: Written): BelowBox | null {
  try {
    const box = embed.below.box({ config: written.config, body: written.body });
    if (!box) return null;
    const size = "ratio" in box ? box.ratio : box.height;
    const width = box.maxWidth ?? 1;
    return Number.isFinite(size) && size > 0 && Number.isFinite(width) && width > 0 ? box : null;
  } catch {
    return null;
  }
}

/** A line that is one https address and nothing else. */
const ALONE = /^[ \t]*(https:\/\/\S+)[ \t]*$/;

function claims(embed: AddressEmbed, address: string): boolean {
  try {
    return embed.claims(address) === true;
  } catch {
    return false;
  }
}

function read(state: EditorState, { embeds, addresses, blocks }: Reading, before: readonly Shown[], moved: (pos: number) => number, sized: ReadonlyMap<number, number>): Shown[] {
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
  }
  const bare = new Map<Written, AddressEmbed>();
  if (addresses.length && state.doc.sliceString(0).includes("https://")) {
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const address = ALONE.exec(line.text);
      if (!address) continue;
      const from = line.from + address.index + address[0].indexOf(address[1]!);
      if (drawnBlocks.some((b) => b.from <= from && b.to >= line.to) || /Code/.test(syntaxTree(state).resolveInner(from, 1).name)) continue;
      const embed = addresses.find((e) => claims(e, address[1]!));
      if (!embed) continue;
      const to = from + address[1]!.length;
      const written: Written = { name: embed.name, config: address[1]!, body: "", block: false, from, to, configFrom: from, bodyFrom: to };
      bare.set(written, embed);
      found.push(written);
    }
  }
  found.sort((a, b) => a.from - b.from);
  const boxed = found.flatMap((written) => {
    const embed = bare.get(written) ?? (embeds.get(written.name) as Embed & { below: Below });
    const box = boxOf(embed, written);
    return box ? [{ written, embed, box, from: written.from, name: written.name, source: `${written.config}\n${written.body}`, bare: bare.has(written) }] : [];
  });
  // An embed another plugin now draws is not the one that was there, whatever the note says.
  const same = before.filter((was) => ("claims" in was.embed ? addresses.includes(was.embed) : embeds.get(was.embed.name) === was.embed));
  const kept = keep(same, boxed, moved, () => ++ids);
  return boxed.map((one, index) => {
    const id = kept[index]!;
    const height = sized.get(id);
    const box: BelowBox = height !== undefined && "height" in one.box ? { ...one.box, height } : one.box;
    return { ...one, box, id, at: state.doc.lineAt(one.written.to).to };
  });
}

/** Whether the cursor is in what the note writes for an embed, or at its edge. */
const within = (state: EditorState, written: Written) => state.selection.ranges.some((r) => r.from <= written.to && r.to >= written.from);

/** Whether any of an element is in sight: inside the window and inside everything around it that scrolls or clips. */
function inSight(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  let [top, bottom, left, right] = [Math.max(rect.top, 0), Math.min(rect.bottom, window.innerHeight), Math.max(rect.left, 0), Math.min(rect.right, window.innerWidth)];
  for (let around = el.parentElement; around && top < bottom && left < right; around = around.parentElement) {
    const style = getComputedStyle(around);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = around.getBoundingClientRect();
    [top, bottom, left, right] = [Math.max(top, clip.top), Math.min(bottom, clip.bottom), Math.max(left, clip.left), Math.min(right, clip.right)];
  }
  return top < bottom && left < right;
}

/** The height what is below a line turned out to have, once it had loaded. */
const resized = StateEffect.define<{ id: number; height: number }>();

const HIDDEN = Decoration.replace({ block: true });
const SEEN = Decoration.line({ class: "embed-address" });

/** Whether the cursor is on the line of an address shown as media, which shows the address. */
function addressOn(state: EditorState, shown: Shown, written: boolean): boolean {
  const line = state.doc.lineAt(shown.from);
  return shown.bare && written && state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

/**
 * An address shown as media takes no room while the cursor is elsewhere: its line is out of the
 * note's flow and the media is where it was, as far below the line above as a paragraph is. With the
 * cursor on its line the address is shown above the media, which moves down by that line and is
 * otherwise left as it is.
 */
function addressLines(state: EditorState, shown: readonly Shown[], written: boolean): DecorationSet {
  return Decoration.set(
    shown
      .filter((s) => s.bare)
      .map((s) => {
        const line = state.doc.lineAt(s.from);
        return addressOn(state, s, written) ? SEEN.range(line.from) : HIDDEN.range(line.from, line.to);
      }),
    true,
  );
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
  const rooms = (shown: readonly Shown[]) => Decoration.set(shown.map((s): Range<Decoration> => Decoration.widget({ widget: new BoxWidget(s.id, s.box, s.written.block, s.bare), block: true, side: 1 }).range(s.at)), true);

  interface Value {
    shown: readonly Shown[];
    rooms: DecorationSet;
    lines: DecorationSet;
    reading: Reading;
    /** The heights given by what was drawn, by id, which stand over what `box` says for as long as that one is kept. */
    sized: ReadonlyMap<number, number>;
  }

  const field = StateField.define<Value>({
    create(state) {
      const now = reading(state);
      const shown = read(state, now, [], (pos) => pos, new Map());
      return { shown, rooms: rooms(shown), lines: addressLines(state, shown, now.written), reading: now, sized: new Map() };
    },
    update(value, tr) {
      const now = reading(tr.state);
      let { sized } = value;
      for (const effect of tr.effects) {
        if (effect.is(resized) && sized.get(effect.value.id) !== effect.value.height) sized = new Map(sized).set(effect.value.id, effect.value.height);
      }
      const reread = tr.docChanged || sized !== value.sized || now.embeds !== value.reading.embeds || now.addresses !== value.reading.addresses || now.blocks !== value.reading.blocks || syntaxTree(tr.startState) !== syntaxTree(tr.state);
      if (!reread && !tr.selection && now.written === value.reading.written) return value;
      const shown = reread ? read(tr.state, now, value.shown, (pos) => tr.changes.mapPos(pos, 1), sized) : value.shown;
      if (reread && sized.size) sized = new Map([...sized].filter(([id]) => shown.some((s) => s.id === id)));
      return { shown, rooms: reread ? rooms(shown) : value.rooms, lines: addressLines(tr.state, shown, now.written), reading: now, sized };
    },
    provide: (f) => [EditorView.decorations.from(f, (value) => value.rooms), EditorView.decorations.from(f, (value) => value.lines)],
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
      readonly scrolled: () => void;
      readonly measure: { key: object; read: (view: EditorView) => Map<number, Place & { seen: boolean }>; write: (places: Map<number, Place & { seen: boolean }>, view: EditorView) => void };

      constructor(view: EditorView) {
        this.dom = view.scrollDOM.appendChild(document.createElement("div"));
        this.dom.className = "embed-below-layer";
        this.measure = { key: this, read: (v) => this.places(v), write: (places, v) => this.place(places, v) };
        // The note may scroll in something around the editor, which the editor isn't told of. A room that comes on screen that way is drawn too.
        this.scrolled = () => view.state.field(field).shown.some((s) => !this.live.has(s.id)) && view.requestMeasure(this.measure);
        document.addEventListener("scroll", this.scrolled, { capture: true, passive: true });
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
            places.set(id, { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height, seen: this.live.has(id) || inSight(room) });
            continue;
          }
          const was = this.live.get(id)?.place;
          const line = view.lineBlockAt(at);
          const part = (Array.isArray(line.type) ? line.type : [line]).find((b) => b.widget instanceof BoxWidget && b.widget.id === id);
          if (was && part) places.set(id, { ...was, top: view.documentTop + part.top + (part.widget as BoxWidget).padding[0] + dy, seen: false });
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
            el.className = shown.written.block ? "embed-below embed-below-joined" : "embed-below";
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
          // The note says something else of it now: it is drawn again, in the element and the place it has. A block
          // being written is drawn again once the cursor has left it, and not at each key, half-written.
          if (live.source !== shown.source && !(shown.written.block && within(view.state, shown.written))) {
            this.stop(live);
            live.drawn.replaceChildren();
            this.draw(live, shown, view);
          }
          // With no room, as inside something else that is drawn, it is kept and not shown.
          live.el.style.visibility = place ? "" : "hidden";
          live.el.classList.toggle("embed-below-on", addressOn(view.state, shown, view.state.field(field).reading.written));
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
          if (!now || now.bare || now.source !== source || view.state.readOnly || this.live.get(id) !== live) return;
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
            resize: (height) => {
              if (!Number.isFinite(height) || height <= 0 || this.live.get(id) !== live || !view.state.field(field, false)) return;
              const effects = resized.of({ id, height: Math.round(height) });
              if (drawing) queueMicrotask(() => view.dispatch({ effects }));
              else view.dispatch({ effects });
            },
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
        live.drawn.removeAttribute("aria-busy");
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
        document.removeEventListener("scroll", this.scrolled, { capture: true });
        for (const [id, live] of this.live) this.drop(id, live);
        this.dom.remove();
      }
    },
  );

  /**
   * A step from a line to the next, as the arrow keys and vim's `j` and `k` take, stops on the line of
   * an address that is out of sight, which shows it: out of the note's flow, it is still a line of the
   * note, and the editor would step over it, and over the next address's line too. A move that goes
   * over any other line is no step and is left as it is.
   */
  const stopping = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection || tr.isUserEvent("select.pointer")) return tr;
    const { doc } = tr.startState;
    const [was, now] = [doc.lineAt(tr.startState.selection.main.head).number, doc.lineAt(tr.newSelection.main.head).number];
    const step = Math.sign(now - was);
    const next = was + step;
    if (Math.abs(now - was) < 2) return tr;
    const hidden = new Set(tr.startState.field(field).shown.filter((s) => s.bare).map((s) => doc.lineAt(s.from).number));
    for (let n = next; n !== now; n += step) if (!hidden.has(n)) return tr;
    const { anchor, empty } = tr.newSelection.main;
    return [tr, { selection: empty ? { anchor: doc.line(next).from } : { anchor, head: doc.line(next).from } }];
  });

  return [field, layer, stopping];
}
