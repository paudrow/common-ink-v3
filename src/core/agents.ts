import { z } from "zod";
import { newId } from "./ids.ts";
import { standingIn } from "./standing.ts";
import { NO_SUCH_WORKSPACE, AgentEdit, ConnectOptions, MAX_AGENT_NAME, OpError, type Agent, type ExpiresIn } from "./protocol.ts";

export const TOKEN_PREFIX = "cink_";
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
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
}

const COLUMNS = "id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at, workspace_id, read_only";

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
});

/** A token that never expires has no end, so it is always before it. */
const ACTIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
const endOf = (expiresIn: ExpiresIn, now: number) => (expiresIn === "never" ? null : now + expiresIn * DAY);

async function roomForOneMore(db: D1Database, personId: string, now: number) {
  const active = await db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE person_id = ? AND ${ACTIVE}`).bind(personId, now).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_AGENTS) throw new OpError("invalid", `You can have ${MAX_ACTIVE_AGENTS} agents connected; disconnect one first`);
}

async function ownWorkspace(db: D1Database, personId: string, workspaceId: string) {
  if (!(await standingIn(db, personId, workspaceId))) throw new OpError("not_found", NO_SUCH_WORKSPACE);
}

/** Connects an agent for `personId`. The returned token is the only time it can be seen. */
export async function connectAgent(db: D1Database, personId: string, rawName: string, input: ConnectOptions = {}, now = Date.now()): Promise<{ agent: Agent; token: string }> {
  const parsed = ConnectOptions.safeParse(input);
  if (!parsed.success) throw new OpError("invalid", z.prettifyError(parsed.error));
  const options = parsed.data;
  const name = rawName.trim();
  if (!name || name.length > MAX_AGENT_NAME) throw new OpError("invalid", `Give the agent a name of 1 to ${MAX_AGENT_NAME} characters`);
  await roomForOneMore(db, personId, now);
  if (options.workspaceId) await ownWorkspace(db, personId, options.workspaceId);
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = newId();
  const tokenPrefix = token.slice(0, TOKEN_PREFIX.length + 4);
  await db
    .prepare("INSERT INTO agents (id, person_id, name, token_prefix, token_hash, created_at, expires_at, workspace_id, read_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, personId, name, tokenPrefix, await hashToken(token), now, endOf(options.expiresInDays, now), options.workspaceId ?? null, options.readOnly ? 1 : 0)
    .run();
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
  // Only what the edit names is written, so an edit made beside another doesn't put back what that one changed.
  const given: Partial<Pick<AgentRow, "expires_at" | "workspace_id" | "read_only">> = {
    ...(edit.expiresInDays !== undefined && { expires_at: endOf(edit.expiresInDays, now) }),
    ...(edit.workspaceId !== undefined && { workspace_id: edit.workspaceId }),
    ...(edit.readOnly !== undefined && { read_only: Number(edit.readOnly) }),
  };
  const columns = Object.keys(given) as (keyof typeof given)[];
  if (!columns.length) return toAgent(row);
  const live = (r: Pick<AgentRow, "expires_at">) => r.expires_at === null || r.expires_at > now;
  if (!live(row) && live({ ...row, ...given })) await roomForOneMore(db, personId, now);
  await db
    .prepare(`UPDATE agents SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...columns.map((c) => given[c]), agentId)
    .run();
  return toAgent((await db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`).bind(agentId).first<AgentRow>())!);
}

/** Disconnects one of `personId`'s agents. Its token stops working at once. Disconnecting twice is fine. */
export async function disconnectAgent(db: D1Database, personId: string, agentId: string, now = Date.now()): Promise<void> {
  const row = await db.prepare("SELECT 1 FROM agents WHERE id = ? AND person_id = ?").bind(agentId, personId).first();
  if (!row) throw new OpError("not_found", "No such agent");
  await db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, agentId).run();
}

/** The agent a token belongs to, or null if it is unknown, malformed, expired, or disconnected. */
export async function authenticateAgent(db: D1Database, token: string, now = Date.now()): Promise<ConnectedAgent | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await db
    .prepare(`SELECT id, person_id, name, last_used_at, workspace_id, read_only FROM agents WHERE token_hash = ? AND ${ACTIVE}`)
    .bind(await hashToken(token), now)
    .first<{ id: string; person_id: string; name: string; last_used_at: number | null; workspace_id: string | null; read_only: number }>();
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_EVERY) {
    await db.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return { agentId: row.id, personId: row.person_id, name: row.name, workspaceId: row.workspace_id, readOnly: row.read_only === 1 };
}
