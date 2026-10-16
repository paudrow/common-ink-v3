import type { ReactNode } from "react";
import type { Embed, Plugin, PluginHost, SourceRecord } from "../../plugin-api.ts";
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
 * An embed that stands for one event or contact: `::event{ref label}`. It is one chip in the line,
 * drawn with the label the note holds and then, for the member whose record it is, with the record
 * as it is now. Anyone else is shown the label, which is all the note says.
 */
export function referenceEmbed<K extends SourceRecord["kind"]>({ host, kind, title, hint, shown, details }: Kind<K>): Embed {
  return {
    name: kind,
    title,
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
        const label = written.label || title;
        const show = (read: Read | undefined) => {
          if (!read) return chip("reading", label, title);
          if (read.is === "private") return chip("private", label, `Only the member who referenced this ${kind} sees its details`);
          if (read.is === "reconnect") return chip("stale", label, `${read.message} to see this ${kind} as it is now`);
          if (read.is === "failed") return chip("stale", label, `This ${kind} couldn't be read: ${read.message}`);
          if (read.record.kind !== kind) return chip("stale", label, `This is a reference to ${read.record.kind === "event" ? "an event" : "a contact"}`);
          const record = read.record as Extract<SourceRecord, { kind: K }>;
          const { text, title: said } = shown(record);
          chip("live", text, said, record);
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

const NOTHING = { shown: () => ({ text: "", title: "" }), details: () => null };

/**
 * References as whoever holds a link sees them: the label the note holds, in gray, and nothing of
 * the record. A link's page has no member whose record it could be, so nothing is asked.
 */
export const labelledReferences: Plugin = {
  id: "references",
  name: "References",
  activate(host) {
    host.embeds.register(referenceEmbed({ kind: "event", title: "Event", hint: "", ...NOTHING }));
    host.embeds.register(referenceEmbed({ kind: "contact", title: "Contact", hint: "", ...NOTHING }));
  },
};
