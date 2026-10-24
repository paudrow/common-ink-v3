import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, ruleLike, sandboxed, type App, type Contact, type MailAddress, type MailMessage, type MailThread, type MailThreadRead, type PluginHost, type Source, type ViewProps } from "../../plugin-api.ts";
import { step } from "../lib/rows.ts";
import { Segmented } from "../lib/Segmented.tsx";
import { NewContact } from "../mentions/ContactEditor.tsx";
import { addingTo } from "../mentions/people.ts";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { EMAIL_PATH, linkTo, threadPath, when } from "./linking.tsx";
import { noteOf, quoted } from "./quoting.ts";
import { Senders } from "./Senders.tsx";
import { skipLike } from "./SkipRules.tsx";

type Listing = { status: "reading" } | { status: "listed"; threads: readonly MailThread[]; more: boolean } | { status: "failed"; message: string };
type Reading = { status: "reading" } | { status: "read"; thread: MailThreadRead } | { status: "failed"; message: string };

/** The few ways the list is narrowed with one press, beside the search. */
const FILTERS = [
  { id: "all", label: "All" },
  { id: "attachments", label: "Has attachments" },
  { id: "contacts", label: "From contacts" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

/** How many threads a page of the list holds. */
const PAGE = 50;

const who = (a: MailAddress) => a.name || a.address;
const whoAll = (list: readonly MailAddress[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** A day as a list of mail shows it: the time for today, the day for this year, and the day and year before. */
function listedWhen(time: number): string {
  const at = new Date(time);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** Copies what a note writes to link to a thread, or one message in it, and says so. */
export async function copyLink(host: PluginHost, id: string, what: string): Promise<void> {
  const app = host.app();
  const text = await linkTo(host, id);
  if (text === null) return;
  try {
    await navigator.clipboard.writeText(text);
    app.notify({ message: `Copied the link to ${what}. Paste it into a note.`, icon: "mail" });
  } catch {
    // A page served over plain http has no clipboard to write to, so the link is said, to copy by hand.
    app.notify({ message: `The link to ${what}, to copy into a note: ${text}`, icon: "mail" });
  }
}

/**
 * Makes a note of a thread, with a link to it and its messages quoted, and opens it. The note holds
 * what the mail says, which is the member's alone, so it is made private: the member shares it, if
 * they choose, as any other note.
 */
async function noteFrom(host: PluginHost, thread: MailThreadRead): Promise<void> {
  const app = host.app();
  const link = await linkTo(host, thread.id);
  if (link === null) return;
  try {
    const note = await host.perform({ type: "note.create", text: noteOf(thread, link, when) });
    await host.sharing.setPrivate(note.id, true);
    app.openNote(note.id, { focus: true });
    app.notify({ message: `Made a private note of ${thread.subject}. Share it as you would any note.`, icon: "mail" });
  } catch (err) {
    app.notify({ message: (err as Error).message, icon: "mail" });
  }
}

/**
 * Email: the threads the member sent, copied or forwarded to notes@, which nobody else sees, as a mail
 * app shows them. `/email` lists them, latest first, beside a reading pane, and `/email/<id>` opens one
 * thread, or the thread of one message, in it. Until Email is connected the page says how it works.
 */
export function EmailPage({ host, app }: ViewProps & { host: PluginHost }) {
  const { sources, setSources, problem } = useSources(host);
  const [asked, setAsked] = useState(0);
  // Read once for the page, as each thread opened asks whether its sender is one of them.
  const contacts = useContacts(host);
  const learn = useCallback((fresher: Parameters<typeof withFresher>[1]) => setSources((known) => withFresher(known, fresher)), [setSources]);
  const openId = app.path.startsWith(`${EMAIL_PATH}/`) ? decodeURIComponent(app.path.slice(EMAIL_PATH.length + 1)) : null;
  const connected = (sources ?? []).some((s) => s.kind === "email" && s.state === "connected");
  const address = (sources ?? []).find((s) => s.kind === "email")?.account ?? null;
  // One tree whether or not Email is connected, so the addresses below keep their place, and a code shown once stays shown as it connects.
  return (
    <section className="email-client" aria-label="Email" data-connected={connected ? "" : undefined} data-open={connected && openId ? "" : undefined}>
      {connected && (
        <div className="email-list-pane">
          <ThreadList host={host} asked={asked} openId={openId} open={(id) => app.go(threadPath(id))} onSources={learn} />
        </div>
      )}
      <div className="email-reading-pane">
        {problem && (
          <p role="alert" className="said failed">
            {problem}
          </p>
        )}
        {connected && openId ? (
          <Conversation key={openId} host={host} app={app} id={openId} contacts={contacts} />
        ) : (
          <div className="email-empty">
            {!connected && <h1>Email</h1>}
            {sources &&
              (connected ? (
                <p className="email-how">
                  Send, copy (BCC) or forward mail to <strong>{address}</strong> from an address of yours below, and it is kept here as a thread, for you alone. Mail from anyone else is dropped. Pick a thread to read it.
                </p>
              ) : (
                <p className="email-how">Mail you send, copy (BCC) or forward to Common Ink is kept here as threads, for you alone. Connect Email to start.</p>
              ))}
            <Sources
              host={host}
              app={app}
              kind="email"
              sources={sources}
              onChange={(next) => {
                setSources(next);
                setAsked((n) => n + 1);
              }}
            />
            <Senders host={host} />
          </div>
        )}
      </div>
    </section>
  );
}

/** One thread as the list shows it: who wrote, the subject, how it begins, and when it last had a message. */
function ThreadRow({ thread, open, onOpen }: { thread: MailThread; open: boolean; onOpen: (id: string) => void }) {
  return (
    <li data-row aria-label={thread.subject} aria-current={open || undefined}>
      <a
        className="email-row"
        href={threadPath(thread.id)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onOpen(thread.id);
        }}
      >
        <span className="email-row-from">
          {thread.from.map(who).join(", ")}
          {thread.count > 1 && <span className="email-count"> {thread.count}</span>}
        </span>
        <span className="email-when">{listedWhen(thread.lastAt)}</span>
        <span className="email-subject">
          {thread.subject}
          {thread.attachments && (
            <span className="email-clip" title="Has attachments" aria-label="Has attachments">
              <Icon name="attachment" />
            </span>
          )}
        </span>
        <span className="email-snippet">{thread.snippet}</span>
      </a>
    </li>
  );
}

const MOVES: Record<string, string> = { j: "ArrowDown", k: "ArrowUp" };

function ThreadList({ host, asked, openId, open, onSources }: { host: PluginHost; asked: number; openId: string | null; open: (id: string) => void; onSources: (sources: Parameters<typeof withFresher>[1]) => void }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [listing, setListing] = useState<Listing>({ status: "reading" });
  const [before, setBefore] = useState<number | undefined>(undefined);
  /** The thread open in the reading pane, which a link to one message names by the message. */
  const [openThread, setOpenThread] = useState<string | null>(null);

  // Connecting or disconnecting lists from the start again.
  useEffect(() => setBefore(undefined), [asked]);

  useEffect(() => {
    const wait = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(wait);
  }, [typed]);

  useEffect(() => {
    let live = true;
    const asking = [query, filter === "attachments" ? "has:attachment" : ""].filter(Boolean).join(" ");
    host.perform({ type: "email.list", ...(asking && { query: asking }), ...(filter === "contacts" && { fromContacts: true }), ...(before !== undefined && { before }), limit: PAGE }).then(
      (answer) => {
        if (!live) return;
        setListing((was) => ({ status: "listed", threads: before !== undefined && was.status === "listed" ? [...was.threads, ...answer.threads] : answer.threads, more: answer.more }));
        onSources(answer.sources);
      },
      (err: Error) => live && setListing({ status: "failed", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, query, filter, before, asked, onSources]);

  useEffect(() => {
    if (!openId) return setOpenThread(null);
    if (listing.status === "listed" && listing.threads.some((t) => t.id === openId)) return setOpenThread(openId);
    let live = true;
    // A link to one message opens its thread, which the list knows by the thread's own id.
    host.perform({ type: "email.thread", sourceId: "email", id: openId }).then(
      (thread) => live && setOpenThread(thread.id),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host, openId, listing]);

  // j and k move through the threads as the arrow keys do, and Enter opens one, which its link does.
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const key = plain ? (MOVES[e.key] ?? e.key) : e.key;
    if (step({ key, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, target: e.target }, e.currentTarget)) e.preventDefault();
  };

  const nothing = query || filter !== "all" ? "No thread matches." : "Nothing yet. Mail sent here shows up as it arrives.";
  return (
    <>
      <header className="email-list-head">
        <h1>Email</h1>
        <input
          type="search"
          className="email-search"
          aria-label="Search email"
          placeholder="Search, or from: subject: has:attachment"
          // Room is left for has:attachment, which Has attachments adds to what is asked.
          maxLength={180}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setBefore(undefined);
          }}
        />
        <Segmented
          name="email-filter"
          label="Show"
          className="email-filters"
          choices={FILTERS}
          chosen={filter}
          onChoose={(id) => {
            setFilter(id);
            setBefore(undefined);
          }}
        />
      </header>
      {listing.status === "failed" && (
        <p role="alert" className="said failed">
          {listing.message}
        </p>
      )}
      {listing.status === "listed" && !listing.threads.length && <p className="email-none">{nothing}</p>}
      <ul className="email-threads" aria-label="Threads" aria-busy={listing.status === "reading" || undefined} onKeyDown={onKey}>
        {listing.status === "listed" && listing.threads.map((thread) => <ThreadRow key={thread.id} thread={thread} open={thread.id === openThread} onOpen={open} />)}
      </ul>
      {listing.status === "listed" && listing.more && (
        <button type="button" className="button" onClick={() => setBefore(listing.threads[listing.threads.length - 1]?.lastAt)}>
          Show older threads
        </button>
      )}
    </>
  );
}

/**
 * The member's contacts and the data source a new one would go in, as `contact.list` says them, or
 * null until they are read or where they can't be. A contact the member makes here joins them.
 */
function useContacts(host: PluginHost) {
  const [read, setRead] = useState<{ contacts: readonly Contact[]; sources: readonly Source[] } | null>(null);
  useEffect(() => {
    let live = true;
    host.perform({ type: "contact.list" }).then(
      ({ contacts, sources }) => live && setRead({ contacts, sources }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host]);
  const added = (contact: Contact) => setRead((was) => was && { ...was, contacts: [...was.contacts, contact] });
  return { read, added };
}

type Contacts = ReturnType<typeof useContacts>;

function Conversation({ host, app, id, contacts }: { host: PluginHost; app: App; id: string; contacts: Contacts }) {
  const [reading, setReading] = useState<Reading>({ status: "reading" });
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    host.perform({ type: "email.thread", sourceId: "email", id }).then(
      (thread) => live && setReading({ status: "read", thread }),
      (err: Error) => live && setReading({ status: "failed", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, id]);

  if (reading.status === "failed")
    return (
      <p role="alert" className="said failed">
        {reading.message}
      </p>
    );
  if (reading.status === "reading") return <p className="email-none">Reading…</p>;
  const { thread } = reading;
  const last = thread.messages[thread.messages.length - 1];
  // Mail like this is what someone else sent, the latest the member forwarded, or what came through a list. The member's own is never
  // offered: a rule from their own address would drop all they send.
  const forwarded = thread.messages.findLast((m) => m.via === "forwarded");
  const theirs = forwarded ?? thread.messages.findLast((m) => m.listId !== null);
  // A sender is offered to the contacts only where they are someone else, aren't a contact yet, and there is somewhere to add them.
  const addTo = contacts.read && addingTo(contacts.read.sources);
  const known = forwarded && contacts.read?.contacts.some((c) => c.emails.some((e) => e.value.trim().toLowerCase() === forwarded.from.address));
  const sender = !known && addTo ? forwarded : undefined;
  return (
    <article className="email-conversation" aria-label={thread.subject}>
      <header className="email-thread-head">
        <button type="button" className="link email-back" onClick={() => app.go(EMAIL_PATH)}>
          All threads
        </button>
        <h1>{thread.subject}</h1>
        <div className="email-actions" role="toolbar" aria-label="Thread">
          <button type="button" className="button small" onClick={() => void noteFrom(host, thread)}>
            Make a note from this
          </button>
          <button type="button" className="button small" onClick={() => void copyLink(host, thread.id, `the thread ${thread.subject}`)}>
            Copy link
          </button>
          {theirs && (
            <button type="button" className="button small" onClick={() => skipLike(app, ruleLike(theirs))}>
              Skip mail like this
            </button>
          )}
          {sender && (
            <button type="button" className="button small" aria-expanded={adding} onClick={() => setAdding(true)}>
              Add sender to contacts
            </button>
          )}
        </div>
      </header>
      {adding && sender && addTo && (
        <section className="person-contact email-new-contact" aria-label="Add sender to contacts">
          <p className="person-whose">
            Adds {who(sender.from)} to {addTo.name}.
          </p>
          <NewContact
            host={host}
            sourceId={addTo.id}
            name={sender.from.name}
            email={sender.from.address}
            onCancel={() => setAdding(false)}
            onSaved={(card) => {
              setAdding(false);
              contacts.added(card);
              host.app().notify({ message: `Added ${card.name} to your contacts.`, icon: "contacts" });
            }}
          />
        </section>
      )}
      <ol className="email-messages">
        {thread.messages.map((message) => (
          <Message key={message.id} host={host} message={message} focused={message.id === id} opened={message === last || message.id === id} />
        ))}
      </ol>
    </article>
  );
}

/**
 * One message of the thread. An earlier one is folded to who sent it, how it begins and when, and
 * opens with a press. Its HTML is drawn in a frame that runs nothing, or its text where it has none
 * or the member asks for it, with what it quotes of the messages before folded away.
 */
function Message({ host, message, focused, opened }: { host: PluginHost; message: MailMessage; focused: boolean; opened: boolean }) {
  const [open, setOpen] = useState(opened);
  const [formatted, setFormatted] = useState(true);
  const [quoteShown, setQuoteShown] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) item.current?.scrollIntoView({ block: "start" });
  }, [focused]);
  const label = `${who(message.from)}, ${when(message.sentAt)}`;

  if (!open)
    return (
      <li ref={item} className="email-message" data-folded="" aria-label={label}>
        <button type="button" className="email-fold" aria-expanded="false" onClick={() => setOpen(true)}>
          <strong>{who(message.from)}</strong>
          <span className="email-snippet">{message.text.replace(/\s+/g, " ").trim()}</span>
          <span className="email-when">{when(message.sentAt)}</span>
        </button>
      </li>
    );
  const { said, quote } = quoted(message.text);
  const html = formatted && message.html;
  return (
    <li ref={item} className="email-message" data-focused={focused || undefined} aria-label={label}>
      <header className="email-message-head">
        <button type="button" className="email-fold" aria-expanded="true" aria-label={`Fold the message from ${who(message.from)}`} onClick={() => setOpen(false)}>
          <strong>{who(message.from)}</strong> <span className="email-address">{message.from.address}</span>
        </button>
        <span className="email-when">{when(message.sentAt)}</span>
        {message.via === "forwarded" && <span className="email-via">Forwarded by you</span>}
      </header>
      <dl className="email-fields">
        {message.to.length > 0 && (
          <>
            <dt>To</dt>
            <dd>{whoAll(message.to)}</dd>
          </>
        )}
        {message.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{whoAll(message.cc)}</dd>
          </>
        )}
      </dl>
      {message.comment && <p className="email-comment">{message.comment}</p>}
      {html ? (
        <MailHtml html={html} title={`${message.subject} as formatted`} />
      ) : (
        <>
          <div className="email-text">{quoteShown || !quote ? message.text : said}</div>
          {quote && (
            <button type="button" className="link email-quote" aria-expanded={quoteShown} onClick={() => setQuoteShown((on) => !on)}>
              {quoteShown ? "Hide quoted text" : "Show quoted text"}
            </button>
          )}
        </>
      )}
      {message.attachments.length > 0 && (
        <ul className="email-files" aria-label="Attachments">
          {message.attachments.map((a, i) => (
            <li key={i} className="email-file" title="Only its name, type and size are kept">
              <Icon name="attachment" />
              <span className="email-file-name">{a.name}</span>
              <span className="email-address">
                {a.type} · {size(a.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <footer className="email-message-foot">
        {message.html && (
          <button type="button" className="link" onClick={() => setFormatted((on) => !on)}>
            {formatted ? "Show text" : "Show formatted"}
          </button>
        )}
        <button type="button" className="link" onClick={() => void copyLink(host, message.id, `the message from ${who(message.from)}`)}>
          Copy link to this message
        </button>
      </footer>
    </li>
  );
}

/**
 * A message's HTML, sanitized as it arrived, drawn as HTML embeds are: in a frame of its own origin
 * with no network (src/web/htmlFrame.ts), where it runs nothing and its links open a tab of their
 * own. The frame is as tall as the message.
 */
function MailHtml({ html, title }: { html: string; title: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    const { frame, stop } = sandboxed(html, {
      title,
      mail: true,
      refused: () => setRefused(true),
      tall: (px) => (frame.style.height = `${Math.min(Math.max(px, 40), 20_000)}px`),
    });
    frame.className = "email-html";
    holder.current!.replaceChildren(frame);
    return () => {
      stop();
      frame.remove();
    };
  }, [html, title]);
  return (
    <>
      <div ref={holder} className="email-html-holder" />
      {refused && <p className="said failed">The formatted message couldn't be shown. Show its text instead.</p>}
    </>
  );
}
