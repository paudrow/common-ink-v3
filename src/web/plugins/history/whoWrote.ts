import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, layer, type LayerMarker } from "@codemirror/view";
import { ago, lineHunks, reline, type Author, type Blame, type ChangeEntry, type Dispose, type PluginHost } from "../../plugin-api.ts";
import { did, initials } from "../lib/historyView.ts";

/*
 * Who wrote this: a column left of the text, as a blame view has. Each run of lines one change last
 * wrote is a hunk, and the hunk's first row names who wrote it and when, with the change's summary
 * where History has one. Members are one family of colours and agents another; the member's own
 * lines are grey. A strip at the column's edge is stronger the newer the change. The column is drawn
 * in a layer of its own, in room the editor makes left of the text when the mode is on, so the text
 * moves at most once, as the mode comes on, and never while scrolling or typing.
 */

/** Who wrote a line: the revision of the change that did, or what the member typed here since the note was read. */
type Wrote = number;
const TYPED = 0;

/** How a hunk is drawn: the member's own, or one of the colours of a family. */
type Tone = "self" | `member-${number}` | `agent-${number}`;
const MEMBER_TONES = 5;
const AGENT_TONES = 4;
/** How new a change is among the note's, from 0 for the oldest to the newest. */
const HEAT_STEPS = 4;

/** What the column of one note is drawn from. */
interface Read {
  blame: Blame;
  me: string;
  changes: ReadonlyMap<number, ChangeEntry>;
  tones: ReadonlyMap<number, Tone>;
  heat: ReadonlyMap<number, number>;
}

interface Shown extends Read {
  /** For each line of the editor's text now, who wrote it. */
  lines: Wrote[];
}

/** The mode for one editor: off, on and waiting for the note's answer, or on and drawn from it. */
type Column = null | "waiting" | Shown;

/** The member's notes with the column on, the latest turned on last, kept in this browser. */
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

const keyOf = (author: Author) => (author.kind === "member" ? author.personId : author.kind === "agent" ? author.agentId : author.pluginId);

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
      // A plugin writes for its member as an agent does, and is coloured as one.
      if ((author.kind === "plugin" ? "agent" : author.kind) !== family || (author.kind === "member" && author.personId === me)) continue;
      let tone = [...key].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 9973, 0) % size;
      for (let tries = 0; used.has(tone) && tries < size; tries++) tone = (tone + 1) % size;
      used.add(tone);
      taken.set(key, `${family}-${tone}`);
    }
  }
  return new Map(changes.map((c) => [c.revision, taken.get(keyOf(c.author)) ?? "self"]));
}

/** How new each change the lines name is among them, by rank: the oldest 0 and the newest `HEAT_STEPS`. */
function heatOf(blame: Blame): Map<number, number> {
  const named = [...new Set(blame.lines.map((run) => run.revision))].sort((a, b) => a - b);
  return new Map(named.map((revision, i) => [revision, named.length < 2 ? HEAT_STEPS : Math.round((i * HEAT_STEPS) / (named.length - 1))]));
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

const show = StateEffect.define<Read | "waiting" | null>();
/** Each minute while the column is on, so how long ago a change was made stays true. */
const tick = StateEffect.define<null>();
const MINUTE_MS = 60_000;

const column = StateField.define<Column>({
  create: () => null,
  update(value, tr) {
    const read = tr.effects.find((e) => e.is(show));
    if (read) return read.value === null || read.value === "waiting" ? read.value : { ...read.value, lines: aligned(read.value.blame, tr.state.doc.toString()) };
    if (!value || value === "waiting" || !tr.docChanged) return value;
    // A note read before the editor took in the change that made it, such as another member's, is true of it once it has.
    const { doc } = tr.state;
    if (doc.length === value.blame.text.length && doc.toString() === value.blame.text) return { ...value, lines: aligned(value.blame, value.blame.text) };
    return { ...value, lines: reline(value.lines, tr.changes, tr.startState.doc, TYPED) };
  },
  provide: (field) => EditorView.editorAttributes.from(field, (value): Record<string, string> => (value ? { class: "who-on" } : {})),
});

const drawn = (state: EditorState) => {
  const value = state.field(column, false);
  return value && value !== "waiting" ? value : null;
};

/** Lines one change last wrote, next to each other, from one line to another counted from 1. */
interface Hunk {
  from: number;
  to: number;
  wrote: Wrote;
}

/** The hunk the line is in. */
function hunkAt(lines: readonly Wrote[], line: number): Hunk {
  const wrote = lines[line - 1]!;
  let [from, to] = [line, line];
  while (from > 1 && lines[from - 2] === wrote) from--;
  while (to < lines.length && lines[to] === wrote) to++;
  return { from, to, wrote };
}

/** The latest of the lines from one to another, counted from 1: what typing here did is later than any change read. */
function latest(lines: readonly Wrote[], first: number, last: number): Wrote | undefined {
  let found: Wrote | undefined;
  for (let n = first; n <= last && n <= lines.length; n++) {
    const wrote = lines[n - 1]!;
    if (found === undefined || wrote === TYPED || (found !== TYPED && wrote > found)) found = wrote;
  }
  return found;
}

/** What a hunk's first row says: who, when, and what the change was where History says more than that it edited. */
interface Label {
  who: string;
  when: string;
  what: string | null;
}

function labelOf(read: Read, wrote: Wrote): Label {
  const change = read.changes.get(wrote);
  if (!change) return { who: "You", when: "just now", what: null };
  const when = ago(change.createdAt, Date.now());
  const what = change.label ?? (change.reverts ? capital(did({ reverts: change.reverts, restores: change.restores, revisions: [change.revision] }, false)) : null);
  const { author } = change;
  if (author.kind === "member") return { who: author.personId === read.me ? "You" : author.name, when, what };
  const noun = author.kind === "plugin" ? "plugin" : "agent";
  const owner = author.onBehalfOf === read.me ? `your ${noun}` : read.blame.owners[author.onBehalfOf] ? `${read.blame.owners[author.onBehalfOf]}'s ${noun}` : `a ${noun}`;
  return { who: `${author.name} (${owner})`, when, what };
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const said = (label: Label) => `${label.who} · ${label.when}${label.what ? ` · ${label.what}` : ""}`;

class HunkMark implements LayerMarker {
  constructor(
    readonly hunk: Hunk,
    readonly tone: Tone,
    readonly heat: number,
    readonly initial: string,
    readonly label: Label,
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly row: number,
  ) {}

  draw() {
    const el = document.createElement("div");
    el.className = "who-hunk";
    const col = el.appendChild(document.createElement("div"));
    col.className = "who-col";
    const pinned = col.appendChild(document.createElement("div"));
    pinned.className = "who-label";
    const avatar = pinned.appendChild(document.createElement("span"));
    avatar.className = "who-avatar";
    const text = pinned.appendChild(document.createElement("span"));
    text.className = "who-text";
    const head = text.appendChild(document.createElement("span"));
    head.className = "who-head";
    for (const part of ["who-name", "who-when"]) head.appendChild(document.createElement("span")).className = part;
    text.appendChild(document.createElement("span")).className = "who-what";
    el.appendChild(document.createElement("div")).className = "who-band";
    this.update(el);
    return el;
  }

  update(el: HTMLElement) {
    const { hunk, label } = this;
    Object.assign(el.dataset, { from: String(hunk.from), to: String(hunk.to), revision: String(hunk.wrote), tone: this.tone, heat: String(this.heat) });
    el.setAttribute("aria-label", said(label));
    el.title = said(label);
    Object.assign(el.style, { left: `${this.left}px`, top: `${this.top}px`, width: `${this.width}px`, height: `${this.height}px` });
    el.style.setProperty("--who-row", `${this.row}px`);
    // A hunk of one row has its summary on that row, after who and when.
    el.dataset.rows = this.height < this.row * 1.75 ? "one" : "more";
    el.querySelector(".who-avatar")!.textContent = this.initial;
    el.querySelector(".who-name")!.textContent = label.who;
    el.querySelector(".who-when")!.textContent = label.when;
    el.querySelector(".who-what")!.textContent = label.what ?? "";
    return true;
  }

  eq(other: HunkMark) {
    return (
      this.hunk.from === other.hunk.from &&
      this.hunk.to === other.hunk.to &&
      this.hunk.wrote === other.hunk.wrote &&
      this.tone === other.tone &&
      this.heat === other.heat &&
      this.initial === other.initial &&
      said(this.label) === said(other.label) &&
      this.left === other.left &&
      this.top === other.top &&
      this.width === other.width &&
      this.height === other.height &&
      this.row === other.row
    );
  }
}

/** The hunks in sight. A block drawn in place of several lines, such as a table, is of whoever last changed one of them. */
function hunksOf(view: EditorView): HunkMark[] {
  const read = drawn(view.state);
  if (!read?.lines.length) return [];
  const scroller = view.scrollDOM.getBoundingClientRect();
  const [baseLeft, baseTop] = [scroller.left - view.scrollDOM.scrollLeft * view.scaleX, scroller.top - view.scrollDOM.scrollTop * view.scaleY];
  const content = view.contentDOM.getBoundingClientRect();
  const [left, width] = [(content.left - baseLeft) / view.scaleX, content.width / view.scaleX];
  const marks: HunkMark[] = [];
  let open = null as { first: number; last: number; wrote: Wrote; top: number; bottom: number } | null;
  const close = (last: boolean) => {
    if (!open) return;
    const { wrote } = open;
    // The first and last hunks in sight run on past it, and a block such as a table may take in lines of other hunks.
    const [head, tail] = [hunkAt(read.lines, open.first), hunkAt(read.lines, open.last)];
    const hunk = { from: !marks.length && head.wrote === wrote ? head.from : open.first, to: last && tail.wrote === wrote ? tail.to : open.last, wrote };
    const author = read.changes.get(wrote)?.author;
    const tone = wrote === TYPED ? "self" : (read.tones.get(wrote) ?? "self");
    const heat = wrote === TYPED ? HEAT_STEPS : (read.heat.get(wrote) ?? HEAT_STEPS);
    const initial = initials(!author || (author.kind === "member" && author.personId === read.me) ? "You" : author.name);
    marks.push(new HunkMark(hunk, tone, heat, initial, labelOf(read, wrote), left, (open.top - baseTop) / view.scaleY, width, (open.bottom - open.top) / view.scaleY, view.defaultLineHeight));
  };
  for (const part of view.viewportLineBlocks) {
    if (!part.height) continue;
    const [first, last] = [view.state.doc.lineAt(part.from).number, view.state.doc.lineAt(part.to).number];
    const wrote = latest(read.lines, first, last);
    if (wrote === undefined) continue;
    const [top, bottom] = [part.top + view.documentTop, part.bottom + view.documentTop];
    if (open?.wrote === wrote) Object.assign(open, { last, bottom });
    else {
      close(false);
      open = { first, last, wrote, top, bottom };
    }
  }
  close(true);
  return marks;
}

const hunkOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".who-col")?.parentElement : null);

/** The nearest element above `el` that scrolls up and down, where the top of what is in sight is. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  return null;
}

/** How far down each hunk's label in sight goes to stay at the top of what is in sight while its hunk is. */
function pinsOf(view: EditorView, scroller: HTMLElement | null): [HTMLElement, number][] {
  const top = Math.max(scroller?.getBoundingClientRect().top ?? 0, 0);
  return [...view.dom.querySelectorAll<HTMLElement>(".who-hunk")].map((el) => {
    const box = el.getBoundingClientRect();
    const label = el.querySelector<HTMLElement>(".who-label")!;
    return [label, Math.max(0, Math.min(top - box.top, box.height - label.offsetHeight)) / view.scaleY];
  });
}

/** The editors with a column, by note, the one used last first: a note may be open in two parts of a split. */
export type Editors = Map<string, EditorView[]>;

/**
 * Moves the cursor of the note's editor to the first line of the hunk after or before the one it is
 * in, and answers the change that wrote it: none where there is no such hunk, or the member wrote it
 * since the note was read.
 */
export function stepHunk(view: EditorView, by: 1 | -1): number | null {
  const read = drawn(view.state);
  if (!read?.lines.length) return null;
  const at = hunkAt(read.lines, view.state.doc.lineAt(view.state.selection.main.head).number);
  const line = by > 0 ? at.to + 1 : at.from - 1;
  if (line < 1 || line > read.lines.length) return null;
  const next = hunkAt(read.lines, line);
  const pos = view.state.doc.line(next.from).from;
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  return next.wrote === TYPED ? null : next.wrote;
}

/**
 * The column, for the editor of one note. It is drawn while the member has the mode on for the
 * note: read for the note's revision, kept true to typing as it happens, and read again each time
 * the note has a newer revision. Pressing a hunk opens its change in History.
 */
export function whoWrote(host: PluginHost, toggles: WhoWroteToggles, read: Map<string, Blame>, editors: Editors, openAt: (noteId: string, revision: number) => void, noteId: string): Extension {
  const loader = ViewPlugin.define((view) => {
    let asking = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scroller: HTMLElement | null = null;
    // In the editor's own measuring, after it has drawn the column, so a label is never drawn where it was before it is pinned.
    const repin = () =>
      view.requestMeasure({
        key: pinsOf,
        read: () => {
          if (!scroller?.isConnected) scroller = scrollerOf(view.dom);
          return pinsOf(view, scroller);
        },
        write: (pins) => {
          for (const [label, by] of pins) label.style.transform = by > 0 ? `translateY(${by}px)` : "";
        },
      });
    const showing = () => view.state.field(column, false);
    const put = (blame: Blame | "waiting" | null) => {
      const now = showing();
      if (gone || (blame === "waiting" ? now !== null : now === blame || (now && now !== "waiting" && now.blame === blame))) return;
      const me = host.app().me.id;
      view.dispatch({ effects: show.of(blame && blame !== "waiting" ? { blame, me, changes: new Map(blame.changes.map((c) => [c.revision, c])), tones: tonesOf(blame.changes, me), heat: heatOf(blame) } : blame) });
    };
    const ask = async () => {
      asking = true;
      try {
        const blame = await host.perform({ type: "note.blame", id: noteId });
        read.delete(noteId);
        read.set(noteId, blame);
        if (read.size > MOST_READ) read.delete(read.keys().next().value!);
      } catch {
        // The column stays as it was, and is read again when the note next changes.
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
        put(had ?? "waiting");
        const note = host.app().notes?.find((n) => n.id === noteId);
        if (asking || (had && (!note || had.revision >= note.revision))) return;
        // The member's own saves are drawn already, as they type: what they wrote is read once they pause, and someone else's change at once.
        const mine = note?.updatedBy.kind === "member" && note.updatedBy.personId === host.app().me.id;
        clearTimeout(timer);
        timer = setTimeout(() => void ask(), !had ? 0 : mine ? OWN_PAUSE_MS : 300);
      });
    const stops = [toggles.subscribe(sync), host.onItems(sync)];
    const scrolled = (e: Event) => e.target === scroller && view.state.field(column, false) && repin();
    window.addEventListener("scroll", scrolled, { capture: true, passive: true });
    const focused = () => editors.set(noteId, [view, ...(editors.get(noteId) ?? []).filter((v) => v !== view)]);
    view.contentDOM.addEventListener("focus", focused);
    editors.set(noteId, [...(editors.get(noteId) ?? []), view]);
    const ticking = setInterval(() => view.state.field(column, false) && view.dispatch({ effects: tick.of(null) }), MINUTE_MS);
    sync();
    return {
      update: (u) => u.state.field(column, false) && repin(),
      destroy() {
        gone = true;
        clearTimeout(timer);
        clearInterval(ticking);
        for (const stop of stops) stop();
        window.removeEventListener("scroll", scrolled, { capture: true });
        view.contentDOM.removeEventListener("focus", focused);
        const left = (editors.get(noteId) ?? []).filter((v) => v !== view);
        if (left.length) editors.set(noteId, left);
        else editors.delete(noteId);
      },
    };
  });

  const hunks = layer({
    above: true,
    class: "who-wrote",
    markers: hunksOf,
    update: (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.startState.field(column, false) !== u.state.field(column, false) || u.transactions.some((tr) => tr.effects.some((e) => e.is(tick))),
    mount(dom) {
      dom.addEventListener("mousedown", (e) => hunkOf(e.target) && e.preventDefault());
      dom.addEventListener("click", (e) => {
        const wrote = Number(hunkOf(e.target)?.dataset.revision);
        if (wrote) openAt(noteId, wrote);
      });
    },
  });

  // The loader measures after the column is drawn.
  return [column, hunks, loader];
}
