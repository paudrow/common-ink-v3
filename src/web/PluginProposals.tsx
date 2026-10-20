import { useCallback, useEffect, useState } from "react";
import type { PluginRecord } from "../core/plugins.ts";
import type { PluginProposal } from "../core/protocol.ts";
import { perform } from "./api.ts";

interface Props {
  workspaceId: string;
  onRecord: (record: PluginRecord) => void;
}

/** What each kind of request would do, said to the admin who decides. */
function asked(p: PluginProposal): string {
  const r = p.request;
  if (r.type === "plugin.install") return r.replaces ? `update ${p.name} to new code` : `install ${p.name}`;
  if (r.type === "plugin.uninstall") return `uninstall ${p.name}`;
  return `${r.allowed ? "allow" : "stop allowing"} ${p.name} ${r.capability}${r.origins ? ` for ${r.origins.join(", ")}` : ""}`;
}

/**
 * Where an admin answers what admins' agents asked to do to the workspace's plugins: nothing an agent
 * asks is done until an admin approves it here. A new plugin's code is shown before it is approved,
 * as the install form shows what an admin pastes.
 */
export function PluginProposals({ workspaceId, onRecord }: Props) {
  const [proposals, setProposals] = useState<PluginProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => perform(workspaceId, { type: "plugin.proposals" }).then((r) => setProposals(r.proposals), (err: Error) => setError(err.message)), [workspaceId]);
  useEffect(() => void load(), [load]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setError(null);
    try {
      onRecord(await perform(workspaceId, { type: "plugin.decide", id, approve }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!proposals.length && !error) return null;
  return (
    <section className="plugin-proposals" aria-label="Waiting for your approval">
      <h2>Waiting for your approval</h2>
      <p className="soon">An admin's agent asked for these. None of them is done until an admin approves it.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul className="plugin-list">
        {proposals.map((p) => (
          <li key={p.id} className="plugin-row plugin-card" aria-label={`${p.agent.name} asks to ${asked(p)}`}>
            <div className="plugin-text">
              <div className="plugin-line">
                <span className="plugin-asked">
                  {p.agent.name}, for {p.for.name}, asks to {asked(p)}
                </span>
              </div>
              {p.request.type === "plugin.install" && (
                <details>
                  <summary>Manifest and code</summary>
                  <pre className="plugin-code">{p.request.manifest}</pre>
                  <pre className="plugin-code">{p.request.code}</pre>
                </details>
              )}
            </div>
            <button type="button" className="button small" disabled={busy !== null} onClick={() => void decide(p.id, false)}>
              Decline
            </button>
            <button type="button" className="button small primary" disabled={busy !== null} onClick={() => void decide(p.id, true)}>
              Approve
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
