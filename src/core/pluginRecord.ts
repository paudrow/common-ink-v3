import { hashToken } from "./agents.ts";
import { newId } from "./ids.ts";
import type { Context } from "./operations.ts";
import {
  BUILT_IN_SUBJECTS,
  HTML_EMBEDS,
  Manifest,
  approvalOf,
  codeHash,
  opsAllowedBy,
  readManifest,
  readOrigin,
  type Capability,
  type DeclaredCapability,
  type InstalledPlugin,
  type Permission,
  type PluginRecord,
} from "./plugins.ts";
import { OpError, type Op, type OpType, type Results } from "./protocol.ts";

/*
 * A workspace's record of its plugins: what is installed, what each is permitted, and who is
 * waiting on an admin. Who may read and change it is said here and in the operations' own rows,
 * and nowhere in the app.
 */

/** As many plugins as a workspace holds at once. */
export const MAX_PLUGINS = 50;
/** How long a frame's token is good for. */
export const FRAME_SECONDS = 60;

const NO_SUCH_PLUGIN = "No such plugin";

interface InstallRow {
  id: string;
  manifest: string;
  code_hash: string;
  installed_by_name: string | null;
  installed_at: number;
  updated_at: number;
}

interface PermissionRow {
  subject: string;
  capability: Capability;
  state: "allowed" | "off";
  locked: number;
  approved: string | null;
  origins: string | null;
  decided_by_name: string | null;
}

interface RequestRow {
  subject: string;
  capability: Capability;
  requested_by: string;
  name: string;
  at: number;
  origins: string | null;
}

/** Sites as they were stored, each read again as a site: nothing else is ever handed on. */
const originsIn = (json: string | null): string[] => (json ? (JSON.parse(json) as unknown[]).flatMap((site) => (typeof site === "string" && readOrigin(site) !== null ? [site] : [])) : []);

/** A plugin in this workspace that hasn't been uninstalled. */
const INSTALLED = "workspace_id = ? AND removed_at IS NULL";

/** Whether a decision still stands: it allowed, and what it allowed is what the plugin still is. HTML embeds are nothing but what the admin listed, so theirs always does. */
const stands = (row: PermissionRow | undefined, approval: string | null) => row?.state === "allowed" && (approval === null || row.approved === approval);

/**
 * One permission as members are told of it. `approval` is what an allowance has to have been of to
 * stand, or null for HTML embeds.
 */
function toPermission(capability: Capability, reason: string, origins: string[], approval: string | null, row: PermissionRow | undefined, requests: RequestRow[]): Permission {
  const allowed = stands(row, approval);
  const voided = row?.state === "allowed" && !allowed;
  return {
    capability,
    reason,
    origins,
    state: allowed ? "allowed" : "off",
    locked: row?.locked === 1,
    decidedBy: voided ? null : (row?.decided_by_name ?? null),
    voided,
    requests: requests.map((r) => ({ by: { id: r.requested_by, name: r.name }, at: r.at, origins: originsIn(r.origins) })),
  };
}

const HTML = BUILT_IN_SUBJECTS[HTML_EMBEDS];
// Its name is one of Common Ink's own, which no manifest that is read may have, so it is set after.
const HTML_MANIFEST: Manifest = { ...Manifest.parse({ name: "Embeds of HTML" }), name: HTML.name };

/** The record, as anyone in the workspace is told of it. */
export async function listPlugins(ctx: Context): Promise<PluginRecord> {
  const [installs, permissions, requests] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db
      .prepare(`SELECT i.id, i.manifest, i.code_hash, p.name AS installed_by_name, i.installed_at, i.updated_at FROM plugin_installs i LEFT JOIN people p ON p.id = i.installed_by WHERE i.${INSTALLED} ORDER BY i.installed_at, i.id`)
      .bind(ctx.workspaceId),
    ctx.db
      .prepare("SELECT s.subject, s.capability, s.state, s.locked, s.approved, s.origins, p.name AS decided_by_name FROM plugin_permissions s LEFT JOIN people p ON p.id = s.decided_by WHERE s.workspace_id = ?")
      .bind(ctx.workspaceId),
    // Someone who has left the workspace since is waiting on nothing.
    ctx.db
      .prepare(
        `SELECT r.subject, r.capability, r.requested_by, p.name, r.at, r.origins FROM plugin_requests r
         JOIN members m ON m.workspace_id = r.workspace_id AND m.person_id = r.requested_by JOIN people p ON p.id = r.requested_by
         WHERE r.workspace_id = ? ORDER BY r.at, r.requested_by`,
      )
      .bind(ctx.workspaceId),
  ]);
  const key = (subject: string, capability: string) => `${subject} ${capability}`;
  const decided = new Map((permissions!.results as unknown as PermissionRow[]).map((row) => [key(row.subject, row.capability), row]));
  const asked = Map.groupBy(requests!.results as unknown as RequestRow[], (row) => key(row.subject, row.capability));
  const html = decided.get(key(HTML_EMBEDS, HTML.capability));
  return {
    canManage: ctx.author.kind === "member" && ctx.role === "admin",
    plugins: [
      ...(installs!.results as unknown as InstallRow[]).map((row): InstalledPlugin => {
        const manifest = JSON.parse(row.manifest) as Manifest;
        return {
          id: row.id,
          thirdParty: true,
          manifest,
          codeHash: row.code_hash,
          installedBy: row.installed_by_name,
          installedAt: row.installed_at,
          updatedAt: row.updated_at,
          permissions: manifest.capabilities.map((c) => toPermission(c.name, c.reason, c.origins ?? [], approvalOf(c, row.code_hash), decided.get(key(row.id, c.name)), asked.get(key(row.id, c.name)) ?? [])),
        };
      }),
      {
        id: HTML_EMBEDS,
        thirdParty: false,
        manifest: HTML_MANIFEST,
        codeHash: null,
        installedBy: null,
        installedAt: null,
        updatedAt: null,
        permissions: [toPermission(HTML.capability, HTML.reason, originsIn(html?.origins ?? null), null, html, asked.get(key(HTML_EMBEDS, HTML.capability)) ?? [])],
      },
    ],
  };
}

interface Installed {
  manifest: Manifest;
  codeHash: string;
}

async function installed(db: D1Database, workspaceId: string, id: string): Promise<Installed | null> {
  const row = await db.prepare(`SELECT manifest, code_hash FROM plugin_installs WHERE id = ? AND ${INSTALLED}`).bind(id, workspaceId).first<{ manifest: string; code_hash: string }>();
  return row && { manifest: JSON.parse(row.manifest) as Manifest, codeHash: row.code_hash };
}

/**
 * What a plugin acting in a workspace is called and may perform there, or null when it isn't
 * installed in that workspace: never installed, uninstalled, or another workspace's.
 */
export async function actingPlugin(db: D1Database, workspaceId: string, pluginId: string): Promise<{ name: string; allowed: ReadonlySet<OpType> } | null> {
  const plugin = await installed(db, workspaceId, pluginId);
  if (!plugin) return null;
  const { results } = await db.prepare("SELECT subject, capability, state, locked, approved, origins, NULL AS decided_by_name FROM plugin_permissions WHERE workspace_id = ? AND subject = ?").bind(workspaceId, pluginId).all<PermissionRow>();
  const effective = plugin.manifest.capabilities.filter((c) => stands(results.find((row) => row.capability === c.name), approvalOf(c, plugin.codeHash))).map((c) => c.name);
  return { name: plugin.manifest.name, allowed: opsAllowedBy(effective) };
}

export async function readPlugin(ctx: Context, id: string): Promise<Results["plugin.read"]> {
  const row = await ctx.db.prepare(`SELECT code, code_hash FROM plugin_installs WHERE id = ? AND ${INSTALLED}`).bind(id, ctx.workspaceId).first<{ code: string; code_hash: string }>();
  if (!row) throw new OpError("not_found", NO_SUCH_PLUGIN);
  return { id, code: row.code, codeHash: row.code_hash };
}

export async function installPlugin(ctx: Context, op: Extract<Op, { type: "plugin.install" }>): Promise<Results["plugin.install"]> {
  const read = readManifest(op.manifest);
  if ("reason" in read) throw new OpError("invalid", read.reason);
  const manifest = JSON.stringify(read.manifest);
  const hash = await codeHash(op.code);
  const id = op.replaces ?? newId();
  if (op.replaces) {
    // What was permitted is left as it is: each allowance says what it was of, and stands or not by that.
    const { meta } = await ctx.db.prepare(`UPDATE plugin_installs SET manifest = ?3, code = ?4, code_hash = ?5, updated_at = ?6 WHERE id = ?1 AND workspace_id = ?2 AND removed_at IS NULL`).bind(id, ctx.workspaceId, manifest, op.code, hash, ctx.now).run();
    if (!meta.changes) throw new OpError("not_found", NO_SUCH_PLUGIN);
  } else {
    // One statement, so two installs at once can't both take the last place.
    const { meta } = await ctx.db
      .prepare(
        `INSERT INTO plugin_installs (id, workspace_id, manifest, code, code_hash, installed_by, installed_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7 WHERE (SELECT COUNT(*) FROM plugin_installs WHERE workspace_id = ?2 AND removed_at IS NULL) < ?8`,
      )
      .bind(id, ctx.workspaceId, manifest, op.code, hash, ctx.personId, ctx.now, MAX_PLUGINS)
      .run();
    if (!meta.changes) throw new OpError("invalid", `A workspace holds at most ${MAX_PLUGINS} plugins. Uninstall one first.`);
  }
  return { ...(await listPlugins(ctx)), id };
}

/** Done twice, it changes nothing more. */
export async function uninstallPlugin(ctx: Context, id: string): Promise<PluginRecord> {
  const [removed] = await ctx.db.batch([
    ctx.db.prepare("UPDATE plugin_installs SET removed_at = COALESCE(removed_at, ?3), code = '' WHERE id = ?1 AND workspace_id = ?2").bind(id, ctx.workspaceId, ctx.now),
    ctx.db.prepare("DELETE FROM plugin_permissions WHERE subject = ?1 AND workspace_id = ?2 AND EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?1 AND workspace_id = ?2)").bind(id, ctx.workspaceId),
    ctx.db.prepare("DELETE FROM plugin_requests WHERE subject = ?1 AND workspace_id = ?2 AND EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?1 AND workspace_id = ?2)").bind(id, ctx.workspaceId),
  ]);
  if (!removed!.meta.changes) throw new OpError("not_found", NO_SUCH_PLUGIN);
  return listPlugins(ctx);
}

/** What a decision or a request is about, once it is known to be something the subject has. */
interface Subject {
  /** What an allowance of it is of. Null for HTML embeds. */
  approval: string | null;
  /** The sites that go with it, for HTML embeds: the ones given now. */
  origins: string[] | null;
  row: PermissionRow | undefined;
}

/**
 * The permission an operation names, or a refusal: a plugin that isn't installed, a capability it
 * doesn't declare, and sites given where they aren't the asker's to give or left out where they are.
 */
async function subjectOf(ctx: Context, op: { id: string; capability: Capability; origins?: string[] }, sitesNeeded: boolean): Promise<Subject> {
  let approval: string | null = null;
  if (op.id === HTML_EMBEDS) {
    if (op.capability !== HTML.capability) throw new OpError("invalid", `${HTML.name} have one permission: ${HTML.capability}`);
    if (sitesNeeded && !op.origins) throw new OpError("invalid", `List the sites ${HTML.name} may reach, as origins`);
  } else {
    const plugin = await installed(ctx.db, ctx.workspaceId, op.id);
    if (!plugin) throw new OpError("not_found", NO_SUCH_PLUGIN);
    const declared: DeclaredCapability | undefined = plugin.manifest.capabilities.find((c) => c.name === op.capability);
    if (!declared) throw new OpError("invalid", `${plugin.manifest.name} doesn't ask for ${op.capability}`);
    if (op.origins) throw new OpError("invalid", "A plugin's sites are the ones its manifest lists. Only HTML embeds are given origins.");
    approval = approvalOf(declared, plugin.codeHash);
  }
  const row = await ctx.db
    .prepare("SELECT subject, capability, state, locked, approved, origins, NULL AS decided_by_name FROM plugin_permissions WHERE workspace_id = ? AND subject = ? AND capability = ?")
    .bind(ctx.workspaceId, op.id, op.capability)
    .first<PermissionRow>();
  return { approval, origins: op.id === HTML_EMBEDS ? (op.origins ?? null) : null, row: row ?? undefined };
}

export const NAME_THE_CODE = "Say which code you are allowing: codeHash, as plugin.list answers it for the plugin";
export const CHANGED_SINCE = "This plugin has been replaced since you read it. Look at it again before deciding.";

/** An admin's decision. `needs: "manage"` on its operation is what keeps everyone else from it. */
export async function permitPlugin(ctx: Context, op: Extract<Op, { type: "plugin.permit" }>): Promise<PluginRecord> {
  const { approval, origins, row } = await subjectOf(ctx, op, op.allowed);
  const sites = origins ? JSON.stringify(origins) : (row?.origins ?? null);
  const changed = stands(row, approval) !== op.allowed || sites !== (row?.origins ?? null);
  if (row?.locked === 1 && op.locked !== false && changed) throw new OpError("conflict", "This permission is locked. Unlock it first.");
  if (op.id !== HTML_EMBEDS && (op.allowed || op.codeHash)) {
    // An approval names the code it is of. One that doesn't is of nothing.
    if (!op.codeHash) throw new OpError("invalid", NAME_THE_CODE);
    if ((await installed(ctx.db, ctx.workspaceId, op.id))?.codeHash !== op.codeHash) throw new OpError("conflict", CHANGED_SINCE);
  }
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO plugin_permissions (workspace_id, subject, capability, state, locked, approved, origins, decided_by, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (workspace_id, subject, capability) DO UPDATE SET state = excluded.state, locked = excluded.locked, approved = excluded.approved, origins = excluded.origins, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
      )
      .bind(ctx.workspaceId, op.id, op.capability, op.allowed ? "allowed" : "off", (op.locked ?? row?.locked === 1) ? 1 : 0, op.allowed ? approval : null, sites, ctx.personId, ctx.now),
    ctx.db.prepare("DELETE FROM plugin_requests WHERE workspace_id = ? AND subject = ? AND capability = ?").bind(ctx.workspaceId, op.id, op.capability),
  ]);
  return listPlugins(ctx);
}

/** A member who isn't an admin saying yes. It allows nothing. */
export async function requestPlugin(ctx: Context, op: Extract<Op, { type: "plugin.request" }>): Promise<PluginRecord> {
  if (ctx.role === "admin") throw new OpError("invalid", "An admin decides it: plugin.permit");
  const { approval, origins, row } = await subjectOf(ctx, op, true);
  if (row?.locked === 1) throw new OpError("conflict", "An admin locked this permission, so it takes no requests");
  if (!stands(row, approval)) {
    await ctx.db
      .prepare("INSERT INTO plugin_requests (workspace_id, subject, capability, requested_by, at, origins) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(ctx.workspaceId, op.id, op.capability, ctx.personId, ctx.now, origins ? JSON.stringify(origins) : null)
      .run();
  }
  return listPlugins(ctx);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A frame's token as it is written in an address: 32 bytes, base64url. */
export const FRAME_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What a frame of the subject's is opened with: a token for the address that lets its sites
 * through, when its network is allowed, and nothing when it isn't. Only the token's SHA-256 is kept.
 */
export async function framePlugin(ctx: Context, id: string): Promise<Results["plugin.frame"]> {
  let origins: string[];
  let approval: string | null = null;
  if (id === HTML_EMBEDS) origins = [];
  else {
    const plugin = await installed(ctx.db, ctx.workspaceId, id);
    if (!plugin) throw new OpError("not_found", NO_SUCH_PLUGIN);
    const declared = plugin.manifest.capabilities.find((c) => c.name === "network");
    if (!declared) return { token: null, origins: [] };
    origins = declared.origins ?? [];
    approval = approvalOf(declared, plugin.codeHash);
  }
  const row = await ctx.db
    .prepare("SELECT subject, capability, state, locked, approved, origins, NULL AS decided_by_name FROM plugin_permissions WHERE workspace_id = ? AND subject = ? AND capability = 'network'")
    .bind(ctx.workspaceId, id)
    .first<PermissionRow>();
  if (!stands(row ?? undefined, approval)) return { token: null, origins: [] };
  if (id === HTML_EMBEDS) origins = originsIn(row!.origins);
  origins = origins.filter((site) => readOrigin(site) !== null);
  if (!origins.length) return { token: null, origins: [] };
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM frame_grants WHERE expires_at <= ?").bind(ctx.now),
    ctx.db.prepare("INSERT INTO frame_grants (token_hash, workspace_id, origins, expires_at) VALUES (?, ?, ?, ?)").bind(await hashToken(token), ctx.workspaceId, JSON.stringify(origins), ctx.now + FRAME_SECONDS * 1000),
  ]);
  return { token, origins };
}

/**
 * The sites a frame's token lets through, the one time it is asked: one statement marks it used, so
 * of two askers one is answered. Null for a token that is unknown, used or past its minute.
 */
export async function redeemFrame(db: D1Database, token: string, now: number): Promise<string[] | null> {
  if (!FRAME_TOKEN.test(token)) return null;
  const row = await db.prepare("UPDATE frame_grants SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING origins").bind(await hashToken(token), now).first<{ origins: string }>();
  return row && originsIn(row.origins);
}
