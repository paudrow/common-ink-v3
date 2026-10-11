import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, ago, useNow, type Agent, type PluginHost, type WorkspaceSummary } from "../../plugin-api.ts";
import { Copyable } from "../lib/Copyable.tsx";
import { RevertAuthor } from "../lib/RevertAuthor.tsx";

const DAY_MS = 86_400_000;
const EXPIRIES = [30, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS];

interface Props {
  host: PluginHost;
  /** The workspace whose history an agent's changes are shown and reverted in. */
  workspace: WorkspaceSummary;
  /** Every workspace the member is in, for limiting a token to one. */
  workspaces: readonly WorkspaceSummary[];
  /** Changes when the workspace's notes do, so which agents have changed one is read again. */
  version: number;
  /** Left out when there is nowhere to show them. */
  onShowChanges?: (agentId: string) => void;
  /** Called once an agent's changes were reverted, so the notes are read again. */
  onReverted: () => void;
}

/** A new agent's token, shown this once, with what to paste to use it. */
function NewToken({ agent, token, onDone }: { agent: Agent; token: string; onDone: () => void }) {
  const url = `${location.origin}/mcp`;
  return (
    <section className="new-token" aria-label="New token">
      <p>
        <strong>{agent.name} is connected.</strong> Copy its token now. It isn't shown again.
      </p>
      <Copyable label="Token" value={token} />
      <Copyable label="ink command" value={`export INK_URL=${location.origin}\nexport INK_TOKEN=${token}\nnpm run ink -- notes`} />
      <p className="hint">
        The ink command runs from a checkout of Common Ink and reads the token from INK_TOKEN, so the token is in no command but the export. That line stays in your shell's history unless you
        take it out.
      </p>
      <Copyable label="Claude Code" value={`claude mcp add --transport http common-ink ${url} --header "Authorization: Bearer $INK_TOKEN"`} />
      <p className="hint">Run it in the shell where INK_TOKEN is exported. Claude Code then keeps the token, unencrypted, in its settings file in your home folder (~/.claude.json).</p>
      <Copyable label="MCP config" value={JSON.stringify({ mcpServers: { "common-ink": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } })} />
      <p className="hint">For any other MCP client. The token is stored wherever that client keeps this config, so keep that file to yourself.</p>
      <button type="button" className="button small" onClick={onDone}>
        Done
      </button>
    </section>
  );
}

/** Where a member connects and disconnects their agents, and reverts what one of them changed. */
export function Agents({ host, workspace, workspaces, version, onShowChanges, onReverted }: Props) {
  const now = useNow();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  /** The agents that have changed a note in this workspace. */
  const [wrote, setWrote] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<{ agent: Agent; token: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = workspace.role !== "viewer";

  const load = useCallback(() => host.agents.list().then(setAgents, (err: Error) => setError(err.message)), [host]);
  useEffect(() => {
    void load();
    let live = true;
    host.perform({ type: "history.authors" }).then((authors) => live && setWrote(new Set(authors.flatMap((a) => (a.kind === "agent" ? [a.agentId] : [])))));
    return () => {
      live = false;
    };
  }, [host, version, load]);

  const connect = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError(null);
    try {
      setFresh(
        await host.agents.connect(data.get("name") as string, {
          label: (data.get("label") as string) || undefined,
          workspaceId: (data.get("workspace") as string) || undefined,
          expiresInDays: Number(data.get("expires")),
          readOnly: data.has("readOnly"),
        }),
      );
      form.reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const disconnect = async (agent: Agent) => {
    setDisconnecting(null);
    setError(null);
    try {
      await host.agents.disconnect(agent.id);
      if (fresh?.agent.id === agent.id) setFresh(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const reach = (agent: Agent) => (agent.workspaceId ? `only ${workspaces.find((w) => w.id === agent.workspaceId)?.name ?? "a workspace you have left"}` : "every workspace you're in");
  const ends = (agent: Agent) => {
    if (agent.revokedAt !== null) return `disconnected ${ago(agent.revokedAt, now)}`;
    if (agent.expiresAt <= now) return `expired ${ago(agent.expiresAt, now)}`;
    const days = Math.round((agent.expiresAt - now) / DAY_MS);
    return days < 1 ? "expires today" : `expires in ${days} ${days === 1 ? "day" : "days"}`;
  };
  const connected = (agent: Agent) => agent.revokedAt === null && agent.expiresAt > now;

  const row = (agent: Agent) => (
    <li key={agent.id} className="agent" aria-label={agent.label ? `${agent.name}, ${agent.label}` : agent.name}>
      <div className="agent-head">
        <span className="agent-name">{agent.name}</span>
        {agent.label && <span className="badge">{agent.label}</span>}
        {agent.readOnly && <span className="badge">read only</span>}
      </div>
      <p className="agent-meta">
        <code>{agent.tokenPrefix}…</code> · reaches {reach(agent)} · connected {ago(agent.createdAt, now)} · {agent.lastUsedAt === null ? "never used" : `last used ${ago(agent.lastUsedAt, now)}`} · {ends(agent)}
      </p>
      <div className="agent-actions">
        {wrote.has(agent.id) ? (
          <>
            {onShowChanges && (
              <button type="button" className="button small" onClick={() => onShowChanges(agent.id)}>
                See its changes
              </button>
            )}
            {canEdit && (
              <RevertAuthor
                host={host}
                author={{ kind: "agent", id: agent.id }}
                name={agent.name}
                where={`in ${workspace.name}`}
                beyond={agent.workspaceId === null && workspaces.length > 1 ? `Your other workspaces aren't covered. Switch to each one to revert ${agent.name}'s changes there.` : undefined}
                onReverted={onReverted}
              />
            )}
          </>
        ) : (
          <span className="hint">No changes in {workspace.name}</span>
        )}
        {connected(agent) &&
          (disconnecting === agent.id ? (
            <span className="confirm" role="group" aria-label={`Disconnect ${agent.name}`}>
              <span>Its token stops working at once. Its changes stay in history.</span>
              <button type="button" className="button small primary" autoFocus onClick={() => disconnect(agent)}>
                Disconnect
              </button>
              <button type="button" className="link" onClick={() => setDisconnecting(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="button small" onClick={() => setDisconnecting(agent.id)}>
              Disconnect
            </button>
          ))}
      </div>
    </li>
  );

  const live = agents?.filter(connected) ?? [];
  const past = agents?.filter((a) => !connected(a)) ?? [];
  return (
    <section className="agents" aria-label="Agents">
      <h1>Agents</h1>
      <p className="lead">
        An agent is a program you connect, such as Claude. It reads and edits notes as you, with your role in each workspace and no more, and its changes are recorded under its own name.
      </p>

      <form className="connect" aria-label="Connect an agent" onSubmit={connect}>
        <h2>Connect an agent</h2>
        <label>
          <span>Name</span>
          <input name="name" required maxLength={MAX_AGENT_NAME} placeholder="Claude" autoComplete="off" />
        </label>
        <label>
          <span>Label</span>
          <input name="label" maxLength={MAX_AGENT_NAME} placeholder="Optional, such as laptop" autoComplete="off" />
        </label>
        <label>
          <span>Reaches</span>
          <select name="workspace" defaultValue="">
            <option value="">Every workspace I'm in</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                Only {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Expires in</span>
          <select name="expires" defaultValue={DEFAULT_EXPIRY_DAYS}>
            {EXPIRIES.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" name="readOnly" />
          <span>Read only: it can read and can't change anything</span>
        </label>
        <button type="submit" className="button primary">
          Connect
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {fresh && <NewToken agent={fresh.agent} token={fresh.token} onDone={() => setFresh(null)} />}

      <h2>Connected</h2>
      {agents && !live.length && <p className="empty">No agent is connected.</p>}
      <ul className="agent-list" aria-label="Connected agents">
        {live.map(row)}
      </ul>
      {past.length > 0 && (
        <>
          <h2>No longer connected</h2>
          <ul className="agent-list" aria-label="Agents no longer connected">
            {past.map(row)}
          </ul>
        </>
      )}
    </section>
  );
}
