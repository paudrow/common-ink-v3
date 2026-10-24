import { newId } from "./ids.ts";
import { logLine } from "./logs.ts";
import { NO_SUCH_WORKSPACE, OpError, type AccountDeletion, type Role, type WorkspaceRef } from "./protocol.ts";
import { removalOf } from "./membership.ts";
import { finishRemoving, forgetRemoved, removalsOf } from "./purge.ts";
import type { Sources } from "./sources.ts";

/*
 * Deleting an account, and deleting a workspace. Each column that can hold a person's id, or a
 * workspace's, is named below with what deleting one does to it, and the statements that delete one
 * are made from that list and nothing else. test/core/erase.test.ts reads the schema and fails for a
 * column that is in neither list, so a new table can't keep someone's id after they are gone.
 */

/**
 * What deleting someone's account does to a column that holds their id (or, `byEmail`, their email).
 * `delete`: the rows go. `former`: it is set to the former member who stands in for them, so what
 * they did in a workspace they shared is still said to be someone's. `note` and `upload`: the item
 * goes, with everything kept by its id, and an upload's bytes. `agent`: the agent stays as the former
 * member's, so history can still name it, and is cut off: its tokens go.
 */
export type AccountFate = "delete" | "former" | "note" | "upload" | "agent" | { kept: string };

export interface PersonColumn {
  at: `${string}.${string}`;
  fate: AccountFate;
  byEmail?: true;
  /** What else holds of every row where the column is the person's, said so the statement finds them by an index (see migrations/0052_erasing.sql). */
  where?: string;
}

/** Of a column beside a `_kind`, which holds a person's id only where that says member, and an agent's or a plugin's otherwise. */
const MEMBER = (kind: string) => `${kind} = 'member'`;

/** Of an agent, which stays as the former member's agent: what history names it, and who it acted for. */
const AGENT_ID = "An agent's id. The agent stays, renamed A former member's agent and cut off, so history still says which agent did it.";
const WRITTEN = "Text someone wrote. A mention of a member is their id and name, and stays as written: it is the writer's, and reads as a name, as a mention of someone who was never a member does.";

/**
 * In order: the statements run as listed, so a row that must go before another is changed comes
 * first, and the person's own row is last. Nothing may still refer to it then, which the database
 * checks.
 */
export const PERSON_COLUMNS: readonly PersonColumn[] = [
  // Nobody else could see what was private to them, so it goes, bytes and all, and with it their daily notes, which are private.
  { at: "notes.private_owner", fate: "note" },
  // Marked as being removed, and pointed at the former member so the row can wait for its bytes to go.
  { at: "uploads.private_owner", fate: "upload" },
  { at: "agents.person_id", fate: "agent" },
  { at: "members.person_id", fate: "delete" },
  { at: "settings.person_id", fate: "delete" },
  { at: "daily_notes.person_id", fate: "delete" },
  { at: "pins.person_id", fate: "delete" },
  { at: "visits.person_id", fate: "delete" },
  { at: "grants.person_id", fate: "delete" },
  // A grant still waiting for their email to sign in. It was for them, and comes to nobody now. One they took up has their person_id, and went just before.
  { at: "grants.email", fate: "delete", byEmail: true, where: "kind = 'person' AND person_id IS NULL" },
  { at: "invites.invited_by", fate: "delete" },
  { at: "invites.email", fate: "delete", byEmail: true },
  { at: "plugin_drafts.person_id", fate: "delete" },
  { at: "plugin_trust.person_id", fate: "delete" },
  { at: "plugin_requests.requested_by", fate: "delete" },
  // What their agent asked to do to a plugin, waiting or answered: it was theirs to approve as well, and is nobody's now.
  { at: "plugin_proposals.person_id", fate: "delete" },
  { at: "source_connections.person_id", fate: "delete" },
  { at: "source_refs.person_id", fate: "delete" },
  { at: "sample_records.person_id", fate: "delete" },
  // Their mail, kept for them alone, and the addresses it knew them by. Ids before messages, messages before their threads.
  { at: "mail_ids.person_id", fate: "delete" },
  { at: "mail_messages.person_id", fate: "delete" },
  { at: "mail_threads.person_id", fate: "delete" },
  { at: "mail_senders.person_id", fate: "delete" },
  { at: "mail_rules.person_id", fate: "delete" },
  { at: "clipper_grants.person_id", fate: "delete" },
  { at: "oauth_requests.person_id", fate: "delete" },
  { at: "notes.created_by", fate: "former" },
  { at: "notes.updated_by", fate: "former", where: MEMBER("updated_by_kind") },
  { at: "notes.updated_by_owner", fate: "former" },
  { at: "notes.state_by", fate: "former", where: MEMBER("state_by_kind") },
  { at: "notes.released_from", fate: "former" },
  { at: "notes.released_by", fate: "former" },
  { at: "changes.author_id", fate: "former", where: MEMBER("author_kind") },
  { at: "changes.author_owner", fate: "former" },
  { at: "labels.author_id", fate: "former", where: MEMBER("author_kind") },
  { at: "completions.person_id", fate: "former" },
  { at: "completions.author_id", fate: "former", where: MEMBER("author_kind") },
  { at: "uploads.created_by", fate: "former" },
  { at: "uploads.uploaded_by", fate: "former", where: MEMBER("uploaded_by_kind") },
  { at: "uploads.state_by", fate: "former", where: MEMBER("state_by_kind") },
  { at: "uploads.released_from", fate: "former" },
  { at: "uploads.released_by", fate: "former" },
  // Grants and links they made stay, so nobody they shared something with loses it.
  { at: "grants.granted_by", fate: "former" },
  { at: "plugin_installs.installed_by", fate: "former" },
  { at: "plugin_installs.updated_by", fate: "former" },
  { at: "plugin_permissions.decided_by", fate: "former" },
  { at: "plugin_proposals.decided_by", fate: "former" },
  // What they said a tag is for stays the workspace's, said by the former member.
  { at: "tag_descriptions.updated_by", fate: "former" },
  { at: "plugin_installs.installed_via", fate: { kept: AGENT_ID } },
  { at: "plugin_installs.updated_via", fate: { kept: AGENT_ID } },
  { at: "plugin_permissions.decided_via", fate: { kept: AGENT_ID } },
  { at: "tag_descriptions.updated_via", fate: { kept: AGENT_ID } },
  { at: "mentions.who", fate: { kept: WRITTEN } },
  { at: "notes.text", fate: { kept: WRITTEN } },
  { at: "changes.diff", fate: { kept: WRITTEN } },
  { at: "todos.text", fate: { kept: WRITTEN } },
  { at: "note_search_content.c2", fate: { kept: `${WRITTEN} This is the search index's copy of it.` } },
  { at: "people.email", fate: "delete", byEmail: true },
  { at: "people.id", fate: "delete" },
];

/**
 * What deleting a workspace does to a column that holds its id. `cut`: the rows go at once, in the
 * batch that marks it, since they are what lets anyone in, what is only someone's own there, or what
 * is said of the workspace and kept by no note, and again with the workspace's row, for any written
 * after.
 * `agent`: an agent limited to the workspace goes then too, with its tokens. `notes` and `uploads`: they go a chunk at
 * a time, each note with everything kept by its id and each upload with its bytes. `last`: once
 * those are gone, in this order, the workspace's own row last.
 */
export type WorkspaceFate = "cut" | "agent" | "notes" | "uploads" | "last" | { kept: string };

export const WORKSPACE_COLUMNS: readonly { at: `${string}.${string}`; fate: WorkspaceFate }[] = [
  { at: "members.workspace_id", fate: "cut" },
  { at: "invites.workspace_id", fate: "cut" },
  { at: "grants.workspace_id", fate: "cut" },
  { at: "frame_grants.workspace_id", fate: "cut" },
  { at: "settings.workspace_id", fate: "cut" },
  { at: "pins.workspace_id", fate: "cut" },
  { at: "visits.workspace_id", fate: "cut" },
  { at: "plugin_drafts.workspace_id", fate: "cut" },
  { at: "plugin_trust.workspace_id", fate: "cut" },
  { at: "plugin_requests.workspace_id", fate: "cut" },
  { at: "plugin_proposals.workspace_id", fate: "cut" },
  { at: "tag_descriptions.workspace_id", fate: "cut" },
  { at: "agents_files.workspace_id", fate: "cut" },
  { at: "agents.workspace_id", fate: "agent" },
  // Made unreadable at once, as any upload being removed is, and their bytes go a chunk at a time.
  { at: "uploads.workspace_id", fate: "uploads" },
  { at: "notes.workspace_id", fate: "notes" },
  { at: "daily_notes.workspace_id", fate: "notes" },
  { at: "folders.workspace_id", fate: "last" },
  { at: "plugin_permissions.workspace_id", fate: "last" },
  { at: "plugin_installs.workspace_id", fate: "last" },
  { at: "workspaces.id", fate: "last" },
];

/**
 * What holds an id of something in a deleted workspace and stays when the workspace is gone, each
 * with why. test/core/erase.test.ts finds every other id it had nowhere.
 */
export const KEPT_OF_WORKSPACE: Record<string, string> = {
  "links.target_id": "What a note in another workspace links to. It is that note's, and a link to a note that is gone reads as one to a note that never was.",
  "upload_refs.upload_id": "Which upload a note in another workspace refers to. It is that note's, and reads as an upload that is gone.",
};

const split = (at: string) => at.split(".") as [string, string];

/** Binds as many of `args` as the statement names: ?1 to ?n. */
function bound(db: D1Database, sql: string, args: readonly unknown[]): D1PreparedStatement {
  const most = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return db.prepare(sql).bind(...args.slice(0, most));
}

/** The workspaces being deleted. */
const DELETING = "(SELECT id FROM workspaces WHERE deleting_at IS NOT NULL)";

/**
 * The statements that cut the workspaces `of`, those being deleted among them, off from everyone.
 * Each does nothing to a workspace that isn't being deleted, and nothing the second time, so they go
 * in any batch that marks a workspace, and again in the batch that deletes its row: a request that
 * found it still there just before it was marked can write a visit, a setting or a grant after.
 */
function cutting(of: string): string[] {
  const statements: string[] = [];
  for (const { at, fate } of WORKSPACE_COLUMNS) {
    const [table, column] = split(at);
    if (fate === "cut") statements.push(`DELETE FROM ${table} WHERE ${column} IN ${of}`);
    if (fate === "uploads") statements.push(`UPDATE ${table} SET state = 'removing' WHERE ${column} IN ${of} AND state <> 'removing'`);
    if (fate === "agent") {
      const agents = `(SELECT id FROM ${table} WHERE ${column} IN ${of})`;
      statements.push(`DELETE FROM oauth_tokens WHERE agent_id IN ${agents}`, `DELETE FROM oauth_codes WHERE agent_id IN ${agents}`, `DELETE FROM ${table} WHERE ${column} IN ${of}`);
    }
  }
  return statements;
}

/** In every statement ?1 is the workspace. Each does nothing unless it is being deleted. */
const MARKED = "EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND deleting_at IS NOT NULL)";
const THIS_ONE = "(SELECT id FROM workspaces WHERE id = ?1 AND deleting_at IS NOT NULL)";

/** As many notes as one chunk removes, at fifteen statements a note's worth. */
const CHUNK_NOTES = 20;
/** As many uploads as one chunk removes, which is as many as the bucket deletes at once. */
const CHUNK_UPLOADS = 1000;
/** As many chunks as one run does, in a request or on the timer. What is left waits for the next run. */
const CHUNKS = 25;

const NOTE_CHUNK = removalsOf(`(SELECT id FROM notes WHERE workspace_id = ?1 AND ${MARKED} ORDER BY id LIMIT ${CHUNK_NOTES})`);

const UPLOAD_CHUNK = `SELECT id FROM uploads WHERE workspace_id = ?1 AND ${MARKED} ORDER BY id LIMIT ?2`;
const UPLOADS_LATE = `UPDATE uploads SET state = 'removing' WHERE workspace_id = ?1 AND state <> 'removing' AND ${MARKED}`;

const LAST = [
  ...cutting(THIS_ONE),
  ...WORKSPACE_COLUMNS.filter((c) => c.fate === "last").map(({ at }) => {
    const [table, column] = split(at);
    return table === "workspaces" ? `DELETE FROM workspaces WHERE id = ?1 AND deleting_at IS NOT NULL` : `DELETE FROM ${table} WHERE ${column} = ?1 AND ${MARKED}`;
  }),
];

/**
 * One chunk of erasing a workspace being deleted: some of its notes, else some of its uploads, else
 * the rest of it. Answers whether there is more. Each chunk is one batch, or for uploads the steps
 * `finishRemoving` takes, each of which can be done again, so a run stopped anywhere is carried on by
 * the next. With no bucket its uploads wait for a run that has one.
 */
export async function eraseChunk(db: D1Database, bucket: R2Bucket | null, workspaceId: string): Promise<"more" | "done" | "waiting"> {
  const notes = await db.batch(NOTE_CHUNK.map((sql) => db.prepare(sql).bind(workspaceId)));
  if (notes.at(-1)!.meta.changes) return "more";
  const { results } = await db.prepare(UPLOAD_CHUNK).bind(workspaceId, CHUNK_UPLOADS).all<{ id: string }>();
  if (results.length) {
    if (!bucket) return "waiting";
    // Whatever was put there after it was marked is removed as the rest is.
    await db.prepare(UPLOADS_LATE).bind(workspaceId).run();
    await finishRemoving(db, bucket, results.map((r) => r.id));
    return "more";
  }
  await db.batch(LAST.map((sql) => db.prepare(sql).bind(workspaceId)));
  return "done";
}

export interface Erased {
  /** The workspaces erased to the last row. */
  erased: string[];
  /** Whether a workspace being deleted is left for the next run. */
  more: boolean;
}

/**
 * Erases the workspaces being deleted, `only` these if given, a chunk at a time, up to as many
 * chunks as one run does. Run twice, or again after stopping anywhere, it carries on with what is
 * left. A workspace whose chunk fails is left for the next run and doesn't keep the others waiting.
 */
export async function eraseWorkspaces(db: D1Database, bucket: R2Bucket | null, only: readonly string[] | null = null, log: (message: string) => void = logLine): Promise<Erased> {
  const { results } = await db
    .prepare("SELECT id FROM workspaces WHERE deleting_at IS NOT NULL AND (?1 IS NULL OR id IN (SELECT value FROM json_each(?1))) ORDER BY deleting_at, id")
    .bind(only && JSON.stringify(only))
    .all<{ id: string }>();
  const done: Erased = { erased: [], more: false };
  let chunks = 0;
  for (const { id } of results) {
    try {
      let at: "more" | "done" | "waiting" = "more";
      while (at === "more" && chunks++ < CHUNKS) {
        at = await eraseChunk(db, bucket, id);
      }
      if (at === "done") done.erased.push(id);
      else done.more = true;
    } catch (err) {
      done.more = true;
      log(`Couldn't erase workspace ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (results.length) await forgetRemoved(db).catch((err: unknown) => log(`Couldn't merge the search index after erasing workspaces: ${err instanceof Error ? err.message : String(err)}`));
  return done;
}

/** Who is deleting a workspace, and where. */
export interface Deleting {
  db: D1Database;
  workspaceId: string;
  personId: string;
  now: number;
  bucket: R2Bucket | null;
}

/**
 * Deletes a workspace, for an admin of it who typed its name: in one batch it is marked, and nobody
 * reaches it from then. Its members, invites, grants and links, and agents limited to it, go. What it
 * held is left for `eraseWorkspaces`.
 */
export async function cutOff({ db, workspaceId, personId, now }: Omit<Deleting, "bucket">, confirm: string): Promise<void> {
  const workspace = await db.prepare("SELECT name FROM workspaces WHERE id = ? AND deleting_at IS NULL").bind(workspaceId).first<{ name: string }>();
  if (!workspace) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  if (confirm.trim().toLowerCase() !== workspace.name.trim().toLowerCase()) throw new OpError("invalid", `Type the workspace's name, ${workspace.name}, to delete it`);
  const [marked] = await db.batch([
    db
      .prepare("UPDATE workspaces SET deleting_at = ?3 WHERE id = ?1 AND deleting_at IS NULL AND EXISTS (SELECT 1 FROM members a WHERE a.workspace_id = ?1 AND a.person_id = ?2 AND a.role = 'admin')")
      .bind(workspaceId, personId, now),
    ...cutting(DELETING).map((sql) => db.prepare(sql)),
  ]);
  if (!marked!.meta.changes) throw new OpError("forbidden", "Only an admin deletes a workspace");
}

/** Deletes a workspace, and erases as much of what it held as fits in this request. The hourly run carries on with the rest. */
export async function deleteWorkspace(deleting: Deleting, confirm: string): Promise<{ erased: boolean }> {
  await cutOff(deleting, confirm);
  await remember(deleting.bucket, [{ kind: "workspace", id: deleting.workspaceId, at: deleting.now }]);
  const { erased } = await eraseWorkspaces(deleting.db, deleting.bucket, [deleting.workspaceId]);
  return { erased: erased.includes(deleting.workspaceId) };
}

/** The workspaces where `?1` is the only admin and someone else is a member. Deleting their account would leave those with no admin. */
const ONLY_ADMIN = `SELECT w.id, w.name FROM workspaces w JOIN members m ON m.workspace_id = w.id AND m.person_id = ?1 AND m.role = 'admin'
  WHERE w.deleting_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM members a WHERE a.workspace_id = w.id AND a.role = 'admin' AND a.person_id <> ?1)
    AND EXISTS (SELECT 1 FROM members o WHERE o.workspace_id = w.id AND o.person_id <> ?1)`;
/** The workspaces where `?1` is the only member, which are deleted with their account. */
const ALONE_IN = `SELECT w.id, w.name FROM workspaces w JOIN members m ON m.workspace_id = w.id AND m.person_id = ?1
  WHERE w.deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM members o WHERE o.workspace_id = w.id AND o.person_id <> ?1)`;

/** What deleting `personId`'s account would do: the workspaces deleted with it, and those that keep it from being deleted. */
export async function accountDeletion(db: D1Database, personId: string): Promise<AccountDeletion> {
  const [person, alone, blocking] = await db.batch<{ email: string } & WorkspaceRef>([
    db.prepare("SELECT email FROM people WHERE id = ? AND former = 0").bind(personId),
    db.prepare(`${ALONE_IN} ORDER BY w.name COLLATE NOCASE, w.id`).bind(personId),
    db.prepare(`${ONLY_ADMIN} ORDER BY w.name COLLATE NOCASE, w.id`).bind(personId),
  ]);
  const email = person!.results[0]?.email;
  if (!email) throw new OpError("not_found", "No such person");
  const ref = ({ id, name }: WorkspaceRef) => ({ id, name });
  return { email, deletes: alone!.results.map(ref), blocking: blocking!.results.map(ref) };
}

const names = (workspaces: readonly WorkspaceRef[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(workspaces.map((w) => w.name));
export const onlyAdminOf = (workspaces: readonly WorkspaceRef[]) =>
  `You are the only admin of ${names(workspaces)}, where others are members. Make someone else an admin on Members, or delete the workspace, first.`;

/*
 * In every statement of an account's deletion ?1 is the person, ?2 the former member who stands in
 * for them, ?3 the time and ?4 their email. Each does nothing unless the former member was made in
 * the same batch, which the first statement does only while nothing keeps the account from going.
 */
const GO = "EXISTS (SELECT 1 FROM people WHERE id = ?2 AND former = 1)";
export const FORMER_NAME = "A former member";
export const FORMER_AGENT = "A former member's agent";

function erasingPerson(): string[] {
  const statements: string[] = [];
  for (const { at, fate, byEmail, where } of PERSON_COLUMNS) {
    const [table, column] = split(at);
    const is = `${column} = ${byEmail ? "?4" : "?1"}${where ? ` AND ${where}` : ""}`;
    if (fate === "delete") statements.push(`DELETE FROM ${table} WHERE ${is} AND ${GO}`);
    if (fate === "former") statements.push(`UPDATE ${table} SET ${column} = ?2 WHERE ${is} AND ${GO}`);
    if (fate === "note") statements.push(...removalsOf(`(SELECT id FROM ${table} WHERE ${is} AND ${GO})`));
    if (fate === "upload") statements.push(`UPDATE ${table} SET state = 'removing', ${column} = ?2 WHERE ${is} AND ${GO}`);
    if (fate === "agent") {
      const agents = `(SELECT id FROM ${table} WHERE ${is} AND ${GO})`;
      statements.push(
        `DELETE FROM oauth_tokens WHERE agent_id IN ${agents}`,
        `DELETE FROM oauth_codes WHERE agent_id IN ${agents}`,
        // Its token can never match again: what is kept where a token's hash was is no hash of anything.
        `UPDATE ${table} SET ${column} = ?2, name = '${FORMER_AGENT.replace("'", "''")}', label = NULL, client_id = NULL, token_prefix = '', token_hash = 'former:' || id, revoked_at = COALESCE(revoked_at, ?3) WHERE ${is} AND ${GO}`,
      );
    }
  }
  return statements;
}

const ACCOUNT = [
  `INSERT INTO people (id, email, name, created_at, former) SELECT ?2, ?2 || '@former.invalid', '${FORMER_NAME}', ?3, 1
     WHERE EXISTS (SELECT 1 FROM people WHERE id = ?1 AND former = 0) AND NOT EXISTS (${ONLY_ADMIN})`,
  `UPDATE workspaces SET deleting_at = ?3 WHERE id IN (SELECT id FROM (${ALONE_IN})) AND ${GO}`,
  ...cutting(DELETING),
  ...erasingPerson(),
];

/** Every statement that deleting an account or erasing a workspace runs, for test/core/erase.test.ts to read how each finds its rows. */
export const ERASING: { account: readonly string[]; workspace: readonly string[] } = { account: ACCOUNT, workspace: [...NOTE_CHUNK, UPLOAD_CHUNK, UPLOADS_LATE, ...LAST] };

export interface AccountDeleting {
  db: D1Database;
  personId: string;
  now: number;
  sources: Sources;
  bucket: R2Bucket | null;
  log?: (message: string) => void;
}

/**
 * Deletes a person's account, for the person, who typed their email. Refused while they are the only
 * admin of a workspace others are in. One batch makes a former member to stand in for them, deletes
 * the workspaces they are alone in, takes out everything that was theirs alone, points what they did
 * in shared workspaces at the former member, and deletes their row: from that statement no session,
 * agent, OAuth app or clipper of theirs works. Then their data sources are ended at their provider.
 * Their private uploads' bytes and the workspaces deleted with them are erased after, as much as fits
 * here, and the hourly run carries on with the rest.
 */
export async function deleteAccount(deleting: AccountDeleting, confirm: string): Promise<{ deleted: WorkspaceRef[] }> {
  const plan = await accountDeletion(deleting.db, deleting.personId);
  if (confirm.trim().toLowerCase() !== plan.email) throw new OpError("invalid", `Type your email, ${plan.email}, to delete your account`);
  return carryOut(deleting, plan);
}

async function carryOut({ db, personId, now, sources, bucket, log = logLine }: AccountDeleting, plan: AccountDeletion): Promise<{ deleted: WorkspaceRef[] }> {
  if (plan.blocking.length) throw new OpError("invalid", onlyAdminOf(plan.blocking));

  // Read before the batch, which deletes the connections, and told to their providers only after it: an account the batch refuses keeps them.
  const endSources = await sources.ending(personId);
  const formerId = newId();
  const args = [personId, formerId, now, plan.email];
  const [made] = await db.batch(ACCOUNT.map((sql) => bound(db, sql, args)));
  if (!made!.meta.changes) {
    const now = await accountDeletion(db, personId);
    throw new OpError("invalid", now.blocking.length ? onlyAdminOf(now.blocking) : "Your account couldn't be deleted. Try again.");
  }
  await endSources().catch((err: unknown) => log(`Couldn't end a data source of a deleted account: ${err instanceof Error ? err.message : String(err)}`));
  await remember(bucket, [{ kind: "account", id: personId, at: now }, ...plan.deletes.map((w) => ({ kind: "workspace" as const, id: w.id, at: now }))], log);

  if (bucket) {
    const { results } = await db.prepare("SELECT id FROM uploads WHERE state = 'removing' AND private_owner = ?").bind(formerId).all<{ id: string }>();
    await finishRemoving(db, bucket, results.map((r) => r.id)).catch((err: unknown) => log(`Couldn't remove the private uploads of a deleted account, which the hourly run carries on: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (plan.deletes.length) await eraseWorkspaces(db, bucket, plan.deletes.map((w) => w.id), log);
  else await forgetRemoved(db).catch(() => {});
  return { deleted: plan.deletes };
}

/*
 * A restore of the database to a time before a deletion brings back what was deleted, and a restore
 * to a time before access was taken away gives it back. Each deletion, and each taking away, is kept
 * in the bucket, which a restore of the database doesn't touch, so it can be made again:
 * scripts/redo-deletions.ts puts a request for that in the bucket and has the Worker carry it out
 * (docs/runbooks/restore.md).
 */

/**
 * Something done that a restore would undo. A deletion is of an account or a workspace. Access taken
 * away is a member removed or leaving (`member`, its id the workspace's and the person's, `by` who took
 * them out), a member's role set (`role`, as `member`, the last one kept), a grant or a link taken back
 * (`grant`), an agent disconnected (`agent`), a person signed out everywhere (`signout`, `n` the count
 * of sign-outs it made), or a clipper disconnected (`clipper`).
 */
export interface Deletion {
  kind: "account" | "workspace" | "member" | "role" | "grant" | "agent" | "signout" | "clipper";
  id: string;
  at: number;
  by?: string;
  n?: number;
  role?: Role;
}

const DELETIONS = "deletions/";
/** Where scripts/redo-deletions.ts puts a request. Its name is random, and only someone who can write to the bucket can make one. */
const REDO_REQUESTS = "redo-deletions/";

/** Keeps each deletion under its kind and id, so one kept twice is one, at the later time. */
export async function remember(bucket: R2Bucket | null, deletions: readonly Deletion[], log: (message: string) => void = logLine): Promise<void> {
  if (!bucket || !deletions.length) return;
  try {
    await Promise.all(
      deletions.map((d) =>
        bucket.put(`${DELETIONS}${d.kind}/${d.id}`, JSON.stringify(d), {
          customMetadata: { at: String(d.at), ...(d.by === undefined ? {} : { by: d.by }), ...(d.n === undefined ? {} : { n: String(d.n) }), ...(d.role === undefined ? {} : { role: d.role }) },
        }),
      ),
    );
  } catch (err) {
    // It has been done by now, so failing the request would tell the person it wasn't.
    log(`Couldn't keep the record of a deletion, which a restore would then not make again: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every deletion kept in the bucket. */
async function kept(bucket: R2Bucket): Promise<Deletion[]> {
  const found: Deletion[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: DELETIONS, cursor, include: ["customMetadata"] });
    for (const { key, customMetadata } of page.objects) {
      const [kind, id] = key.slice(DELETIONS.length).split("/") as [Deletion["kind"], string];
      found.push({
        kind,
        id,
        at: Number(customMetadata?.at),
        ...(customMetadata?.by ? { by: customMetadata.by } : {}),
        ...(customMetadata?.n ? { n: Number(customMetadata.n) } : {}),
        ...(customMetadata?.role ? { role: customMetadata.role as Role } : {}),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found;
}

/** Every deletion kept that was made at `since` or after. */
export async function deletionsSince(bucket: R2Bucket, since: number): Promise<Deletion[]> {
  return (await kept(bucket)).filter((d) => d.at >= since).sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** How long a deletion is kept: a day past the 30 days a restore of the database reaches back. */
export const DELETIONS_KEPT_MS = 31 * 86_400_000;

/** Removes the deletions made more than DELETIONS_KEPT_MS before `now`, which no restore can bring back. Answers how many. */
export async function pruneDeletions(bucket: R2Bucket, now: number): Promise<number> {
  const old = (await kept(bucket)).filter((d) => !(d.at >= now - DELETIONS_KEPT_MS)).map((d) => `${DELETIONS}${d.kind}/${d.id}`);
  for (let i = 0; i < old.length; i += 1000) await bucket.delete(old.slice(i, i + 1000));
  return old.length;
}

/** What making a deletion again did: `gone`, it was gone already; `deleted`, it is gone now; `deleting`, it is cut off and the hourly run erases the rest; `revoked`, access is taken away again; or why it was refused. */
export type Redone = "gone" | "deleted" | "deleting" | "revoked" | `refused: ${string}`;

export interface Redoing {
  db: D1Database;
  bucket: R2Bucket;
  sources: Sources;
  now: number;
  log?: (message: string) => void;
}

/** Takes access away again, as it was taken once. Each is a statement that changes nothing the second time, which answers `gone`. */
async function redoRevocation(db: D1Database, { kind, id, at, by, n, role }: Deletion, now: number): Promise<Redone> {
  const changed = (results: D1Result[]) => (results.some((r) => r.meta.changes > 0) ? "revoked" : "gone");
  switch (kind) {
    case "member": {
      const [workspaceId, personId] = id.split(".") as [string, string];
      const [removed, ...rest] = await db.batch([db.prepare("DELETE FROM members WHERE workspace_id = ? AND person_id = ?").bind(workspaceId, personId), ...removalOf({ db, workspaceId, personId: by ?? personId, now }, personId)]);
      return changed([removed!, ...rest]);
    }
    case "role": {
      const [workspaceId, personId] = id.split(".") as [string, string];
      if (role !== "admin" && role !== "editor" && role !== "viewer") return `refused: no role in the record of ${id}`;
      return changed([await db.prepare("UPDATE members SET role = ?3 WHERE workspace_id = ?1 AND person_id = ?2 AND role <> ?3").bind(workspaceId, personId, role).run()]);
    }
    case "grant":
      return changed([await db.prepare("DELETE FROM grants WHERE id = ?").bind(id).run()]);
    case "agent":
      return changed(
        await db.batch([
          db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(at, id),
          db.prepare("DELETE FROM oauth_tokens WHERE agent_id = ?").bind(id),
          db.prepare("DELETE FROM oauth_codes WHERE agent_id = ?").bind(id),
        ]),
      );
    case "signout":
      return changed([await db.prepare("UPDATE people SET sessions_ended = ?2 WHERE id = ?1 AND sessions_ended < ?2").bind(id, n ?? 0).run()]);
    case "clipper":
      return changed([await db.prepare("UPDATE clipper_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(at, id).run()]);
    default:
      // A record of a kind this version doesn't know, as one kept by a newer version would be: the rest are still made again.
      return `refused: ${kind} is a kind of record this version of Common Ink doesn't make again`;
  }
}

/** Makes a deletion again, with nobody asked: it was asked for once already. Run twice, the second time answers `gone`. */
export async function redoDeletion({ db, bucket, sources, now, log = logLine }: Redoing, deletion: Pick<Deletion, "kind" | "id"> & Partial<Deletion>): Promise<Redone> {
  const { kind, id } = deletion;
  if (kind !== "account" && kind !== "workspace") return redoRevocation(db, { at: now, ...deletion }, now);
  if (kind === "account") {
    const plan = await accountDeletion(db, id).catch((err: unknown) => {
      if (err instanceof OpError && err.code === "not_found") return null;
      throw err;
    });
    if (!plan) return "gone";
    try {
      await carryOut({ db, personId: id, now, sources, bucket, log }, plan);
      return "deleted";
    } catch (err) {
      if (err instanceof OpError && err.code === "invalid") return `refused: ${err.message}`;
      throw err;
    }
  }
  if (!(await db.prepare("SELECT 1 FROM workspaces WHERE id = ?").bind(id).first())) return "gone";
  await db.batch([db.prepare("UPDATE workspaces SET deleting_at = ?2 WHERE id = ?1 AND deleting_at IS NULL").bind(id, now), ...cutting(DELETING).map((sql) => db.prepare(sql))]);
  await remember(bucket, [{ kind, id, at: now }], log);
  const { erased } = await eraseWorkspaces(db, bucket, [id], log);
  return erased.includes(id) ? "deleted" : "deleting";
}

export interface RedoRequest {
  accounts: string[];
  workspaces: string[];
  /** Also every deletion kept from this time on, in milliseconds. */
  since: number | null;
}

/**
 * Carries out the request scripts/redo-deletions.ts put in the bucket under `name`, and takes it out
 * of the bucket. Null when there is no such request.
 */
export async function redoRequested(redoing: Redoing, name: string): Promise<{ kind: Deletion["kind"]; id: string; redone: Redone }[] | null> {
  const key = `${REDO_REQUESTS}${name}.json`;
  const object = await redoing.bucket.get(key);
  if (!object) return null;
  try {
    const request = await object.json<RedoRequest>();
    const ids = (list: unknown) => Array.isArray(list) && list.every((id) => typeof id === "string" && /^[a-z0-9]{12}$/.test(id));
    if (!ids(request.accounts) || !ids(request.workspaces) || !(request.since === null || Number.isFinite(request.since))) throw new OpError("invalid", "A request is { accounts, workspaces, since }: two lists of ids, and a time in milliseconds or null");
    const wanted: (Pick<Deletion, "kind" | "id"> & Partial<Deletion>)[] = [...request.accounts.map((id) => ({ kind: "account" as const, id })), ...request.workspaces.map((id) => ({ kind: "workspace" as const, id }))];
    if (request.since !== null) wanted.push(...(await deletionsSince(redoing.bucket, request.since)));
    const seen = new Set<string>();
    const done = [];
    for (const deletion of wanted) {
      const { kind, id } = deletion;
      if (seen.has(`${kind}/${id}`)) continue;
      seen.add(`${kind}/${id}`);
      done.push({ kind, id, redone: await redoDeletion(redoing, deletion) });
    }
    return done;
  } finally {
    await redoing.bucket.delete(key);
  }
}
