import type { CompletionItem, MailThread, PluginHost, SourceRecord } from "../../plugin-api.ts";
import { hoverCards } from "../lib/hoverCard.tsx";
import { AT_ALONE, namable } from "../lib/pointing.ts";
import { reask } from "../lib/reasking.ts";
import { recordLinks } from "../lib/references.tsx";

export const EMAIL_PATH = "/email";

type EmailRecord = Extract<SourceRecord, { kind: "email" }>;

/** How many threads `@` offers at most for what was typed. */
const MOST_OFFERED = 6;
/** How long a reading of the threads for what was typed stands. */
const FRESH_MS = 30_000;
/** How long `@` waits for the threads before it lists what else it has, and asks again once they land. */
const WAIT_MS = 300;
/** How many readings are kept at once: one for each thing typed after `@` lately. */
const MOST_KEPT = 50;

export const when = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const sender = (thread: Pick<MailThread, "from">) => thread.from.map((f) => f.name || f.address).join(", ");

/** Where a thread, or one message in it, opens on the Email page. */
export const threadPath = (id: string) => `${EMAIL_PATH}/${encodeURIComponent(id)}`;

/** What a note writes to link to a thread or a message, made for the member now, or null when it couldn't be, which is said. */
export async function linkTo(host: PluginHost, id: string): Promise<string | null> {
  try {
    return (await host.perform({ type: "record.refer", sourceId: "email", id })).text;
  } catch (err) {
    host.app().notify({ message: (err as Error).message, icon: "mail" });
    return null;
  }
}

/**
 * What `@` offers of the member's mail: their latest threads for nothing typed, and those with every
 * word typed for anything else. Picking one writes `[[email:ref]]`, which says nothing of the mail
 * in the note. A reading stands a while, so typing doesn't ask at each key; while the first for
 * what was typed is on its way the list shows what else it has, and is asked again when it lands.
 */
export function threadsAt(host: PluginHost): (typed: string) => CompletionItem[] | Promise<CompletionItem[]> {
  const read = new Map<string, { at: number; threads: Promise<readonly MailThread[]>; done?: readonly MailThread[] }>();
  return (typed) => {
    if (!namable(typed)) return [];
    const query = typed.trim();
    let reading = read.get(query);
    if (!reading || Date.now() - reading.at > FRESH_MS) {
      const asked = host.perform({ type: "email.list", ...(query && { query }), limit: query ? MOST_OFFERED : AT_ALONE.email }).then(
        (answer) => answer.threads,
        () => [],
      );
      const entry: NonNullable<typeof reading> = { at: Date.now(), threads: asked };
      void asked.then((threads) => (entry.done = threads));
      if (read.size >= MOST_KEPT) read.clear();
      read.set(query, (reading = entry));
    }
    const offer = (threads: readonly MailThread[]) =>
      threads.map(
        (thread): CompletionItem => ({
          kind: "email",
          label: thread.subject,
          description: `${sender(thread)} · ${when(thread.lastAt)}`,
          preview: { facts: [["From", sender(thread)], ["Date", when(thread.lastAt)]], text: thread.snippet },
          insert: () => linkTo(host, thread.id),
        }),
      );
    if (reading.done) return offer(reading.done);
    const waiting = reading;
    void waiting.threads.then(() => read.get(query) === waiting && reask());
    return Promise.race([waiting.threads.then(offer), new Promise<CompletionItem[]>((done) => setTimeout(() => done([]), WAIT_MS))]);
  };
}

/** The message a link names, or the thread's latest. */
const shownMessage = ({ thread, messageId }: EmailRecord) => thread.messages.find((m) => m.id === messageId) ?? thread.messages[thread.messages.length - 1];

/**
 * Links to the member's mail, `[[email:ref]]`, drawn as a chip with the subject for the member whose
 * mail it is, and "Email" for anyone else. A click, or vim's gd, opens it on the Email page, and
 * resting on it shows who sent it, when, and how it begins.
 */
export function emailLinks(host: PluginHost) {
  const shown = new Map<string, EmailRecord>();
  const cards = hoverCards("mail", (ref) => {
    const record = shown.get(ref);
    const message = record && shownMessage(record);
    if (!record || !message) return null;
    return (
      <div className="email-card">
        <p className="hover-card-name">{record.thread.subject}</p>
        <p>
          {message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address} · {when(message.sentAt)}
        </p>
        <p className="email-snippet">{message.text.replace(/\s+/g, " ").trim().slice(0, 240)}</p>
      </div>
    );
  });
  const links = recordLinks({
    host,
    kind: "email",
    title: "Email",
    shown: (record) => ({ text: (record.messageId && shownMessage(record)?.subject) || record.thread.subject, title: "" }),
    open: (record) => host.app().go(threadPath(record.messageId ?? record.thread.id)),
    card(el, record) {
      shown.set(record.ref, record);
      el.dataset.mail = record.ref;
      el.removeAttribute("title");
    },
  });
  return { links, dispose: () => cards.dispose() };
}
