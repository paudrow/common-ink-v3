import { useEffect, useState, type ReactNode } from "react";
import type { App, PluginHost, Source, SourceKind } from "../../plugin-api.ts";
import { forgetReferences } from "./references.tsx";

const NOUN = { calendar: "calendar", contacts: "contacts" } as const satisfies Record<SourceKind, string>;
const RECORDS = { calendar: "events", contacts: "contacts" } as const satisfies Record<SourceKind, string>;

/** The member's data sources of every kind, as `source.list` answers them, and a way to say they changed. */
export function useSources(host: PluginHost) {
  const [sources, setSources] = useState<readonly Source[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.perform({ type: "source.list" }).then(
      (answer) => live && setSources(answer.sources),
      (err: Error) => live && setProblem(err.message),
    );
    return () => {
      live = false;
    };
  }, [host]);
  return { sources, setSources, problem };
}

/** `sources` with each of `fresher` in place of the one it has by that id: a listing learns that a data source stopped answering before `source.list` is asked again. */
export function withFresher(sources: readonly Source[] | null, fresher: readonly Source[]): readonly Source[] | null {
  if (!sources) return sources;
  const byId = new Map(fresher.map((s) => [s.id, s]));
  const next = sources.map((s) => byId.get(s.id) ?? s);
  return next.some((s, i) => s.state !== sources[i]!.state || s.account !== sources[i]!.account || s.writable !== sources[i]!.writable) ? next : sources;
}

interface Props {
  host: PluginHost;
  app: App;
  kind: SourceKind;
  /** Every data source the member has, of any kind. Null while they are read. */
  sources: readonly Source[] | null;
  /** Handed the data sources as they are after one was connected or disconnected. */
  onChange: (sources: readonly Source[]) => void;
  /** Drawn under a connected data source, such as the calendars in it. */
  below?: (source: Source) => ReactNode;
  /** Whether to say what the list is with a heading of its own, where nothing around it says so. */
  heading?: boolean;
}

/**
 * The data sources of one kind: which are connected and to what account, with the way to connect,
 * reconnect and disconnect each. Everything said here is drawn from what `source.list` answers.
 */
export function Sources({ host, app, kind, sources, onChange, below, heading = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  if (!sources) return null;

  const mine = sources.filter((s) => s.kind === kind);
  const act = async (doing: () => Promise<{ sources: Source[]; redirect?: string | null }>) => {
    setProblem(null);
    setBusy(true);
    try {
      const answer = await doing();
      // Off to where the member agrees to it, which comes back to this page.
      if (answer.redirect) return void (location.href = answer.redirect);
      forgetReferences();
      onChange(answer.sources);
    } catch (err) {
      setProblem((err as Error).message);
    }
    setAsking(null);
    setBusy(false);
  };
  const connect = (source: Source) => act(() => host.perform({ type: "source.connect", id: source.id, back: app.path }));

  return (
    <section className="sources" aria-label="Data sources">
      {heading && <h2>Data sources</h2>}
      {!sources.length && <p className="sources-none">Data sources are not set up on this Common Ink, so there is no {NOUN[kind]} to connect.</p>}
      {sources.length > 0 && !sources.some((s) => s.provider === "Google") && (
        <p className="sources-none">
          This sign-in has no Google account behind it, so there is no Google {kind === "calendar" ? "Calendar" : "Contacts"} to connect.
        </p>
      )}
      <ul className="source-list">
        {mine.map((source) => {
          const together = sources.filter((s) => s.provider === source.provider);
          return (
            <li key={source.id} aria-label={source.name} data-state={source.state}>
              {source.state === "connected" && (
                <>
                  <span className="source-what">
                    <strong>{source.name}</strong>
                    <span className="source-meta">
                      Connected{source.account ? ` to ${source.account}` : ""}
                      {kind === "calendar" && !source.writable ? " · Read-only" : ""}
                    </span>
                  </span>
                  {asking === source.id ? (
                    <div className="confirm" role="group" aria-label={`Disconnect ${source.provider}`}>
                      <span>
                        Disconnecting {source.provider} disconnects {together.map((s) => s.name).join(" and ")} together: they were connected as one account. References to their records stop showing details.
                      </span>
                      <button type="button" className="button small danger" autoFocus disabled={busy} onClick={() => void act(() => host.perform({ type: "source.disconnect", id: source.id }))}>
                        Disconnect {source.provider}
                      </button>
                      <button type="button" className="link" onClick={() => setAsking(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="link" onClick={() => setAsking(source.id)}>
                      Disconnect {source.provider}…
                    </button>
                  )}
                  {below?.(source)}
                </>
              )}
              {source.state === "not_connected" && (
                <>
                  <span className="source-what">
                    <strong>{source.name}</strong>
                    <span className="source-meta">
                      Not connected. Connect it to see your {RECORDS[kind]} here. Only you see them, and no other member is told you connected it.
                    </span>
                  </span>
                  <button type="button" className="button primary" disabled={busy} onClick={() => void connect(source)}>
                    Connect {source.name}
                  </button>
                </>
              )}
              {source.state === "needs_reconnect" && (
                <>
                  <span className="source-what">
                    <strong>{source.name}</strong>
                    <span className="source-meta">
                      {source.provider} stopped answering for {source.account ?? "your account"}. Reconnect it to see your {RECORDS[kind]} again.
                    </span>
                  </span>
                  <button type="button" className="button primary" disabled={busy} onClick={() => void connect(source)}>
                    Reconnect {source.name}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
    </section>
  );
}
