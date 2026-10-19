import { hashToken } from "./agents.ts";
import { newId } from "./ids.ts";
import type { Context } from "./operations.ts";
import { ownSandboxed } from "./ownPlugins.ts";
import {
  BUILT_IN_SUBJECTS,
  FULL_TRUST,
  HTML_EMBEDS,
  MAX_PLUGIN_MANIFEST,
  Manifest,
  approvalOf,
  asksFullTrust,
  codeHash,
  opsAllowedBy,
  readManifest,
  readOrigin,
  type Capability,
  type DeclaredCapability,
  type Draft,
  type DraftSummary,
  type FullTrust,
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
  installed_via_name: string | null;
  installed_at: number;
  updated_by_name: string | null;
  updated_via_name: string | null;
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
  decided_via_name?: string | null;
}

interface TrustRow {
  plugin_id: string;
  person_id: string;
  code_hash: string;
  at: number;
  name: string;
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
    decidedVia: voided ? null : (row?.decided_via_name ?? null),
    voided,
    requests: requests.map((r) => ({ by: { id: r.requested_by, name: r.name }, at: r.at, origins: originsIn(r.origins) })),
  };
}

const HTML = BUILT_IN_SUBJECTS[HTML_EMBEDS];
// Its name is one of Common Ink's own, which no manifest that is read may have, so it is set after.
const HTML_MANIFEST: Manifest = { ...Manifest.parse({ name: "Embeds of HTML" }), name: HTML.name };

/** The record, as anyone in the workspace is told of it. */
export async function listPlugins(ctx: Context): Promise<PluginRecord> {
  const [installs, permissions, requests, trusting] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db
      .prepare(`SELECT i.id, i.manifest, i.code_hash, p.name AS installed_by_name, ia.name AS installed_via_name, i.installed_at, u.name AS updated_by_name, ua.name AS updated_via_name, i.updated_at
         FROM plugin_installs i LEFT JOIN people p ON p.id = i.installed_by LEFT JOIN agents ia ON ia.id = i.installed_via LEFT JOIN people u ON u.id = i.updated_by LEFT JOIN agents ua ON ua.id = i.updated_via
         WHERE i.${INSTALLED} ORDER BY i.installed_at, i.id`)
      .bind(ctx.workspaceId),
    ctx.db
      .prepare("SELECT s.subject, s.capability, s.state, s.locked, s.approved, s.origins, p.name AS decided_by_name, a.name AS decided_via_name FROM plugin_permissions s LEFT JOIN people p ON p.id = s.decided_by LEFT JOIN agents a ON a.id = s.decided_via WHERE s.workspace_id = ?")
      .bind(ctx.workspaceId),
    // Someone who has left the workspace since is waiting on nothing.
    ctx.db
      .prepare(
        `SELECT r.subject, r.capability, r.requested_by, p.name, r.at, r.origins FROM plugin_requests r
         JOIN members m ON m.workspace_id = r.workspace_id AND m.person_id = r.requested_by JOIN people p ON p.id = r.requested_by
         WHERE r.workspace_id = ? ORDER BY r.at, r.requested_by`,
      )
      .bind(ctx.workspaceId),
    // Who has each full-trust plugin on, among those still in the workspace. Told whole to an admin, and to anyone else only of themself.
    ctx.db
      .prepare(
        `SELECT t.plugin_id, t.person_id, t.code_hash, t.at, p.name FROM plugin_trust t
         JOIN members m ON m.workspace_id = t.workspace_id AND m.person_id = t.person_id JOIN people p ON p.id = t.person_id
         WHERE t.workspace_id = ? ORDER BY t.at, t.person_id`,
      )
      .bind(ctx.workspaceId),
  ]);
  // Whether full trust was asked for, whether it was granted and who has it on are told to members and to their agents, who act in their role. A plugin reads a record in which nothing asks for it.
  const member = ctx.author.kind !== "plugin";
  const canManage = member && ctx.role === "admin";
  const turnedOn = trusting!.results as unknown as TrustRow[];
  const fullTrust = (id: string, hash: string, permission: Permission | undefined): FullTrust | null => {
    if (!member || !permission) return null;
    const on = turnedOn.filter((row) => row.plugin_id === id && row.code_hash === hash);
    const granted = permission.state === "allowed";
    return { grantedHash: granted ? hash : null, changedSince: permission.voided, on: granted && on.some((row) => row.person_id === ctx.personId), turnedOnBy: canManage ? (granted ? on : []).map((row) => ({ name: row.name, at: row.at })) : null };
  };
  const key = (subject: string, capability: string) => `${subject} ${capability}`;
  const decided = new Map((permissions!.results as unknown as PermissionRow[]).map((row) => [key(row.subject, row.capability), row]));
  const asked = Map.groupBy(requests!.results as unknown as RequestRow[], (row) => key(row.subject, row.capability));
  const html = decided.get(key(HTML_EMBEDS, HTML.capability));
  return {
    canManage,
    plugins: [
      ...(installs!.results as unknown as InstallRow[]).map((row): InstalledPlugin => {
        const stored = JSON.parse(row.manifest) as Manifest;
        const manifest = member ? stored : { ...stored, capabilities: stored.capabilities.filter((c) => c.name !== FULL_TRUST) };
        const permissions = manifest.capabilities.map((c) => toPermission(c.name, c.reason, c.origins ?? [], approvalOf(c, row.code_hash), decided.get(key(row.id, c.name)), asked.get(key(row.id, c.name)) ?? []));
        return {
          id: row.id,
          thirdParty: true,
          manifest,
          codeHash: row.code_hash,
          fullTrust: fullTrust(
            row.id,
            row.code_hash,
            permissions.find((p) => p.capability === FULL_TRUST),
          ),
          installedBy: row.installed_by_name,
          installedVia: row.installed_via_name,
          installedAt: row.installed_at,
          updatedBy: row.updated_by_name,
          updatedVia: row.updated_via_name,
          updatedAt: row.updated_at,
          permissions,
        };
      }),
      {
        id: HTML_EMBEDS,
        thirdParty: false,
        manifest: HTML_MANIFEST,
        codeHash: null,
        fullTrust: null,
        installedBy: null,
        installedVia: null,
        installedAt: null,
        updatedBy: null,
        updatedVia: null,
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

/** What a plugin acting for a member may perform: the operations its permissions name, or for one running with full trust everything its member may that isn't the member's alone. */
export type Reach = ReadonlySet<OpType> | "all";

/** What a grant of full trust is of once the plugin it was given to has changed: nothing a plugin can be. */
const ENDED = "ended";

export const NOT_INSTALLED = "That plugin isn't installed in this workspace";
export const NO_DRAFT_RUNNING = "You have no draft of that plugin that is running";
export const DRAFT_ASKS_FULL_TRUST = "A draft that asks for full trust doesn't run. Full trust is granted by an admin to the exact code they read, so publish the draft and have that code granted.";
export const fullTrustOff = (name: string) => `${name} asks for full trust, so it runs only while an admin's grant of this exact code stands and you have turned it on for yourself`;

/**
 * What a plugin acting for `personId` in a workspace is called and may perform there, or why it
 * performs nothing: never installed, uninstalled, or another workspace's. `draft` is for that
 * person's own copy of the plugin, which is read by their id and so is never anyone else's: it may
 * perform what the original is allowed and its own manifest still asks for, and never more: a draft
 * that asks for full trust performs nothing. A plugin that asks for full trust performs nothing
 * until an admin's grant of the code it is now stands and this person turned it on for that code.
 */
export async function actingPlugin(db: D1Database, workspaceId: string, pluginId: string, personId: string, draft = false): Promise<{ name: string; allowed: Reach } | { refused: string }> {
  // One of Common Ink's own is allowed what its manifest declares, from the start: it comes with the app, so there is nobody to ask. No row in any workspace is read for it, or can change it.
  const own = ownSandboxed(pluginId);
  const plugin = own ? null : await installed(db, workspaceId, pluginId);
  const manifest = own ?? plugin?.manifest;
  if (!manifest) return { refused: NOT_INSTALLED };
  let standing: Capability[];
  if (own) standing = own.capabilities.map((c) => c.name);
  else {
    const { results } = await db.prepare("SELECT subject, capability, state, locked, approved, origins, NULL AS decided_by_name FROM plugin_permissions WHERE workspace_id = ? AND subject = ?").bind(workspaceId, pluginId).all<PermissionRow>();
    standing = manifest.capabilities.filter((c) => stands(results.find((row) => row.capability === c.name), approvalOf(c, plugin!.codeHash))).map((c) => c.name);
  }
  if (draft) {
    const mine = await db.prepare("SELECT manifest FROM plugin_drafts WHERE workspace_id = ? AND person_id = ? AND plugin_id = ? AND running = 1").bind(workspaceId, personId, pluginId).first<{ manifest: string }>();
    const read = mine && readManifest(mine.manifest, own !== null);
    if (!read || "reason" in read) return { refused: NO_DRAFT_RUNNING };
    // No admin read a draft's code, so the grant of the original's is no grant of it.
    if (asksFullTrust(read.manifest)) return { refused: DRAFT_ASKS_FULL_TRUST };
    const asks = new Set(read.manifest.capabilities.map((c) => c.name));
    return { name: read.manifest.name, allowed: opsAllowedBy(standing.filter((capability) => asks.has(capability))) };
  }
  if (!asksFullTrust(manifest)) return { name: manifest.name, allowed: opsAllowedBy(standing) };
  // Both, asked now: the grant that stands is of this code, and so is this person's own row. Whoever asks has been found to be a member before this is reached.
  const on = standing.includes(FULL_TRUST) && (await db.prepare("SELECT 1 FROM plugin_trust WHERE workspace_id = ? AND plugin_id = ? AND person_id = ? AND code_hash = ?").bind(workspaceId, pluginId, personId, plugin!.codeHash).first());
  return on ? { name: manifest.name, allowed: "all" } : { refused: fullTrustOff(manifest.name) };
}

/** The agent that is asking for its member, kept beside the member on what it changes: null when the member asks themself. */
const agentOf = (ctx: Context): string | null => (ctx.author.kind === "agent" ? ctx.author.agentId : null);

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
    const declared = read.manifest.capabilities.find((c) => c.name === FULL_TRUST);
    const approval = declared ? approvalOf(declared, hash) : null;
    const [, , updated] = await ctx.db.batch([
      // Full trust is of exactly one code, and ends for good when the plugin becomes anything else: the grant is marked as of nothing, so putting the old code back restores neither it nor anyone's turning it on.
      ctx.db.prepare(`UPDATE plugin_permissions SET approved = '${ENDED}' WHERE workspace_id = ?1 AND subject = ?2 AND capability = '${FULL_TRUST}' AND state = 'allowed' AND approved IS NOT ?3`).bind(ctx.workspaceId, id, approval),
      ctx.db
        .prepare(
          `DELETE FROM plugin_trust WHERE workspace_id = ?1 AND plugin_id = ?2 AND (?3 IS NULL OR code_hash <> ?4 OR NOT EXISTS (
             SELECT 1 FROM plugin_permissions WHERE workspace_id = ?1 AND subject = ?2 AND capability = '${FULL_TRUST}' AND state = 'allowed' AND approved = ?3))`,
        )
        .bind(ctx.workspaceId, id, approval, hash),
      // What else was permitted is left as it is: each allowance says what it was of, and stands or not by that.
      ctx.db
        .prepare(`UPDATE plugin_installs SET manifest = ?3, code = ?4, code_hash = ?5, updated_at = ?6, updated_by = ?7, updated_via = ?8 WHERE id = ?1 AND workspace_id = ?2 AND removed_at IS NULL`)
        .bind(id, ctx.workspaceId, manifest, op.code, hash, ctx.now, ctx.personId, agentOf(ctx)),
    ]);
    if (!updated!.meta.changes) throw new OpError("not_found", NO_SUCH_PLUGIN);
  } else {
    // One statement, so two installs at once can't both take the last place.
    const { meta } = await ctx.db
      .prepare(
        `INSERT INTO plugin_installs (id, workspace_id, manifest, code, code_hash, installed_by, installed_at, updated_at, installed_via)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?9 WHERE (SELECT COUNT(*) FROM plugin_installs WHERE workspace_id = ?2 AND removed_at IS NULL) < ?8`,
      )
      .bind(id, ctx.workspaceId, manifest, op.code, hash, ctx.personId, ctx.now, MAX_PLUGINS, agentOf(ctx))
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
    ctx.db.prepare("DELETE FROM plugin_trust WHERE plugin_id = ?1 AND workspace_id = ?2").bind(id, ctx.workspaceId),
    // A copy of a plugin that is gone has nothing to run in the place of, or to be published over.
    ctx.db.prepare("DELETE FROM plugin_drafts WHERE plugin_id = ?1 AND workspace_id = ?2").bind(id, ctx.workspaceId),
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
  const [decided] = await ctx.db.batch([
    // A plugin's is written only while the plugin is still there, and an allowance only while its code is still the code named: said in the statement, so a decision that crosses an update or an uninstall decides nothing.
    ctx.db
      .prepare(
        `INSERT INTO plugin_permissions (workspace_id, subject, capability, state, locked, approved, origins, decided_by, decided_at, decided_via)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11
         WHERE ?2 = '${HTML_EMBEDS}' OR EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?2 AND workspace_id = ?1 AND removed_at IS NULL AND (?4 = 'off' OR code_hash = ?10))
         ON CONFLICT (workspace_id, subject, capability) DO UPDATE SET state = excluded.state, locked = excluded.locked, approved = excluded.approved, origins = excluded.origins, decided_by = excluded.decided_by, decided_at = excluded.decided_at, decided_via = excluded.decided_via`,
      )
      .bind(ctx.workspaceId, op.id, op.capability, op.allowed ? "allowed" : "off", (op.locked ?? row?.locked === 1) ? 1 : 0, op.allowed ? approval : null, sites, ctx.personId, ctx.now, op.codeHash ?? null, agentOf(ctx)),
    ctx.db.prepare("DELETE FROM plugin_requests WHERE workspace_id = ? AND subject = ? AND capability = ?").bind(ctx.workspaceId, op.id, op.capability),
    // A decision on full trust, either way, starts it from nobody: taking it back turns everyone off, and granting it turns nobody on. Saying again what already stands, as locking it does, decides nothing.
    ...(op.capability === FULL_TRUST && (!op.allowed || !stands(row, approval)) ? [ctx.db.prepare("DELETE FROM plugin_trust WHERE workspace_id = ? AND plugin_id = ?").bind(ctx.workspaceId, op.id)] : []),
  ]);
  if (!decided!.meta.changes) throw new OpError("conflict", CHANGED_SINCE);
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
  // One that comes with the app is allowed what it declares. It is not a row in the workspace.
  const shipped = id === HTML_EMBEDS ? null : ownSandboxed(id);
  if (id === HTML_EMBEDS) origins = [];
  else if (shipped) {
    origins = shipped.capabilities.find((c) => c.name === "network")?.origins ?? [];
    if (!origins.length) return { token: null, origins: [] };
  } else {
    const plugin = await installed(ctx.db, ctx.workspaceId, id);
    if (!plugin) throw new OpError("not_found", NO_SUCH_PLUGIN);
    const declared = plugin.manifest.capabilities.find((c) => c.name === "network");
    if (!declared) return { token: null, origins: [] };
    origins = declared.origins ?? [];
    approval = approvalOf(declared, plugin.codeHash);
  }
  if (!shipped) {
    const row = await ctx.db
      .prepare("SELECT subject, capability, state, locked, approved, origins, NULL AS decided_by_name FROM plugin_permissions WHERE workspace_id = ? AND subject = ? AND capability = 'network'")
      .bind(ctx.workspaceId, id)
      .first<PermissionRow>();
    if (!stands(row ?? undefined, approval)) return { token: null, origins: [] };
    if (id === HTML_EMBEDS) origins = originsIn(row!.origins);
  }
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

export const NOT_GRANTED = "No admin's grant of full trust stands for this code, so it can't be turned on";

/**
 * A member turning a full-trust plugin on for themself, or off. Turning on is one statement, which
 * keeps a row only if, as it runs, the asker is a member, the plugin's code is the code they named
 * and an admin's grant of that code stands. So no row is ever of code nobody granted, whatever
 * changes beside it. Nothing here takes a person: the only one it can be for is whoever asks.
 */
export async function trustPlugin(ctx: Context, op: Extract<Op, { type: "plugin.trust" }>): Promise<PluginRecord> {
  const plugin = await installed(ctx.db, ctx.workspaceId, op.id);
  if (!plugin) throw new OpError("not_found", NO_SUCH_PLUGIN);
  const declared = plugin.manifest.capabilities.find((c) => c.name === FULL_TRUST);
  if (!declared) throw new OpError("invalid", `${plugin.manifest.name} doesn't ask for full trust. It runs shut off from the app, and is turned on in your settings.`);
  if (!op.on) await ctx.db.prepare("DELETE FROM plugin_trust WHERE workspace_id = ? AND plugin_id = ? AND person_id = ?").bind(ctx.workspaceId, op.id, ctx.personId).run();
  else {
    if (plugin.codeHash !== op.codeHash) throw new OpError("conflict", CHANGED_SINCE);
    const { meta } = await ctx.db
      .prepare(
        `INSERT INTO plugin_trust (workspace_id, plugin_id, person_id, code_hash, at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND person_id = ?3)
           AND EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?2 AND workspace_id = ?1 AND removed_at IS NULL AND code_hash = ?4)
           AND EXISTS (SELECT 1 FROM plugin_permissions WHERE workspace_id = ?1 AND subject = ?2 AND capability = '${FULL_TRUST}' AND state = 'allowed' AND approved = ?6)
         ON CONFLICT (workspace_id, plugin_id, person_id) DO UPDATE SET code_hash = excluded.code_hash, at = excluded.at`,
      )
      .bind(ctx.workspaceId, op.id, ctx.personId, op.codeHash, ctx.now, approvalOf(declared, plugin.codeHash))
      .run();
    if (!meta.changes) throw new OpError("conflict", NOT_GRANTED);
  }
  return listPlugins(ctx);
}

/** A person's turning on of full-trust plugins in a workspace they are no longer a member of, removed: said in the batch that takes them out, after the statement that does. Added again, they have turned nothing on. */
export const trustOfTheGone = (db: D1Database, workspaceId: string, personId: string): D1PreparedStatement =>
  db.prepare("DELETE FROM plugin_trust WHERE workspace_id = ?1 AND person_id = ?2 AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND person_id = ?2)").bind(workspaceId, personId);

interface DraftRow {
  plugin_id: string;
  manifest: string;
  code?: string;
  code_hash: string;
  base_hash: string | null;
  running: number;
  updated_at: number;
}

const toDraft = (row: DraftRow): DraftSummary => ({ pluginId: row.plugin_id, manifest: row.manifest, codeHash: row.code_hash, baseHash: row.base_hash, running: row.running === 1, updatedAt: row.updated_at });

/** Every statement about drafts names the asker, and no operation takes anyone else: a draft is its author's and nobody's besides. */
const MINE = "workspace_id = ? AND person_id = ?";

export async function listDrafts(ctx: Context): Promise<{ drafts: DraftSummary[] }> {
  const { results } = await ctx.db.prepare(`SELECT plugin_id, manifest, code_hash, base_hash, running, updated_at FROM plugin_drafts WHERE ${MINE} ORDER BY plugin_id`).bind(ctx.workspaceId, ctx.personId).all<DraftRow>();
  return { drafts: results.map(toDraft) };
}

const NO_DRAFT = "You have no draft of that plugin";

export async function readDraft(ctx: Context, id: string): Promise<Draft> {
  const row = await ctx.db.prepare(`SELECT plugin_id, manifest, code, code_hash, base_hash, running, updated_at FROM plugin_drafts WHERE ${MINE} AND plugin_id = ?`).bind(ctx.workspaceId, ctx.personId, id).first<DraftRow>();
  if (!row) throw new OpError("not_found", NO_DRAFT);
  return { ...toDraft(row), code: row.code! };
}

/**
 * Keeps the asker's copy of a plugin's source as it is now. What is kept may not be a manifest yet,
 * since it is being written. To run, it has to be one, and one that doesn't ask for full trust.
 */
export async function saveDraft(ctx: Context, op: Extract<Op, { type: "draft.save" }>): Promise<DraftSummary> {
  const own = ownSandboxed(op.id) !== null;
  if (!own && !(await installed(ctx.db, ctx.workspaceId, op.id))) throw new OpError("not_found", NO_SUCH_PLUGIN);
  if (op.manifest.length > MAX_PLUGIN_MANIFEST) throw new OpError("invalid", `A manifest is at most ${MAX_PLUGIN_MANIFEST} characters`);
  if (op.running) {
    const read = readManifest(op.manifest, own);
    if ("reason" in read) throw new OpError("invalid", read.reason);
    if (asksFullTrust(read.manifest)) throw new OpError("invalid", DRAFT_ASKS_FULL_TRUST);
  }
  const hash = await codeHash(op.code);
  // Kept only while its author is a member and the plugin is installed or is one of the app's own, said in the statement itself: a save that crosses their removal, or the plugin's, keeps nothing for either to leave behind.
  const { meta } = await ctx.db
    .prepare(
      `INSERT INTO plugin_drafts (workspace_id, person_id, plugin_id, manifest, code, code_hash, base_hash, running, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
       WHERE EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND person_id = ?2) AND (?10 = 1 OR EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?3 AND workspace_id = ?1 AND removed_at IS NULL))
       ON CONFLICT (workspace_id, person_id, plugin_id) DO UPDATE SET manifest = excluded.manifest, code = excluded.code, code_hash = excluded.code_hash, base_hash = excluded.base_hash, running = excluded.running, updated_at = excluded.updated_at`,
    )
    .bind(ctx.workspaceId, ctx.personId, op.id, op.manifest, op.code, hash, op.baseHash ?? null, op.running ? 1 : 0, ctx.now, own ? 1 : 0)
    .run();
  if (!meta.changes) throw new OpError("not_found", NO_SUCH_PLUGIN);
  return { pluginId: op.id, manifest: op.manifest, codeHash: hash, baseHash: op.baseHash ?? null, running: op.running, updatedAt: ctx.now };
}

/** Done twice, it changes nothing more. */
export async function discardDraft(ctx: Context, id: string): Promise<{ drafts: DraftSummary[] }> {
  await ctx.db.prepare(`DELETE FROM plugin_drafts WHERE ${MINE} AND plugin_id = ?`).bind(ctx.workspaceId, ctx.personId, id).run();
  return listDrafts(ctx);
}

/** A person's drafts in a workspace they are no longer a member of, removed: said in the batch that takes them out, after the statement that does. */
export const draftsOfTheGone = (db: D1Database, workspaceId: string, personId: string): D1PreparedStatement =>
  db.prepare("DELETE FROM plugin_drafts WHERE workspace_id = ?1 AND person_id = ?2 AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND person_id = ?2)").bind(workspaceId, personId);
