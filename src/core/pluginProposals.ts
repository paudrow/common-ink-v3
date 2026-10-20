// An admin's agent may ask to change the workspace's plugins, and an admin decides, in the app. A
// plugin runs in every member's app, so what it is and what it may do is a person's call, not a
// prompt's: an agent talked into installing one would put its code before everyone.
//
// Which operations wait is PROPOSED. Each is checked as it would be run, then kept as asked; approving
// runs it as the approving admin, if the agent is still connected and the plugin is as it was.

import { newId } from "./ids.ts";
import { HTML_EMBEDS, readManifest } from "./plugins.ts";
import { CHANGED_SINCE, NAME_THE_CODE, NO_SUCH_PLUGIN, installed, listPlugins } from "./pluginRecord.ts";
import { OpError, type Op, type OpType, type PluginProposal, type Results } from "./protocol.ts";
import type { Context } from "./operations.ts";

/** What an agent's request waits for an admin to approve. Taking an operation out of this set lets agents do it again. */
export const PROPOSED: ReadonlySet<OpType> = new Set(["plugin.install", "plugin.permit", "plugin.uninstall"]);

type Proposed = Extract<Op, { type: "plugin.install" | "plugin.permit" | "plugin.uninstall" }>;

/** How long a request waits for an answer. */
export const PROPOSAL_MS = 7 * 86_400_000;

interface Row {
  id: string;
  agent_id: string;
  agent_name: string;
  person_id: string;
  person_name: string;
  plugin_id: string;
  name: string;
  op: string;
  seen_hash: string | null;
  created_at: number;
  expires_at: number;
  state: "pending" | "approved" | "declined";
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: number | null;
}

const COLUMNS = `r.id, r.agent_id, a.name AS agent_name, r.person_id, p.name AS person_name, r.plugin_id, r.name, r.op, r.seen_hash, r.created_at, r.expires_at, r.state,
  r.decided_by, d.name AS decided_by_name, r.decided_at
  FROM plugin_proposals r JOIN agents a ON a.id = r.agent_id JOIN people p ON p.id = r.person_id LEFT JOIN people d ON d.id = r.decided_by`;

const kindOf = (op: Proposed): PluginProposal["kind"] => (op.type === "plugin.install" ? (op.replaces ? "update" : "install") : op.type === "plugin.permit" ? "permit" : "uninstall");

const WAITING = (who: string) => `Waiting for an admin to approve it in Common Ink, on the Plugins page. Nothing has changed yet. Tell ${who} it is waiting there.`;

function toProposal(row: Row, now: number): PluginProposal {
  const state = row.state === "pending" && row.expires_at <= now ? "expired" : row.state;
  return {
    id: row.id,
    kind: kindOf(JSON.parse(row.op) as Proposed),
    pluginId: row.plugin_id,
    name: row.name,
    request: JSON.parse(row.op) as Proposed,
    agent: { id: row.agent_id, name: row.agent_name },
    for: { id: row.person_id, name: row.person_name },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state,
    decidedBy: row.decided_by ? { id: row.decided_by, name: row.decided_by_name ?? "An admin" } : null,
    decidedAt: row.decided_at,
    message:
      state === "pending" ? WAITING(row.person_name) : state === "approved" ? `${row.decided_by_name ?? "An admin"} approved it, and it is done.` : state === "declined" ? `${row.decided_by_name ?? "An admin"} declined it, and nothing changed.` : "Nobody answered it in time, and nothing changed. Ask again if it is still wanted.",
  };
}

/**
 * Keeps an admin's agent's request, once it is one the admin could make now, and answers what the
 * operation would with `proposed` beside it. Nothing about the plugins changes.
 */
export async function propose(ctx: Context, op: Proposed): Promise<Results["plugin.install"]> {
  if (ctx.author.kind !== "agent") throw new Error("only an agent's request waits for an admin");
  let pluginId: string;
  let name: string;
  let seen: string | null = null;
  if (op.type === "plugin.install" && !op.replaces) {
    const read = readManifest(op.manifest);
    if ("reason" in read) throw new OpError("invalid", read.reason);
    pluginId = newId();
    name = read.manifest.name;
  } else {
    pluginId = op.type === "plugin.install" ? op.replaces! : op.id;
    const plugin = pluginId === HTML_EMBEDS ? null : await installed(ctx.db, ctx.workspaceId, pluginId);
    if (pluginId !== HTML_EMBEDS && !plugin) throw new OpError("not_found", NO_SUCH_PLUGIN);
    if (op.type === "plugin.install") {
      const read = readManifest(op.manifest);
      if ("reason" in read) throw new OpError("invalid", read.reason);
    }
    if (op.type === "plugin.permit" && plugin) {
      if (!plugin.manifest.capabilities.some((c) => c.name === op.capability)) throw new OpError("invalid", `${plugin.manifest.name} doesn't ask for ${op.capability}`);
      if (op.allowed && !op.codeHash) throw new OpError("invalid", NAME_THE_CODE);
      if (op.codeHash && op.codeHash !== plugin.codeHash) throw new OpError("conflict", CHANGED_SINCE);
    }
    name = plugin?.manifest.name ?? "Embeds of HTML";
    seen = plugin?.codeHash ?? null;
  }
  const id = newId();
  await ctx.db
    .prepare("INSERT INTO plugin_proposals (id, workspace_id, agent_id, person_id, plugin_id, name, op, seen_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ctx.workspaceId, ctx.author.agentId, ctx.personId, pluginId, name, JSON.stringify(op), seen, ctx.now, ctx.now + PROPOSAL_MS)
    .run();
  const row = await ctx.db.prepare(`SELECT ${COLUMNS} WHERE r.id = ?`).bind(id).first<Row>();
  return { ...(await listPlugins(ctx)), id: pluginId, proposed: toProposal(row!, ctx.now) };
}

/** An admin is told every request still waiting; an agent its own of the last 30 days; anyone else none. */
export async function listProposals(ctx: Context): Promise<Results["plugin.proposals"]> {
  if (ctx.author.kind === "agent") {
    const { results } = await ctx.db
      .prepare(`SELECT ${COLUMNS} WHERE r.workspace_id = ? AND r.agent_id = ? AND r.created_at > ? ORDER BY r.created_at DESC, r.id`)
      .bind(ctx.workspaceId, ctx.author.agentId, ctx.now - 30 * 86_400_000)
      .all<Row>();
    return { proposals: results.map((r) => toProposal(r, ctx.now)) };
  }
  if (ctx.role !== "admin") return { proposals: [] };
  const { results } = await ctx.db
    .prepare(`SELECT ${COLUMNS} WHERE r.workspace_id = ? AND r.state = 'pending' AND r.expires_at > ? ORDER BY r.created_at, r.id`)
    .bind(ctx.workspaceId, ctx.now)
    .all<Row>();
  return { proposals: results.map((r) => toProposal(r, ctx.now)) };
}

/**
 * An admin's answer. Approving runs the request with `run`, as that admin through the agent, and only while it is still
 * waiting, its agent is still connected and the plugin is as it was when asked. Answered once: a
 * second answer, or one after it lapsed, is refused.
 */
export async function decideProposal(ctx: Context, id: string, approve: boolean, run: (ctx: Context, op: Proposed, pluginId: string) => Promise<unknown>): Promise<Results["plugin.decide"]> {
  const row = await ctx.db.prepare(`SELECT ${COLUMNS} WHERE r.id = ? AND r.workspace_id = ?`).bind(id, ctx.workspaceId).first<Row>();
  if (!row) throw new OpError("not_found", "No such request");
  const now = toProposal(row, ctx.now);
  if (now.state !== "pending") throw new OpError("conflict", now.message);
  if (approve) {
    const agent = await ctx.db.prepare("SELECT 1 FROM agents WHERE id = ? AND revoked_at IS NULL").bind(row.agent_id).first();
    if (!agent) throw new OpError("conflict", `${row.agent_name} was disconnected since it asked. Decline it.`);
    if (row.seen_hash !== null && (await installed(ctx.db, ctx.workspaceId, row.plugin_id))?.codeHash !== row.seen_hash) throw new OpError("conflict", `${CHANGED_SINCE} Decline it, and the agent can ask again.`);
  }
  // Claimed first, so two admins answering at once do it once.
  const { meta } = await ctx.db
    .prepare("UPDATE plugin_proposals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending' AND expires_at > ?")
    .bind(approve ? "approved" : "declined", ctx.personId, ctx.now, id, ctx.now)
    .run();
  if (!meta.changes) throw new OpError("conflict", "Another admin answered it just now");
  if (approve) {
    try {
      // Done by the admin who approved it, and recorded as through the agent that asked, as the plugin's page tells it.
      const through: Context = { ...ctx, author: { kind: "agent", agentId: row.agent_id, name: row.agent_name, onBehalfOf: row.person_id } };
      await run(through, JSON.parse(row.op) as Proposed, row.plugin_id);
    } catch (err) {
      // What couldn't be done is put back to wait, so the admin can decline it or try again.
      await ctx.db.prepare("UPDATE plugin_proposals SET state = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?").bind(id).run();
      throw err;
    }
  }
  return listPlugins(ctx);
}
