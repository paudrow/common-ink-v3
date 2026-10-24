import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { ReactNode } from "react";
import { following, linkedEvent, linksOn, type Embed, type Plugin, type PluginHost, type SourceRecord, type WrittenLink } from "../../plugin-api.ts";
import { chips, type Chip } from "./chips.ts";
import { linkLook, WRITTEN_LINK } from "./linkLook.ts";
import { drawnInView, within } from "./live.ts";
import { openPopover } from "./Popover.tsx";

/**
 * What a reference to an event or a contact reads as for whoever is looking. `private` is what
 * everyone but the member who made it gets, and what a record that is gone gets: the server says
 * nothing else of it, and nothing else is asked.
 */
export type Read = { is: "live"; record: SourceRecord } | { is: "private" } | { is: "reconnect"; message: string } | { is: "failed"; message: string };

/** How long a reading stands, so a note that is typed in doesn't ask again at each keystroke. */
const KEPT_MS = 30_000;

const reads = new Map<string, { at: number; asked: Promise<Read>; read?: Read }>();

/** Has every reference read again the next time it is drawn, after a change to a record or to what is connected. */
export const forgetReferences = () => reads.clear();

function readOf(host: PluginHost, ref: string) {
  const key = `${host.app().me.id} ${ref}`;
  const kept = reads.get(key);
  if (kept && Date.now() - kept.at < KEPT_MS) return kept;
  const entry: { at: number; asked: Promise<Read>; read?: Read } = {
    at: Date.now(),
    asked: host.perform({ type: "record.read", ref }).then(
      (record): Read => ({ is: "live", record }),
      (err: Error & { code?: string }): Read => (err.code === "not_found" ? { is: "private" } : err.code === "conflict" ? { is: "reconnect", message: err.message } : { is: "failed", message: err.message }),
    ),
  };
  void entry.asked.then((read) => (entry.read = read));
  reads.set(key, entry);
  return entry;
}

/** What a note writes of a reference: the id `record.refer` answered, then what to call it. */
export function writtenReference(config: string): { ref: string; label: string } | null {
  const read = /^([a-z0-9]{12})(?: (.*))?$/.exec(config.trim());
  return read && { ref: read[1]!, label: read[2]?.trim() || "" };
}

/** How a reading of a record is drawn where a note refers to it: whether it is live, what it says and what hovering adds, and the record, where it is one to open. */
function readAs<K extends SourceRecord["kind"]>(read: Read | undefined, { kind, title, shown }: Pick<Kind<K>, "kind" | "title" | "shown">, label: string): { state: string; text: string; said: string; record?: Extract<SourceRecord, { kind: K }> } {
  if (!read) return { state: "reading", text: label, said: title };
  if (read.is === "private") return { state: "private", text: label, said: `Only the member who referenced this ${kind} sees its details` };
  if (read.is === "reconnect") return { state: "stale", text: label, said: `${read.message} to see this ${kind} as it is now` };
  if (read.is === "failed") return { state: "stale", text: label, said: `This ${kind} couldn't be read: ${read.message}` };
  if (read.record.kind !== kind) return { state: "stale", text: label, said: `This is a reference to ${read.record.kind === "event" ? "an event" : read.record.kind === "contact" ? "a contact" : "an email"}` };
  const record = read.record as Extract<SourceRecord, { kind: K }>;
  const { text, title: said } = shown(record);
  return { state: "live", text, said, record };
}

interface Kind<K extends SourceRecord["kind"]> {
  /** Absent where nobody has records to read: every reference is then drawn as its label, and nothing is asked. */
  host?: PluginHost;
  kind: K;
  /** What a person sees the embed called, such as "Event". */
  title: string;
  /** Where a reference is copied from, said to someone who wrote the embed without one. */
  hint: string;
  /** What the chip says of the record as it is now, and what hovering it adds. */
  shown(record: Extract<SourceRecord, { kind: K }>): { text: string; title: string };
  /** What a press on the chip opens, for the reference in note `noteId`. `close` closes it. */
  details(record: Extract<SourceRecord, { kind: K }>, at: { noteId: string; close: () => void }): ReactNode;
}

/**
 * An embed that stands for one email: `/email(ref label)`. It is one chip in the line,
 * drawn with the label the note holds and then, for the member whose record it is, with the record
 * as it is now. Anyone else is shown the label, which is all the note says. No menu lists it: `@`
 * finds people and writes their references, and one can be typed or pasted by hand.
 */
export function referenceEmbed<K extends SourceRecord["kind"]>({ host, kind, title, hint, shown, details }: Kind<K>): Embed {
  return {
    name: kind,
    title,
    menu: false,
    render(el, first) {
      const { noteId } = first;
      let drawnFor: string | null = null;

      const chip = (state: string, text: string, said: string, record?: Extract<SourceRecord, { kind: K }>) => {
        // A span and not a button, which can't wrap with the words around it.
        const made = document.createElement("span");
        made.className = "ref-chip";
        made.dataset.state = state;
        made.textContent = text;
        made.title = said;
        if (record) {
          const open = () => openPopover(made, title, (close) => details(record, { noteId, close }));
          made.role = "button";
          made.dataset.follow = "";
          made.tabIndex = 0;
          made.addEventListener("click", open);
          made.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open();
          });
        }
        el.replaceChildren(made);
      };

      const draw = (config: string) => {
        drawnFor = config;
        const written = writtenReference(config);
        if (!written) {
          const unread = document.createElement("span");
          unread.className = "embed-unread";
          unread.textContent = `${title}: ${hint}`;
          return el.replaceChildren(unread);
        }
        const show = (read: Read | undefined) => {
          const { state, text, said, record } = readAs(read, { kind, title, shown }, written.label || title);
          chip(state, text, said, record);
        };
        if (!host) return show({ is: "private" });
        const reading = readOf(host, written.ref);
        show(reading.read);
        if (!reading.read) void reading.asked.then((read) => drawnFor === config && show(read));
      };

      draw(first.config);
      return { update: (next) => draw(next.config), stop: () => void (drawnFor = null) };
    },
  };
}

/** A link to an event, with the reference it is written with. */
type EventLink = WrittenLink & { ref: string };

const eventLinksOn = (line: string, offset: number): EventLink[] =>
  linksOn(line, offset).flatMap((link) => {
    const ref = linkedEvent(link.target);
    return ref ? [{ ...link, ref }] : [];
  });

/** How far before a link's end its words are typed: before the closing brackets. */
const BEFORE_END = 2;

/**
 * Links to events, `[[event:ref]]`, each drawn as one chip: its own words where it has them, and
 * otherwise its title as it is now, for the member whose event it is, read with `host`. Anyone else
 * sees "Event" and nothing of it. A click on the chip, with ⌘ or without, or vim's gd on it, opens
 * what `details` shows of the event, for the member whose it is; on any other a click goes into
 * the link. With no `host`, as on a link's page, nothing is asked. Answers the extension for the
 * editor of a note.
 */
export function eventLinks({ host, shown, details }: Pick<Kind<"event">, "host" | "shown" | "details">): (noteId: string) => Extension {
  const kind = { kind: "event" as const, title: "Event", shown };
  /** The event each chip drawn now shows, where it shows one. */
  const records = new WeakMap<HTMLElement, Extract<SourceRecord, { kind: "event" }>>();
  const opened = (el: HTMLElement, noteId: string) => {
    const record = records.get(el);
    if (record) openPopover(el, "Event", (close) => details(record, { noteId, close }));
    return !!record;
  };
  return (noteId) => {
    const chip: Chip<EventLink> = {
      id: "event",
      find: eventLinksOn,
      written: "within",
      draw(el, link, source) {
        el.classList.add("ref-chip");
        const show = (read: Read | undefined) => {
          const { state, text, said, record } = readAs(read, kind, "Event");
          el.dataset.state = state;
          el.textContent = link.display ?? text;
          el.title = said;
          if (!record) return;
          records.set(el, record);
          el.setAttribute("role", "button");
          el.setAttribute("aria-haspopup", "dialog");
          el.tabIndex = 0;
        };
        el.addEventListener("mousedown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          if (!opened(el, noteId) && !source.readOnly) source.edit(link.to - link.from - BEFORE_END);
        });
        el.addEventListener("keydown", (event) => {
          if ((event.key === "Enter" || event.key === " ") && opened(el, noteId)) event.preventDefault();
        });
        if (!host) return show({ is: "private" });
        const reading = readOf(host, link.ref);
        show(reading.read);
        if (!reading.read) void reading.asked.then((read) => el.isConnected && show(read));
      },
    };
    const followed = following.of((view) => {
      const { head } = view.state.selection.main;
      const line = view.state.doc.lineAt(head);
      const link = eventLinksOn(line.text, line.from).find((found) => found.from <= head && head < found.to);
      const el = link && [...view.contentDOM.querySelectorAll<HTMLElement>(".md-chip-event")].find((drawn) => view.posAtDOM(drawn) === link.from);
      return !!el && opened(el, noteId);
    });
    return [chips(chip), asWritten, look, linkLook, followed];
  };
}

/** A link to an event shown as written, with the cursor in it, still reads as a link: all of it in the theme colour. */
const asWritten = drawnInView((view) => {
  const { state } = view;
  const drawn: Range<Decoration>[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    for (const link of eventLinksOn(line.text, line.from)) if (within(state, link.from, link.to)) drawn.push(Decoration.mark({ class: `${WRITTEN_LINK} md-event-written` }).range(link.from, link.to));
  }
  return drawn;
});

const look = EditorView.baseTheme({ ".md-event-written": { color: "var(--accent)" } });

const NOTHING = { shown: () => ({ text: "", title: "" }), details: () => null };

/**
 * References as whoever holds a link sees them: a link to an event as "Event", or its own words, and
 * an email as the label the note holds, in gray, and nothing of the record. A link's
 * page has no member whose record it could be, so nothing is asked.
 */
export const labelledReferences: Plugin = {
  id: "references",
  name: "References",
  activate(host) {
    const events = eventLinks(NOTHING);
    host.editorExtensions.register({ id: "references.events", extension: (editor) => events(editor.noteId) });
    host.embeds.register(referenceEmbed({ kind: "email", title: "Email", hint: "", ...NOTHING }));
  },
};
