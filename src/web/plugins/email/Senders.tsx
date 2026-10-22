import { useEffect, useState, type FormEvent } from "react";
import type { MailSenders, PluginHost } from "../../plugin-api.ts";

/** A code just made for an address, which is shown once: the server keeps only its hash. */
interface Code {
  address: string;
  code: string;
}

/**
 * The addresses the member's mail is recognized by: the one they sign in with, and those they add.
 * An added address is trusted once mail from it carries its code to notes@, which proves they can
 * send as it. The same list is in Settings, under Email, and on the Email page.
 */
export function Senders({ host }: { host: PluginHost }) {
  const [known, setKnown] = useState<MailSenders | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<Code | null>(null);

  useEffect(() => {
    let live = true;
    host.perform({ type: "email.senders" }).then(
      (answer) => live && setKnown(answer),
      (err: Error) => live && setProblem(err.message),
    );
    return () => {
      live = false;
    };
  }, [host]);

  const act = async (doing: () => Promise<MailSenders & { code?: string }>, address?: string) => {
    setProblem(null);
    setBusy(true);
    try {
      const answer = await doing();
      setKnown(answer);
      if (answer.code && address) setCode({ address, code: answer.code });
      return true;
    } catch (err) {
      setProblem((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (address: string) => act(() => host.perform({ type: "email.addSender", address }), address.trim().toLowerCase());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim() && (await add(typed))) setTyped("");
  };

  if (!known && !problem) return null;
  return (
    <section className="sources email-senders" aria-label="Your addresses">
      <h2>Your addresses</h2>
      <p className="sources-none">Mail is kept only from these, and only when its domain vouches that it was sent from there (DMARC or DKIM). Mail from any other address is dropped, and its sender isn't told.</p>
      {known && (
        <ul className="source-list">
          {known.senders.map((sender) => (
            <li key={sender.address} aria-label={sender.address} data-state={sender.verified ? "connected" : "not_connected"}>
              <span className="source-what">
                <strong>{sender.address}</strong>
                <span className="source-meta">{sender.account ? "The email you sign in with" : sender.verified ? "Verified" : sender.expiresAt && sender.expiresAt > Date.now() ? "Waiting for its code" : "Its code lapsed"}</span>
              </span>
              {!sender.account && !sender.verified && (
                <button type="button" className="link" disabled={busy} onClick={() => void add(sender.address)}>
                  New code
                </button>
              )}
              {!sender.account && (
                <button type="button" className="link" disabled={busy} onClick={() => void act(() => host.perform({ type: "email.removeSender", address: sender.address }))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {code && known?.address && (
        <div className="email-code" role="status">
          <p>
            To verify <strong>{code.address}</strong>, send an email from it to <strong>{known.address}</strong> with this code in the subject, within a day:
          </p>
          <p className="email-code-value">
            <code>{code.code}</code>
          </p>
          <p className="sources-none">The code is shown only now. The message that carries it verifies the address and isn't kept.</p>
        </div>
      )}
      <form className="email-add" onSubmit={(e) => void submit(e)}>
        <input type="email" aria-label="Address to add" placeholder="you@work.example" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button type="submit" className="button" disabled={busy || !typed.trim()}>
          Add address
        </button>
      </form>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
    </section>
  );
}
