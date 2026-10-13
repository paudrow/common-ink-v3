import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, ago, useNow, type Agent, type AgentEdit, type ExpiresIn, type PluginHost, type WorkspaceSummary } from "../../plugin-api.ts";
import { asksOfAuthor, useReverts } from "../lib/RevertDialog.tsx";

const DAY_MS = 86_400_000;
const EXPIRIES = [30, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS];

/**
 * What an agent may do, as a form's fields: the same when it is connected and when it is edited.
 * `agent` is the one being edited, whose expiry stays as it is unless another is picked.
 */
function Permissions({ workspaces, agent, ends }: { workspaces: readonly WorkspaceSummary[]; agent?: Agent; ends?: string }) {
  return (
    <>
      <label>
        <span>Reaches</span>
        <select name="workspace" defaultValue={agent?.workspaceId ?? ""}>
          <option value="">Every workspace I'm in</option>
          {agent?.workspaceId && !workspaces.some((w) => w.id === agent.workspaceId) && <option value={agent.workspaceId}>As it is: only a workspace you have left</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              Only {w.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Expires</span>
        <select name="expires" defaultValue={agent ? "" : DEFAULT_EXPIRY_DAYS}>
          {agent && <option value="">As it is: {ends}</option>}
          {EXPIRIES.map((days) => (
            <option key={days} value={days}>
              In {days} days
            </option>
          ))}
          {agent?.expiresAt !== null && <option value="never">Never</option>}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" name="readOnly" defaultChecked={agent?.readOnly} />
        <span>Read only: it can read and can't change anything</span>
      </label>
    </>
  );
}

/** The fields of `Permissions` as the form holds them. An expiry left as it is is left out. */
function permissionsOf(data: FormData): { workspaceId: string | null; expiresInDays?: ExpiresIn; readOnly: boolean } {
  const expires = data.get("expires") as string;
  return {
    workspaceId: (data.get("workspace") as string) || null,
    ...(expires && { expiresInDays: expires === "never" ? "never" : Number(expires) }),
    readOnly: data.has("readOnly"),
  };
}

interface Props {
  host: PluginHost;
  /** The workspace whose history an agent's changes are shown and reverted in. */
  workspace: WorkspaceSummary;
  /** Every workspace the member is in, for limiting a token to one. */
  workspaces: readonly WorkspaceSummary[];
  /** Changes when the workspace's notes do, so which agents have changed one is read again. */
  version: number;
  /** Left out when there is nowhere to show them. */
  onShowChanges?: (agent: Agent) => void;
  /** Called once an agent's changes were reverted, or that was undone, so the notes are read again. */
  onReverted: () => void;
}

function Copyable({ label, value }: { label: string; value: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // A page served over plain http has no clipboard to write to, and can still copy what's selected.
      document.execCommand("copy");
    }
    setCopied(true);
  };
  return (
    <label className="copyable">
      <span>{label}</span>
      <span className="copyable-row">
        <textarea ref={field} readOnly value={value} rows={value.split("\n").length} wrap="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="button small" aria-label={`Copy ${label}`} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
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
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = workspace.role !== "viewer";
  /** The agent whose changes are being read for a revert. */
  const [reading, setReading] = useState<string | null>(null);
  const reverts = useReverts({ host, version, found: "in History", onChanged: onReverted });

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
      const { workspaceId, ...options } = permissionsOf(data);
      setFresh(await host.agents.connect(data.get("name") as string, { ...options, workspaceId: workspaceId ?? undefined }));
      form.reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const edit = async (e: FormEvent<HTMLFormElement>, agent: Agent) => {
    e.preventDefault();
    setError(null);
    try {
      // Only what was changed is sent, so saving leaves alone what the form merely showed.
      const { workspaceId, expiresInDays, readOnly } = permissionsOf(new FormData(e.currentTarget));
      const edit: AgentEdit = {
        ...(workspaceId !== agent.workspaceId && { workspaceId }),
        ...(expiresInDays !== undefined && { expiresInDays }),
        ...(readOnly !== agent.readOnly && { readOnly }),
      };
      await host.agents.edit(agent.id, edit);
      setEditing(null);
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

  const revert = async (agent: Agent) => {
    // Not `disabled` meanwhile, so the button keeps the focus the dialog gives back when it closes.
    if (reading !== null) return;
    setError(null);
    setReading(agent.id);
    try {
      const { asks, cut } = await asksOfAuthor(host, { kind: "agent", id: agent.id });
      const beyond = [
        cut && `${agent.name} changed more notes than one revert covers: these are the ones it changed last. History reaches the others.`,
        agent.workspaceId === null && workspaces.length > 1 && `Your other workspaces aren't covered. Switch to each one to revert ${agent.name}'s changes there.`,
      ].filter(Boolean);
      reverts.ask(asks, beyond.join(" ") || undefined);
    } catch (err) {
      setError((err as Error).message);
    }
    setReading(null);
  };

  const reach = (agent: Agent) => (agent.workspaceId ? `only ${workspaces.find((w) => w.id === agent.workspaceId)?.name ?? "a workspace you have left"}` : "every workspace you're in");
  const ends = (agent: Agent) => {
    if (agent.revokedAt !== null) return `disconnected ${ago(agent.revokedAt, now)}`;
    if (agent.expiresAt === null) return "never expires";
    if (agent.expiresAt <= now) return `expired ${ago(agent.expiresAt, now)}`;
    const days = Math.round((agent.expiresAt - now) / DAY_MS);
    return days < 1 ? "expires today" : `expires in ${days} ${days === 1 ? "day" : "days"}`;
  };
  const connected = (agent: Agent) => agent.revokedAt === null && (agent.expiresAt === null || agent.expiresAt > now);

  const row = (agent: Agent) => (
    <li key={agent.id} className="agent" aria-label={agent.name}>
      <div className="agent-head">
        <span className="agent-name">{agent.name}</span>
        {agent.readOnly && <span className="badge">read only</span>}
      </div>
      <p className="agent-meta">
        <code>{agent.tokenPrefix}…</code> · reaches {reach(agent)} · connected {ago(agent.createdAt, now)} · {agent.lastUsedAt === null ? "never used" : `last used ${ago(agent.lastUsedAt, now)}`} · {ends(agent)}
      </p>
      <div className="agent-actions">
        {wrote.has(agent.id) ? (
          <>
            {onShowChanges && (
              <button type="button" className="button small" onClick={() => onShowChanges(agent)}>
                See its changes
              </button>
            )}
            {canEdit && (
              <button type="button" className="button small" aria-disabled={reading !== null} onClick={() => void revert(agent)}>
                Revert {agent.name}'s changes…
              </button>
            )}
          </>
        ) : (
          <span className="hint">No changes in {workspace.name}</span>
        )}
        {agent.revokedAt === null && editing !== agent.id && (
          <button
            type="button"
            className="button small"
            onClick={() => {
              setError(null);
              setEditing(agent.id);
            }}
          >
            Edit
          </button>
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
      {editing === agent.id && (
        <form className="connect agent-edit" aria-label={`Edit ${agent.name}`} onSubmit={(e) => edit(e, agent)}>
          <Permissions workspaces={workspaces} agent={agent} ends={ends(agent)} />
          <p className="hint">{agent.name} keeps its token. What you change holds from its next call.</p>
          <div className="agent-actions">
            <button type="submit" className="button small primary">
              Save
            </button>
            <button type="button" className="link" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
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
        <Permissions workspaces={workspaces} />
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
      {reverts.shown}
    </section>
  );
}
