import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, layer, showTooltip, type LayerMarker } from "@codemirror/view";
import { ago, lineHunks, reline, type Author, type Blame, type ChangeEntry, type Dispose, type PluginHost } from "../../plugin-api.ts";

/*
 * Who wrote this: a thin bar in the margin beside each line of a note, coloured by who last wrote
 * or edited the line. Members are one family of colours and agents another, drawn dashed; the
 * member's own lines are a quiet grey. The bars are drawn in a layer of their own over the margin,
 * so nothing in the text moves when they come or go.
 */

/** Who wrote a line: the revision of the change that did, or what the member typed here since the note was read. */
type Wrote = number;
const TYPED = 0;

/** How a bar is drawn: the member's own, or one of the colours of a family. */
type Tone = "self" | `member-${number}` | `agent-${number}`;
const MEMBER_TONES = 5;
const AGENT_TONES = 4;

/** What the bars of one note are drawn from. */
interface Read {
  blame: Blame;
  me: string;
  changes: ReadonlyMap<number, ChangeEntry>;
  tones: ReadonlyMap<number, Tone>;
}

interface Shown extends Read {
  /** For each line of the editor's text now, who wrote it. */
  lines: Wrote[];
}

/** The member's notes with the bars on, the latest turned on last, kept in this browser. */
export interface WhoWroteToggles {
  has(noteId: string): boolean;
  toggle(noteId: string): void;
  subscribe(listener: () => void): Dispose;
}

const KEPT = "whoWrote";
const OWN_PAUSE_MS = 5000;
/** As many notes' answers as are kept to draw from at once, the latest read last. */
const MOST_READ = 20;
const MOST_KEPT = 200;

export function whoWroteToggles(storage: PluginHost["storage"]): WhoWroteToggles {
  const kept = storage.get(KEPT);
  let on = Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  const listeners = new Set<() => void>();
  return {
    has: (noteId) => on.includes(noteId),
    toggle(noteId) {
      on = on.includes(noteId) ? on.filter((id) => id !== noteId) : [...on, noteId].slice(-MOST_KEPT);
      storage.set(KEPT, on);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const keyOf = (author: Author) => (author.kind === "member" ? author.personId : author.agentId);

/**
 * A colour for each author: the member's own lines quiet, and everyone else a colour of their
 * family. Each takes the colour their id falls on, or the next one free, so an author keeps their
 * colour from note to note and two authors of one note have two colours while there are enough.
 */
function tonesOf(changes: readonly ChangeEntry[], me: string): Map<number, Tone> {
  const authors = new Map(changes.map((c) => [keyOf(c.author), c.author]));
  const taken = new Map<string, Tone>();
  for (const family of ["member", "agent"] as const) {
    const size = family === "member" ? MEMBER_TONES : AGENT_TONES;
    const used = new Set<number>();
    for (const [key, author] of [...authors].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (author.kind !== family || (author.kind === "member" && author.personId === me)) continue;
      let tone = [...key].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 9973, 0) % size;
      for (let tries = 0; used.has(tone) && tries < size; tries++) tone = (tone + 1) % size;
      used.add(tone);
      taken.set(key, `${family}-${tone}`);
    }
  }
  return new Map(changes.map((c) => [c.revision, taken.get(keyOf(c.author)) ?? "self"]));
}

/** Who wrote each line of `text`, the editor's text now: as the answer says where the line is as it was read, and the member's typing where it isn't. */
function aligned({ text: then, lines: runs }: Blame, now: string): Wrote[] {
  const wrote = runs.flatMap((run) => Array<Wrote>(run.to - run.from + 1).fill(run.revision));
  if (then === now) return wrote;
  const [a, b] = [then ? then.split("\n") : [], now ? now.split("\n") : []];
  const lines: Wrote[] = [];
  let i = 0;
  for (const hunk of [...lineHunks(a, b), { aFrom: a.length, aTo: a.length, bFrom: b.length, bTo: b.length }]) {
    while (lines.length < hunk.bFrom) lines.push(wrote[i++]!);
    while (lines.length < hunk.bTo) lines.push(TYPED);
    i = hunk.aTo;
  }
  return lines;
}

const show = StateEffect.define<Read | null>();
/** A bar the pointer is on: the line it is beside, counted from 1, and what it says. */
interface Hover {
  line: number;
  label: string;
}

const hover = StateEffect.define<Hover | null>();

const shown = StateField.define<Shown | null>({
  create: () => null,
  update(value, tr) {
    const read = tr.effects.find((e) => e.is(show));
    if (read) return read.value && { ...read.value, lines: aligned(read.value.blame, tr.state.doc.toString()) };
    if (!value || !tr.docChanged) return value;
    // A note read before the editor took in the change that made it, such as another member's, is true of it once it has.
    const { doc } = tr.state;
    if (doc.length === value.blame.text.length && doc.toString() === value.blame.text) return { ...value, lines: aligned(value.blame, value.blame.text) };
    return { ...value, lines: reline(value.lines, tr.changes, tr.startState.doc, TYPED) };
  },
});

const hovered = StateField.define<Hover | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(hover)) value = e.value;
    return value !== null && tr.docChanged ? null : value;
  },
});

/** The latest of the lines from one to another, counted from 1: what typing here did is later than any change read. */
function latest(lines: readonly Wrote[], first: number, last: number): Wrote | undefined {
  let found: Wrote | undefined;
  for (let n = first; n <= last && n <= lines.length; n++) {
    const wrote = lines[n - 1]!;
    if (found === undefined || wrote === TYPED || (found !== TYPED && wrote > found)) found = wrote;
  }
  return found;
}

/** What a bar's pointer is told of who wrote its line. */
function said(read: Read, wrote: Wrote): string {
  const change = read.changes.get(wrote);
  if (!change) return "You, just now";
  const when = ago(change.createdAt, Date.now());
  const { author } = change;
  if (author.kind === "member") return `${author.personId === read.me ? "You" : author.name}, ${when}`;
  const owner = author.onBehalfOf === read.me ? "your agent" : read.blame.owners[author.onBehalfOf] ? `${read.blame.owners[author.onBehalfOf]}'s agent` : "an agent";
  return `${author.name} (${owner}), ${when}`;
}

class Bar implements LayerMarker {
  constructor(
    readonly line: number,
    readonly wrote: Wrote,
    readonly tone: Tone,
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly label: string,
  ) {}

  draw() {
    const el = document.createElement("div");
    el.className = "who-bar";
    this.update(el);
    return el;
  }

  update(el: HTMLElement) {
    el.dataset.tone = this.tone;
    el.dataset.line = String(this.line);
    el.dataset.revision = String(this.wrote);
    el.setAttribute("aria-label", this.label);
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.height = `${this.height}px`;
    return true;
  }

  eq(other: Bar) {
    return this.line === other.line && this.wrote === other.wrote && this.tone === other.tone && this.left === other.left && this.top === other.top && this.height === other.height && this.label === other.label;
  }
}

function barsOf(view: EditorView): Bar[] {
  const read = view.state.field(shown, false);
  if (!read?.lines.length) return [];
  const scroller = view.scrollDOM.getBoundingClientRect();
  const [baseLeft, baseTop] = [scroller.left - view.scrollDOM.scrollLeft * view.scaleX, scroller.top - view.scrollDOM.scrollTop * view.scaleY];
  // At the outer edge of the room kept left of the text, clear of a heading's #s, which hang right next to it.
  const left = (view.contentDOM.getBoundingClientRect().left - baseLeft) / view.scaleX + 2;
  const bars: Bar[] = [];
  // One bar for each block of lines, whatever is drawn in it: a table or a board drawn in place of its lines is beside the bar of those lines.
  for (const part of view.viewportLineBlocks) {
    if (!part.height) continue;
    const [first, last] = [view.state.doc.lineAt(part.from).number, view.state.doc.lineAt(part.to).number];
    const wrote = latest(read.lines, first, last);
    if (wrote === undefined) continue;
    const tone = wrote === TYPED ? "self" : (read.tones.get(wrote) ?? "self");
    bars.push(new Bar(first, wrote, tone, left, (part.top + view.documentTop - baseTop) / view.scaleY, part.height, said(read, wrote)));
  }
  return bars;
}

const barOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".who-bar") : null);

/**
 * The bars, for the editor of one note. They are drawn while the member has them on for the note:
 * read for the note's revision, kept true to typing as it happens, and read again each time the
 * note has a newer revision. Pressing one opens its change in History.
 */
export function whoWrote(host: PluginHost, toggles: WhoWroteToggles, read: Map<string, Blame>, openAt: (noteId: string, revision: number) => void, noteId: string): Extension {
  const loader = ViewPlugin.define((view) => {
    let asking = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showing = () => view.state.field(shown, false)?.blame;
    const put = (blame: Blame | null) => {
      if (gone || showing() === (blame ?? undefined)) return;
      const me = host.app().me.id;
      view.dispatch({ effects: show.of(blame && { blame, me, changes: new Map(blame.changes.map((c) => [c.revision, c])), tones: tonesOf(blame.changes, me) }) });
    };
    const ask = async () => {
      asking = true;
      try {
        const blame = await host.perform({ type: "note.blame", id: noteId });
        read.delete(noteId);
        read.set(noteId, blame);
        if (read.size > MOST_READ) read.delete(read.keys().next().value!);
      } catch {
        // The bars stay as they were, and are read again when the note next changes.
        return;
      } finally {
        asking = false;
      }
      sync();
    };
    // Each time the toggle or the notes change, and never inside another update of the editor.
    const sync = () =>
      queueMicrotask(() => {
        if (gone) return;
        if (!toggles.has(noteId)) {
          read.delete(noteId);
          return put(null);
        }
        const had = read.get(noteId);
        if (had) put(had);
        const note = host.app().notes?.find((n) => n.id === noteId);
        if (asking || (had && (!note || had.revision >= note.revision))) return;
        // The member's own saves are drawn already, as they type: what they wrote is read once they pause, and someone else's change at once.
        const mine = note?.updatedBy.kind === "member" && note.updatedBy.personId === host.app().me.id;
        clearTimeout(timer);
        timer = setTimeout(() => void ask(), !had ? 0 : mine ? OWN_PAUSE_MS : 300);
      });
    const stops = [toggles.subscribe(sync), host.onNotes(sync)];
    sync();
    return {
      destroy() {
        gone = true;
        clearTimeout(timer);
        for (const stop of stops) stop();
      },
    };
  });

  const bars = layer({
    above: true,
    class: "who-wrote",
    markers: barsOf,
    update: (u) => u.docChanged || u.viewportChanged || u.startState.field(shown, false) !== u.state.field(shown, false),
    mount(dom, view) {
      dom.addEventListener("mouseover", (e) => {
        const bar = barOf(e.target);
        if (bar) view.dispatch({ effects: hover.of({ line: Number(bar.dataset.line), label: bar.getAttribute("aria-label") ?? "" }) });
      });
      dom.addEventListener("mouseout", (e) => {
        if (barOf(e.target) && !barOf(e.relatedTarget)) view.dispatch({ effects: hover.of(null) });
      });
      dom.addEventListener("mousedown", (e) => barOf(e.target) && e.preventDefault());
      dom.addEventListener("click", (e) => {
        const wrote = Number(barOf(e.target)?.dataset.revision);
        if (wrote) openAt(noteId, wrote);
      });
    },
  });

  const tip = showTooltip.compute([hovered, shown], (state) => {
    const on = state.field(hovered);
    if (!on || !state.field(shown) || on.line > state.doc.lines) return null;
    return {
      pos: state.doc.line(on.line).from,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "who-tip";
        dom.setAttribute("role", "tooltip");
        dom.textContent = on.label;
        return { dom };
      },
    };
  });

  return [shown, hovered, loader, bars, tip];
}
