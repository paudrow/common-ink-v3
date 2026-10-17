import { z } from "zod";
import { newId } from "./ids.ts";
import { allows, folderLevel } from "./access.ts";
import { standingIn, type Standing } from "./standing.ts";
import { NO_SUCH_WORKSPACE, AgentEdit, ConnectOptions, MAX_AGENT_NAME, OpError, type Agent, type ExpiresIn } from "./protocol.ts";

export const TOKEN_PREFIX = "cink_";
/** What an OAuth access token starts with, after TOKEN_PREFIX's `cink_`. It is looked for in `oauth_tokens`, not in `agents`. */
export const ACCESS_PREFIX = "cink_at_";
export const MAX_ACTIVE_AGENTS = 20;
const DAY = 86_400_000;
/** How often an agent's "last used" time is rewritten, so a busy agent doesn't write on every call. */
const LAST_USED_EVERY = 10 * 60_000;

/** An agent as a request names it: whose it is, so what it may reach. */
export interface ConnectedAgent {
  agentId: string;
  personId: string;
  name: string;
  workspaceId: string | null;
  readOnly: boolean;
  /** The folders it is limited to, or null for every note its member can reach. */
  folderIds: string[] | null;
}

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A token is 256 random bits, so a plain SHA-256 is enough to keep it safe at rest: there is nothing to guess. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface AgentRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  workspace_id: string | null;
  read_only: number;
  folder_ids: string | null;
}

const COLUMNS = "id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at, workspace_id, read_only, folder_ids";

/** Only a null column is no limit. Anything kept there that isn't a list of ids is a limit to nothing. */
function foldersOf(r: Pick<AgentRow, "folder_ids">): string[] | null {
  if (r.folder_ids === null) return null;
  try {
    const kept: unknown = JSON.parse(r.folder_ids);
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.token_prefix,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  workspaceId: r.workspace_id,
  readOnly: r.read_only === 1,
  folderIds: foldersOf(r),
});

/** A token that never expires has no end, so it is always before it. */
export const ACTIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
const endOf = (expiresIn: ExpiresIn, now: number) => (expiresIn === "never" ? null : now + expiresIn * DAY);

async function roomForOneMore(db: D1Database, personId: string, now: number, replacingClientId?: string) {
  // Reconnecting an app replaces its agent, so that one does not count toward the cap.
  const active = replacingClientId
    ? await db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE person_id = ? AND ${ACTIVE} AND (client_id IS NULL OR client_id <> ?)`).bind(personId, now, replacingClientId).first<{ n: number }>()
    : await db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE person_id = ? AND ${ACTIVE}`).bind(personId, now).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_AGENTS) throw new OpError("invalid", `You can have ${MAX_ACTIVE_AGENTS} agents connected; disconnect one first`);
}

async function ownWorkspace(db: D1Database, personId: string, workspaceId: string): Promise<Standing> {
  const standing = await standingIn(db, personId, workspaceId);
  if (!standing) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  return standing;
}

/**
 * The folders to limit an agent to, as they are kept. Each has to be a folder of the one workspace
 * the agent reaches that its member can see: one they can't is answered as one that isn't there.
 */
async function folderLimit(db: D1Database, personId: string, workspaceId: string | null | undefined, folderIds: readonly string[]): Promise<string> {
  if (!workspaceId) throw new OpError("invalid", "An agent limited to folders reaches one workspace: say which, as workspaceId");
  // Asked as an agent limited to them would be, so the folders the member sees are worked out even for a member no grant narrows.
  const standing = await standingIn(db, personId, workspaceId, folderIds);
  if (!standing) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  const ids = [...new Set(folderIds)];
  if (!ids.every((id) => allows(folderLevel(standing.sight, id), "view"))) throw new OpError("not_found", "No such folder");
  return JSON.stringify(ids);
}

/** What an agent row is made with besides what its member asked for: the start of its token, the hash of it, and the app it was connected from. */
export interface AgentToken {
  tokenPrefix: string;
  tokenHash: string;
  clientId?: string;
}

/**
 * Checks what a member asks of a new agent, as connecting one does, and gives the statement that
 * makes it. Nothing is written until the statement is run. Consenting to an OAuth app makes its
 * agent here too, so it can't be given more than the Agents page could give.
 */
export async function prepareAgent(db: D1Database, personId: string, rawName: string, input: ConnectOptions, how: AgentToken, now: number): Promise<{ id: string; insert: D1PreparedStatement }> {
  const parsed = ConnectOptions.safeParse(input);
  if (!parsed.success) throw new OpError("invalid", z.prettifyError(parsed.error));
  const options = parsed.data;
  const name = rawName.trim();
  if (!name || name.length > MAX_AGENT_NAME) throw new OpError("invalid", `Give the agent a name of 1 to ${MAX_AGENT_NAME} characters`);
  await roomForOneMore(db, personId, now, how.clientId);
  if (options.workspaceId) await ownWorkspace(db, personId, options.workspaceId);
  const folders = options.folderIds ? await folderLimit(db, personId, options.workspaceId, options.folderIds) : null;
  const id = newId();
  const insert = db
    .prepare("INSERT INTO agents (id, person_id, name, token_prefix, token_hash, created_at, expires_at, workspace_id, read_only, folder_ids, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, personId, name, how.tokenPrefix, how.tokenHash, now, endOf(options.expiresInDays, now), options.workspaceId ?? null, options.readOnly ? 1 : 0, folders, how.clientId ?? null);
  return { id, insert };
}

/** Connects an agent for `personId`. The returned token is the only time it can be seen. */
export async function connectAgent(db: D1Database, personId: string, rawName: string, input: ConnectOptions = {}, now = Date.now()): Promise<{ agent: Agent; token: string }> {
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const { id, insert } = await prepareAgent(db, personId, rawName, input, { tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 4), tokenHash: await hashToken(token) }, now);
  await insert.run();
  const row = await db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`).bind(id).first<AgentRow>();
  return { agent: toAgent(row!), token };
}

export async function listAgents(db: D1Database, personId: string): Promise<Agent[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM agents WHERE person_id = ? ORDER BY created_at DESC`)
    .bind(personId)
    .all<AgentRow>();
  return results.map(toAgent);
}

/**
 * Changes what one of `personId`'s agents may do, and returns it. Only the member who connected an
 * agent can: it acts as them. The token stays the one the agent already has, and the next call it
 * makes is held to the edit.
 */
export async function editAgent(db: D1Database, personId: string, agentId: string, input: AgentEdit, now = Date.now()): Promise<Agent> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ? AND person_id = ?`).bind(agentId, personId).first<AgentRow>();
  if (!row) throw new OpError("not_found", "No such agent");
  if (row.revoked_at !== null) throw new OpError("invalid", `${row.name} is disconnected, and stays that way. Connect a new agent instead`);
  const parsed = AgentEdit.safeParse(input);
  if (!parsed.success) throw new OpError("invalid", z.prettifyError(parsed.error));
  const edit = parsed.data;
  if (edit.workspaceId) await ownWorkspace(db, personId, edit.workspaceId);
  const workspaceId = edit.workspaceId !== undefined ? edit.workspaceId : row.workspace_id;
  // A limit names folders of one workspace, so it doesn't go with the token to another, where it would hide everything.
  if (edit.folderIds === undefined && row.folder_ids !== null && workspaceId !== row.workspace_id) {
    throw new OpError("invalid", `${row.name} is limited to folders of the workspace it reaches now. Say which folders it is limited to where it is going, as folderIds, or null for all notes`);
  }
  const folders = edit.folderIds ? await folderLimit(db, personId, workspaceId, edit.folderIds) : null;
  // Only what the edit names is written, so an edit made beside another doesn't put back what that one changed.
  const given: Partial<Pick<AgentRow, "expires_at" | "workspace_id" | "read_only" | "folder_ids">> = {
    ...(edit.expiresInDays !== undefined && { expires_at: endOf(edit.expiresInDays, now) }),
    ...(edit.workspaceId !== undefined && { workspace_id: edit.workspaceId }),
    ...(edit.readOnly !== undefined && { read_only: Number(edit.readOnly) }),
    ...(edit.folderIds !== undefined && { folder_ids: folders }),
  };
  const columns = Object.keys(given) as (keyof typeof given)[];
  if (!columns.length) return toAgent(row);
  const live = (r: Pick<AgentRow, "expires_at">) => r.expires_at === null || r.expires_at > now;
  if (!live(row) && live({ ...row, ...given })) await roomForOneMore(db, personId, now);
  // Folders are checked against the workspace read above, so an edit of either holds only if neither changed meanwhile.
  const together = "workspace_id" in given || "folder_ids" in given;
  const written = await db
    .prepare(`UPDATE agents SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?${together ? " AND workspace_id IS ? AND folder_ids IS ?" : ""}`)
    .bind(...columns.map((c) => given[c]), agentId, ...(together ? [row.workspace_id, row.folder_ids] : []))
    .run();
  if (!written.meta.changes) throw new OpError("conflict", `${row.name} was changed somewhere else just now. Look at it again, then make this change`);
  return toAgent((await db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`).bind(agentId).first<AgentRow>())!);
}

/** Disconnects one of `personId`'s agents. Its token stops working at once. Disconnecting twice is fine. */
export async function disconnectAgent(db: D1Database, personId: string, agentId: string, now = Date.now()): Promise<void> {
  const row = await db.prepare("SELECT 1 FROM agents WHERE id = ? AND person_id = ?").bind(agentId, personId).first();
  if (!row) throw new OpError("not_found", "No such agent");
  await db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, agentId).run();
}

type ActiveRow = { id: string; person_id: string; name: string; last_used_at: number | null; workspace_id: string | null; read_only: number; folder_ids: string | null };
const connected = (row: ActiveRow): ConnectedAgent => ({ agentId: row.id, personId: row.person_id, name: row.name, workspaceId: row.workspace_id, readOnly: row.read_only === 1, folderIds: foldersOf(row) });

/** An agent by its id, as its token would name it now: null once it is expired or disconnected. */
export async function agentById(db: D1Database, id: string, now = Date.now()): Promise<ConnectedAgent | null> {
  const row = await db.prepare(`SELECT id, person_id, name, last_used_at, workspace_id, read_only, folder_ids FROM agents WHERE id = ? AND ${ACTIVE}`).bind(id, now).first<ActiveRow>();
  return row ? connected(row) : null;
}

/**
 * The agent an OAuth access token belongs to. The token is good only while its agent is: the agent's
 * own end and its disconnecting are read in the same query, so neither leaves a token working.
 */
async function agentOfAccessToken(db: D1Database, token: string, now: number): Promise<ActiveRow | null> {
  return db
    .prepare(
      `SELECT a.id, a.person_id, a.name, a.last_used_at, a.workspace_id, a.read_only, a.folder_ids
       FROM oauth_tokens t JOIN agents a ON a.id = t.agent_id
       WHERE t.hash = ? AND t.kind = 'access' AND t.expires_at > ? AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?)`,
    )
    .bind(await hashToken(token), now, now)
    .first<ActiveRow>();
}

/**
 * The agent a token belongs to, or null if it is unknown, malformed, expired, or disconnected. The
 * token is one the agent was connected with, or an OAuth access token: a refresh token or a code is
 * neither. (An agent's token may start with `cink_at_` by chance, so it is looked for as one too.)
 */
export async function authenticateAgent(db: D1Database, token: string, now = Date.now()): Promise<ConnectedAgent | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row =
    (token.startsWith(ACCESS_PREFIX) ? await agentOfAccessToken(db, token, now) : null) ??
    (await db
      .prepare(`SELECT id, person_id, name, last_used_at, workspace_id, read_only, folder_ids FROM agents WHERE token_hash = ? AND ${ACTIVE}`)
      .bind(await hashToken(token), now)
      .first<ActiveRow>());
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_EVERY) {
    await db.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return connected(row);
}
