import { useCallback, useEffect, useState } from "react";
import type { MailAddress, MailMessage, MailThread, MailThreadRead, PluginHost, ViewProps } from "../../plugin-api.ts";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { EMAIL_PATH } from "./linking.tsx";
import { Senders } from "./Senders.tsx";

type Listing = { status: "reading" } | { status: "listed"; threads: readonly MailThread[]; more: boolean } | { status: "failed"; message: string };
type Reading = { status: "reading" } | { status: "read"; thread: MailThreadRead } | { status: "failed"; message: string };

/** What a message's HTML may load in its frame: nothing from anywhere, but the pictures inside it. */
const FRAME_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'">`;

const when = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const who = (a: MailAddress) => a.name || a.address;
const whoAll = (list: readonly MailAddress[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** Copies what a note writes to link to a thread, or one message in it, and says so. */
export async function copyReference(host: PluginHost, id: string, what: string): Promise<void> {
  const app = host.app();
  try {
    const { text } = await host.perform({ type: "record.refer", sourceId: "email", id });
    try {
      await navigator.clipboard.writeText(text);
      app.notify({ message: `Copied the link to ${what}. Paste it into a note.`, icon: "mail" });
    } catch {
      // A page served over plain http has no clipboard to write to, so the link is said, to copy by hand.
      app.notify({ message: `The link to ${what}, to copy into a note: ${text}`, icon: "mail" });
    }
  } catch (err) {
    app.notify({ message: (err as Error).message, icon: "mail" });
  }
}

/**
 * Email: the threads the member sent, copied or forwarded to notes@, which nobody else sees. `/email`
 * lists them, latest first, and `/email/<id>` is one thread with every message in it.
 */
export function EmailPage({ host, app }: ViewProps & { host: PluginHost }) {
  const { sources, setSources, problem } = useSources(host);
  const [asked, setAsked] = useState(0);
  const learn = useCallback((fresher: Parameters<typeof withFresher>[1]) => setSources((known) => withFresher(known, fresher)), [setSources]);
  const threadId = app.path.startsWith(`${EMAIL_PATH}/`) ? decodeURIComponent(app.path.slice(EMAIL_PATH.length + 1)) : null;
  const connected = (sources ?? []).some((s) => s.kind === "email" && s.state === "connected");
  const address = (sources ?? []).find((s) => s.kind === "email")?.account ?? null;

  return (
    <section className="email-page" aria-label="Email">
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {threadId && connected ? (
        <ThreadView host={host} id={threadId} back={() => app.go(EMAIL_PATH)} />
      ) : (
        <>
          <h1>Email</h1>
          {connected && (
            <>
              <p className="email-how">
                Send, copy (BCC) or forward mail to <strong>{address}</strong> from an address of yours below, and it is kept here as a thread, for you alone. Mail from anyone else is dropped.
              </p>
              <ThreadList host={host} asked={asked} open={(id) => app.go(`${EMAIL_PATH}/${encodeURIComponent(id)}`)} onSources={learn} />
            </>
          )}
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
        </>
      )}
    </section>
  );
}

function ThreadList({ host, asked, open, onSources }: { host: PluginHost; asked: number; open: (id: string) => void; onSources: (sources: Parameters<typeof withFresher>[1]) => void }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "reading" });
  const [before, setBefore] = useState<number | undefined>(undefined);

  // Connecting or disconnecting lists from the start again.
  useEffect(() => setBefore(undefined), [asked]);

  useEffect(() => {
    const wait = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(wait);
  }, [typed]);

  useEffect(() => {
    let live = true;
    host.perform({ type: "email.list", ...(query ? { query } : {}), ...(before !== undefined ? { before } : {}) }).then(
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
  }, [host, query, before, asked, onSources]);

  return (
    <>
      <input
        type="search"
        className="email-search"
        aria-label="Search email"
        placeholder="Search by subject, sender or words"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setBefore(undefined);
        }}
      />
      {listing.status === "failed" && (
        <p role="alert" className="said failed">
          {listing.message}
        </p>
      )}
      {listing.status === "listed" && !listing.threads.length && <p className="email-none">{query ? "No thread has those words." : "Nothing yet. Mail sent here shows up as it arrives."}</p>}
      <ul className="cards email-threads" aria-label="Threads">
        {listing.status === "listed" &&
          listing.threads.map((thread) => (
            <li key={thread.id} aria-label={thread.subject}>
              <a
                className="card email-thread"
                href={`${EMAIL_PATH}/${encodeURIComponent(thread.id)}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  open(thread.id);
                }}
              >
                <span className="email-subject">
                  {thread.subject}
                  {thread.count > 1 && <span className="email-count"> {thread.count}</span>}
                </span>
                <span className="email-from">{thread.from.map(who).join(", ")}</span>
                <span className="email-when">{when(thread.lastAt)}</span>
                <span className="email-snippet">{thread.snippet}</span>
              </a>
            </li>
          ))}
      </ul>
      {listing.status === "listed" && listing.more && (
        <button type="button" className="button" onClick={() => setBefore(listing.threads[listing.threads.length - 1]?.lastAt)}>
          Show older threads
        </button>
      )}
    </>
  );
}

function ThreadView({ host, id, back }: { host: PluginHost; id: string; back: () => void }) {
  const [reading, setReading] = useState<Reading>({ status: "reading" });
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

  return (
    <article className="email-thread-view" aria-label="Thread">
      <button type="button" className="link" onClick={back}>
        All threads
      </button>
      {reading.status === "failed" && (
        <p role="alert" className="said failed">
          {reading.message}
        </p>
      )}
      {reading.status === "read" && (
        <>
          <header className="email-thread-head">
            <h1>{reading.thread.subject}</h1>
            <button type="button" className="button small" onClick={() => void copyReference(host, reading.thread.id, `the thread ${reading.thread.subject}`)}>
              Copy link
            </button>
          </header>
          <ol className="email-messages">
            {reading.thread.messages.map((message) => (
              <Message key={message.id} host={host} message={message} focused={message.id === id} />
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

function Message({ host, message, focused }: { host: PluginHost; message: MailMessage; focused: boolean }) {
  const [formatted, setFormatted] = useState(false);
  return (
    <li className="email-message" data-focused={focused || undefined} aria-label={`${who(message.from)}, ${when(message.sentAt)}`}>
      <header className="email-message-head">
        <strong>{who(message.from)}</strong> <span className="email-address">{message.from.address}</span>
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
      {formatted && message.html ? (
        // The HTML was sanitized when it arrived, and runs nothing here either: the frame allows no script and no form, its policy loads nothing
        // but pictures carried in the message, and its links open a tab of their own, as the sanitizing wrote each one.
        <iframe className="email-html" title={`${message.subject} as formatted`} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={`${FRAME_POLICY}${message.html}`} />
      ) : (
        <div className="email-text">{message.text}</div>
      )}
      {message.attachments.length > 0 && (
        <ul className="email-attachments" aria-label="Attachments">
          {message.attachments.map((a, i) => (
            <li key={i}>
              {a.name} <span className="email-address">({Math.max(1, Math.round(a.size / 1024))} KB, not kept)</span>
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
        <button type="button" className="link" onClick={() => void copyReference(host, message.id, `the message from ${who(message.from)}`)}>
          Copy link to this message
        </button>
      </footer>
    </li>
  );
}
