import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, ago, useNow, type Agent, type AgentEdit, type ExpiresIn, type Folders, type PluginHost, type WorkspaceSummary } from "../../plugin-api.ts";
import { Copyable } from "../lib/Copyable.tsx";
import { RevertAuthor } from "../lib/RevertAuthor.tsx";

const DAY_MS = 86_400_000;
const EXPIRIES = [30, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS];

/** Where the folders an agent is limited to can be read and chosen: the workspace that is open, and its folders. */
interface Here {
  workspace: WorkspaceSummary;
  folders: Folders | null;
}

/** The folders an agent is limited to that are there to be shown: those of the open workspace that the member can still see. */
const shownFolders = (agent: Agent | undefined, { workspace, folders }: Here) => (agent?.workspaceId === workspace.id ? (agent.folderIds ?? []).filter((id) => folders?.byId.has(id)) : []);

/**
 * Which notes an agent reaches: all of them, or only chosen folders with the folders inside them.
 * Folders are chosen from the open workspace's, so only for an agent that reaches that workspace alone.
 * `reaches` is the workspace picked in the form, or "" for every workspace.
 */
function FolderLimit({ reaches, workspaces, here, agent }: { reaches: string; workspaces: readonly WorkspaceSummary[]; here: Here; agent?: Agent }) {
  const { workspace, folders } = here;
  const [limited, setLimited] = useState(agent ? agent.folderIds !== null : false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(shownFolders(agent, here)));
  /** Its folders are in a workspace that isn't open: they stay as they are unless all notes is picked. */
  const kept = !!agent?.folderIds && agent.workspaceId !== workspace.id && reaches === agent.workspaceId;
  const choosing = reaches === workspace.id;
  const on = limited && (choosing || kept);
  const named = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "a workspace you have left";
  const gone = agent?.workspaceId === workspace.id && agent.folderIds ? agent.folderIds.length - shownFolders(agent, here).length : 0;

  const rows: { id: string; name: string; path: string; depth: number; covered: boolean }[] = [];
  const visit = (parentId: string | null, depth: number, covered: boolean) => {
    for (const folder of folders?.childrenOf(parentId) ?? []) {
      rows.push({ id: folder.id, name: folder.name, path: folders!.pathName(folder.id), depth, covered });
      visit(folder.id, depth + 1, covered || picked.has(folder.id));
    }
  };
  if (on && choosing) visit(null, 0, false);

  return (
    <fieldset className="folder-limit">
      <legend>Notes</legend>
      <label className="check">
        <input type="radio" name="notes" value="all" checked={!on} onChange={() => setLimited(false)} />
        <span>All notes</span>
      </label>
      <label className="check">
        <input type="radio" name="notes" value={kept ? "kept" : "folders"} checked={on} disabled={!choosing && !kept} onChange={() => setLimited(true)} />
        <span>Only chosen folders, with the folders inside them</span>
      </label>
      {!choosing && !kept && <p className="hint">{reaches ? `Open ${named(reaches)} to choose folders in it.` : "To limit it to folders, have it reach only one workspace."}</p>}
      {on && kept && (
        <p className="hint">
          {agent!.folderIds!.length === 1 ? "1 folder" : `${agent!.folderIds!.length} folders`} in {named(reaches)}. Open that workspace to choose others.
        </p>
      )}
      {on && choosing && (
        <>
          <div className="folder-picks" role="group" aria-label="Folders it reaches">
            {rows.map((row) => (
              <label key={row.id} className="check" style={{ "--depth": row.depth } as CSSProperties}>
                <input
                  type="checkbox"
                  name="folder"
                  value={row.id}
                  aria-label={row.path}
                  checked={row.covered || picked.has(row.id)}
                  disabled={row.covered}
                  onChange={(e) => setPicked((was) => new Set(e.target.checked ? [...was, row.id] : [...was].filter((id) => id !== row.id)))}
                />
                <span>{row.name}</span>
              </label>
            ))}
          </div>
          {gone > 0 && <p className="hint">{gone === 1 ? "A folder it was limited to is no longer there." : `${gone} folders it was limited to are no longer there.`}</p>}
        </>
      )}
    </fieldset>
  );
}

/**
 * What an agent may do, as a form's fields: the same when it is connected and when it is edited.
 * `agent` is the one being edited, whose expiry stays as it is unless another is picked.
 */
function Permissions({ workspaces, here, agent, ends }: { workspaces: readonly WorkspaceSummary[]; here: Here; agent?: Agent; ends?: string }) {
  const [reaches, setReaches] = useState(agent?.workspaceId ?? "");
  return (
    <>
      <label>
        <span>Reaches</span>
        <select name="workspace" value={reaches} onChange={(e) => setReaches(e.target.value)}>
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
      <FolderLimit reaches={reaches} workspaces={workspaces} here={here} agent={agent} />
      <label className="check">
        <input type="checkbox" name="readOnly" defaultChecked={agent?.readOnly} />
        <span>Read only: it can read and can't change anything</span>
      </label>
    </>
  );
}

/** The fields of `Permissions` as the form holds them. An expiry left as it is is left out, and `folders` is "kept" for folders that can't be changed from the open workspace. */
function permissionsOf(data: FormData): { workspaceId: string | null; expiresInDays?: ExpiresIn; readOnly: boolean; folders: "all" | "kept" | string[] } {
  const expires = data.get("expires") as string;
  const notes = data.get("notes") as string;
  return {
    workspaceId: (data.get("workspace") as string) || null,
    ...(expires && { expiresInDays: expires === "never" ? "never" : Number(expires) }),
    readOnly: data.has("readOnly"),
    folders: notes === "folders" ? (data.getAll("folder") as string[]) : notes === "kept" ? "kept" : "all",
  };
}

const NO_FOLDERS = "Choose at least one folder, or All notes";
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

interface Props {
  host: PluginHost;
  /** The workspace whose history an agent's changes are shown and reverted in. */
  workspace: WorkspaceSummary;
  /** Every workspace the member is in, for limiting a token to one. */
  workspaces: readonly WorkspaceSummary[];
  /** The open workspace's folders, for limiting a token to some of them. Null until they are read. */
  folders: Folders | null;
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
export function Agents({ host, workspace, workspaces, folders, version, onShowChanges, onReverted }: Props) {
  const here: Here = { workspace, folders };
  /** Counts the agents connected from the form, so its fields start again after each. */
  const [connects, setConnects] = useState(0);
  const now = useNow();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  /** The agents that have changed a note in this workspace. */
  const [wrote, setWrote] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<{ agent: Agent; token: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
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
      const { workspaceId, folders: chosen, ...options } = permissionsOf(data);
      if (Array.isArray(chosen) && !chosen.length) return setError(NO_FOLDERS);
      setFresh(await host.agents.connect(data.get("name") as string, { ...options, workspaceId: workspaceId ?? undefined, ...(Array.isArray(chosen) && { folderIds: chosen }) }));
      form.reset();
      setConnects((n) => n + 1);
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
      const { workspaceId, expiresInDays, readOnly, folders: chosen } = permissionsOf(new FormData(e.currentTarget));
      // Folders that are gone were never shown, so a form saved as it was opened leaves the limit alone.
      const refolded = chosen === "all" ? agent.folderIds !== null : chosen !== "kept" && !(agent.folderIds && sameSet(chosen, shownFolders(agent, here)));
      if (refolded && Array.isArray(chosen) && !chosen.length) return setError(NO_FOLDERS);
      const edit: AgentEdit = {
        ...(workspaceId !== agent.workspaceId && { workspaceId }),
        ...(expiresInDays !== undefined && { expiresInDays }),
        ...(readOnly !== agent.readOnly && { readOnly }),
        ...(refolded && { folderIds: chosen === "all" ? null : (chosen as string[]) }),
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

  const listed = (items: string[]) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  /** The folders an agent is limited to, by name where they are the open workspace's and still there. */
  const limit = (agent: Agent) => {
    const ids = agent.folderIds ?? [];
    if (agent.workspaceId !== workspace.id || !folders) return ids.length === 1 ? "1 folder" : `${ids.length} folders`;
    const names = shownFolders(agent, here).map((id) => folders.pathName(id));
    const gone = ids.length - names.length;
    return names.length ? listed([...names, ...(gone ? [gone === 1 ? "a folder that is gone" : `${gone} folders that are gone`] : [])]) : null;
  };
  const reach = (agent: Agent) => {
    if (!agent.workspaceId) return "every workspace you're in";
    const name = workspaces.find((w) => w.id === agent.workspaceId)?.name ?? "a workspace you have left";
    if (!agent.folderIds) return `only ${name}`;
    const within = limit(agent);
    return within ? `only ${within} in ${name}` : `nothing in ${name}, as the folders it was limited to are gone`;
  };
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
        {agent.folderIds && <span className="badge">limited to folders</span>}
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
                version={version}
                beyond={agent.workspaceId === null && workspaces.length > 1 ? `Your other workspaces aren't covered. Switch to each one to revert ${agent.name}'s changes there.` : undefined}
                onReverted={onReverted}
              />
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
          <Permissions workspaces={workspaces} here={here} agent={agent} ends={ends(agent)} />
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
        <Permissions key={connects} workspaces={workspaces} here={here} />
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
