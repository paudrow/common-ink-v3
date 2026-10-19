import { SEEN, SEEN_FOLDER, canShare, folderAsked, itemAsked, type ItemFacts } from "./access.ts";
import { newId } from "./ids.ts";
import { loadFolder, loadNote, type Context, type NoteRow } from "./operations.ts";
import { loadUpload } from "./uploads.ts";
import { OpError, type Grant, type GrantAccess, type LinkKind, type Results, type Role, type Sharing } from "./protocol.ts";

/** What a grant is on, as an operation names it. */
interface On {
  noteId?: string;
  folderId?: string;
  uploadId?: string;
}

/** A note or an upload carries `facts`, what access to it is decided from. A folder has none. */
type Item = { kind: "note"; id: string; note: NoteRow; facts: ItemFacts; folderId: string } | { kind: "upload"; id: string; facts: ItemFacts; folderId: string } | { kind: "folder"; id: string; facts?: undefined; folderId: string };

const COLUMN = { note: "note_id", folder: "folder_id", upload: "upload_id" } as const;

/** The one note, folder or upload `on` names, which the actor can see. */
async function itemOf(ctx: Context, on: On): Promise<Item> {
  if ([on.noteId, on.folderId, on.uploadId].filter((id) => id !== undefined).length !== 1) throw new OpError("invalid", "Name one note, one folder or one upload, as noteId, folderId or uploadId");
  if (on.uploadId !== undefined) {
    const upload = await loadUpload(ctx, on.uploadId, "view", "opens");
    return { kind: "upload", id: upload.id, facts: upload, folderId: upload.folder_id };
  }
  if (on.noteId !== undefined) {
    // Who a note is shared with is decided apart from where it is in its life, so a note in Trash is shared and unshared as any other.
    const note = await loadNote(ctx, on.noteId, "view", "opens");
    return { kind: "note", id: note.id, note, facts: note, folderId: note.folder_id };
  }
  const folder = await loadFolder(ctx, on.folderId, "view");
  return { kind: "folder", id: folder.id, folderId: folder.id };
}

const mayShare = (ctx: Context, item: Item) => canShare(item.facts ? itemAsked(ctx.sight, item.facts) : folderAsked(ctx.sight, item.id));

/**
 * On a member a grant narrows, which is deciding who in the workspace sees what: an admin's to do
 * and to undo. On one's own private note it is what lets that member in, so it is the owner's.
 */
function narrowing(ctx: Context, item: Item): void {
  const ownPrivate = item.facts !== undefined && item.facts.private_owner !== null;
  if (ctx.role !== "admin" && !ownPrivate) throw new OpError("forbidden", "They are a member here, and only an admin can narrow what a member's role allows, or stop narrowing it");
}

function sharing(ctx: Context, item: Item): void {
  if (!mayShare(ctx, item)) throw new OpError("forbidden", `Only a member who can change this ${item.kind} can share it`);
}

interface GrantRow {
  id: string;
  note_id: string | null;
  folder_id: string | null;
  upload_id: string | null;
  on_name: string;
  kind: "person" | LinkKind;
  email: string | null;
  person_id: string | null;
  person_name: string | null;
  person_role: Role | null;
  token: string | null;
  access: GrantAccess;
  /** Whether whoever made it named a member, and so was never told the email it is kept by. */
  named: number;
  granted_by: string;
  granted_by_name: string;
  created_at: number;
}

const GRANT_COLUMNS = `g.id, g.note_id, g.folder_id, g.upload_id, COALESCE(n.title, f.name, u.name) AS on_name, g.kind, g.email, g.person_id, p.name AS person_name, m.role AS person_role, g.token, g.access, g.named,
    g.granted_by, b.name AS granted_by_name, g.created_at
  FROM grants g
  JOIN people b ON b.id = g.granted_by
  LEFT JOIN notes n ON n.id = g.note_id
  LEFT JOIN folders f ON f.id = g.folder_id
  LEFT JOIN uploads u ON u.id = g.upload_id
  LEFT JOIN people p ON p.id = g.person_id
  LEFT JOIN members m ON m.workspace_id = g.workspace_id AND m.person_id = g.person_id`;

/** People first, by name or email, then the link. */
const GRANT_ORDER = "g.kind <> 'person', COALESCE(p.name, g.email) COLLATE NOCASE, g.id";

/** A folder the asker cannot share does not give them its link's address, or the email of a grant still waiting. */
function told(ctx: Context, grant: Grant): Grant {
  if (grant.on.kind !== "folder" || mayShare(ctx, { kind: "folder", id: grant.on.id, folderId: grant.on.id })) return grant;
  if (grant.to.kind === "link") return { ...grant, to: { kind: "link", link: grant.to.link, token: null } };
  if (grant.to.personId === null && ctx.role !== "admin" && grant.grantedBy.personId !== ctx.personId) return { ...grant, to: { ...grant.to, email: null } };
  return grant;
}

const toGrant = (ctx: Context, r: GrantRow): Grant => ({
  id: r.id,
  on: r.note_id !== null ? { kind: "note", id: r.note_id, name: r.on_name } : r.upload_id !== null ? { kind: "upload", id: r.upload_id, name: r.on_name } : { kind: "folder", id: r.folder_id!, name: r.on_name },
  access: r.access,
  to:
    r.kind === "person"
      ? { kind: "person", email: r.person_id === null || ctx.role === "admin" || (r.granted_by === ctx.personId && !r.named) ? r.email : null, personId: r.person_id, name: r.person_name, role: r.person_role }
      : { kind: "link", link: r.kind, token: r.token! },
  grantedBy: { personId: r.granted_by, name: r.granted_by_name },
  createdAt: r.created_at,
});

async function grantById(ctx: Context, id: string): Promise<Grant> {
  const row = await ctx.db.prepare(`SELECT ${GRANT_COLUMNS} WHERE g.id = ?`).bind(id).first<GrantRow>();
  if (!row) throw new OpError("not_found", "No such grant");
  return toGrant(ctx, row);
}

/** The folders above `folderId` and itself, nearest first. */
const ABOVE = `WITH RECURSIVE above (id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM folders WHERE id = ?1
    UNION ALL
    SELECT f.id, f.parent_id, above.depth + 1 FROM folders f JOIN above ON f.id = above.parent_id WHERE above.depth < 100
  )`;

export async function listGrants(ctx: Context, on: On): Promise<Sharing> {
  if (on.noteId === undefined && on.folderId === undefined && on.uploadId === undefined) {
    if (ctx.role !== "admin") throw new OpError("forbidden", "Only an admin sees every grant in a workspace. Name a note or a folder.");
    // A grant on a note or an upload the admin can't see, someone's private one, is that owner's to know of.
    const { results } = await ctx.db
      .prepare(
        `SELECT ${GRANT_COLUMNS} WHERE g.workspace_id = ?1 AND (g.note_id IS NULL OR ${SEEN("n", "?2", "any")}) AND (g.upload_id IS NULL OR ${SEEN("u", "?2", "any")})
         ORDER BY g.folder_id IS NULL, COALESCE(n.title, f.name, u.name) COLLATE NOCASE, COALESCE(g.note_id, g.folder_id, g.upload_id), ${GRANT_ORDER}`,
      )
      .bind(ctx.workspaceId, ctx.sight.bind)
      .all<GrantRow>();
    return { canShare: true, grants: results.map((r) => toGrant(ctx, r)), inherited: [], note: null };
  }
  const item = await itemOf(ctx, on);
  const may = mayShare(ctx, item);
  let grants: Grant[] = [];
  let inherited: Grant[] = [];
  if (may) {
    const [own, above] = await ctx.db.batch<GrantRow>([
      ctx.db.prepare(`SELECT ${GRANT_COLUMNS} WHERE g.workspace_id = ?1 AND g.${COLUMN[item.kind]} = ?2 ORDER BY ${GRANT_ORDER}`).bind(ctx.workspaceId, item.id),
      ctx.db
        .prepare(`${ABOVE} SELECT ${GRANT_COLUMNS} JOIN above ON above.id = g.folder_id WHERE above.depth >= ?2 AND ${SEEN_FOLDER("f", "?3")} ORDER BY above.depth, ${GRANT_ORDER}`)
        .bind(item.folderId, item.kind === "folder" ? 1 : 0, ctx.sight.bind),
    ]);
    grants = own!.results.map((r) => toGrant(ctx, r));
    // A private note or upload takes nothing from the folders above it.
    inherited = item.facts && item.facts.private_owner !== null ? [] : above!.results.map((r) => told(ctx, toGrant(ctx, r)));
  }
  return { canShare: may, grants, inherited, note: item.kind === "note" ? await noteSharing(ctx, item.note) : null };
}

/** Whether the one asking may make a note or an upload private, or stop it being so: its owner, or for one that isn't private the member who made it. Never an agent. */
const canSetPrivate = (ctx: Context, item: { private_owner: string | null; created_by: string | null }) =>
  ctx.actor.kind === "member" && (item.private_owner !== null ? item.private_owner === ctx.sight.memberId : ctx.role !== null && item.created_by === ctx.personId);

async function noteSharing(ctx: Context, note: NoteRow): Promise<NonNullable<Sharing["note"]>> {
  const row = await ctx.db
    .prepare(
      `SELECT o.name AS owner_name, r.name AS released_from, b.name AS released_by, n.released_at FROM notes n
       LEFT JOIN people o ON o.id = n.private_owner LEFT JOIN people r ON r.id = n.released_from LEFT JOIN people b ON b.id = n.released_by WHERE n.id = ?`,
    )
    .bind(note.id)
    .first<{ owner_name: string | null; released_from: string | null; released_by: string | null; released_at: number | null }>();
  return {
    private: note.private_owner !== null,
    owner: note.private_owner !== null ? { personId: note.private_owner, name: row?.owner_name ?? "Someone" } : null,
    canSetPrivate: canSetPrivate(ctx, note),
    released: row?.released_from && row.released_at !== null ? { from: row.released_from, by: row.released_by ?? "An admin", at: row.released_at } : null,
  };
}

/**
 * `to` names who the grant is for one way: by the email they sign in with, or as a member of the
 * workspace by their id. A member named by id is granted by the email the workspace already holds,
 * which whoever named them is not told.
 */
export async function setGrant(ctx: Context, on: On, to: { email?: string; memberId?: string }, access: GrantAccess): Promise<Grant> {
  if ((to.email === undefined) === (to.memberId === undefined)) throw new OpError("invalid", "Name who the grant is for one way: as email, or as memberId for a member");
  const item = await itemOf(ctx, on);
  sharing(ctx, item);
  const them = await ctx.db
    .prepare(
      `SELECT p.id, p.email, m.role FROM people p LEFT JOIN members m ON m.person_id = p.id AND m.workspace_id = ?2
       WHERE ${to.memberId === undefined ? "p.email = ?1" : "p.id = ?1 AND m.role IS NOT NULL"}`,
    )
    .bind(to.email ?? to.memberId, ctx.workspaceId)
    .first<{ id: string; email: string; role: Role | null }>();
  if (to.memberId !== undefined && !them) throw new OpError("not_found", "No such member");
  const email = to.email ?? them!.email;
  if (them?.id === ctx.personId) throw new OpError("invalid", "That's you. A grant is for someone else.");
  if (them?.role) narrowing(ctx, item);
  const column = COLUMN[item.kind];
  const row = await ctx.db
    .prepare(
      `INSERT INTO grants (id, workspace_id, ${column}, kind, email, person_id, access, granted_by, created_at, named)
       VALUES (?1, ?2, ?3, 'person', ?4, (SELECT id FROM people WHERE email = ?4), ?5, ?6, ?7, ?8)
       ON CONFLICT (${column}, email) WHERE kind = 'person' AND ${column} IS NOT NULL DO UPDATE SET access = excluded.access, granted_by = excluded.granted_by, named = excluded.named
       RETURNING id`,
    )
    .bind(newId(), ctx.workspaceId, item.id, email, access, ctx.personId, ctx.now, to.memberId === undefined ? 0 : 1)
    .first<{ id: string }>();
  return grantById(ctx, row!.id);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A link's token is 256 random bits, so there is no finding one by trying. Changing who it opens for keeps it, so the address already sent still works. */
export async function linkTo(ctx: Context, on: On, link: LinkKind | null): Promise<Grant | null> {
  const item = await itemOf(ctx, on);
  // A link opens a page to read. A file is reached by a link only through the folder it is in.
  if (item.kind === "upload") throw new OpError("invalid", "An upload has no link of its own. Put a link on the folder it is in.");
  sharing(ctx, item);
  const column = COLUMN[item.kind];
  if (link === null) {
    await ctx.db.prepare(`DELETE FROM grants WHERE workspace_id = ? AND ${column} = ? AND kind <> 'person'`).bind(ctx.workspaceId, item.id).run();
    return null;
  }
  const row = await ctx.db
    .prepare(
      `INSERT INTO grants (id, workspace_id, ${column}, kind, token, access, granted_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'view', ?6, ?7)
       ON CONFLICT (${column}) WHERE kind <> 'person' AND ${column} IS NOT NULL DO UPDATE SET kind = excluded.kind
       RETURNING id`,
    )
    .bind(newId(), ctx.workspaceId, item.id, link, b64url(crypto.getRandomValues(new Uint8Array(32))), ctx.personId, ctx.now)
    .first<{ id: string }>();
  return grantById(ctx, row!.id);
}

/** Revoking twice is refused the second time as for a grant that never was: nothing tells the two apart. */
export async function revokeGrant(ctx: Context, id: string): Promise<{ id: string }> {
  const none = new OpError("not_found", "No such grant");
  const row = await ctx.db
    .prepare("SELECT g.note_id, g.folder_id, g.upload_id, m.role FROM grants g LEFT JOIN members m ON m.workspace_id = g.workspace_id AND m.person_id = g.person_id WHERE g.id = ? AND g.workspace_id = ?")
    .bind(id, ctx.workspaceId)
    .first<{ note_id: string | null; folder_id: string | null; upload_id: string | null; role: Role | null }>();
  if (!row) throw none;
  let item: Item;
  try {
    item = await itemOf(ctx, { noteId: row.note_id ?? undefined, folderId: row.folder_id ?? undefined, uploadId: row.upload_id ?? undefined });
  } catch (err) {
    // A grant on something the actor can't see is no grant to them.
    if (err instanceof OpError && err.code === "not_found") throw none;
    throw err;
  }
  sharing(ctx, item);
  if (row.role) narrowing(ctx, item);
  await ctx.db.prepare("DELETE FROM grants WHERE id = ?").bind(id).run();
  return { id };
}

async function makePrivate(ctx: Context, table: "notes" | "uploads", item: { id: string; private_owner: string | null; created_by: string | null }, makePrivate: boolean): Promise<{ id: string; private: boolean; removed: number }> {
  const { id } = item;
  const word = table === "notes" ? "note" : "upload";
  if ((item.private_owner !== null) === makePrivate) return { id, private: makePrivate, removed: 0 };
  if (!canSetPrivate(ctx, item)) throw new OpError("forbidden", makePrivate ? `Only the member who made ${word === "note" ? "a note" : "an upload"} can make it private` : `Only its owner can stop ${word === "note" ? "a note" : "an upload"} being private`);
  const [updated, removed] = await ctx.db.batch([
    // The owner is still a member as this is written, so nothing is ever private to someone who has left.
    ctx.db
      .prepare(
        `UPDATE ${table} SET private_owner = ?3, released_from = NULL, released_at = NULL, released_by = NULL
         WHERE id = ?1 AND workspace_id = ?2 AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ?2 AND m.person_id = ?4)`,
      )
      .bind(id, ctx.workspaceId, makePrivate ? ctx.personId : null, ctx.personId),
    // A private note is open only to whoever its owner lets in. What anyone else put on it, a grant or a link, would stay
    // live where its maker could no longer see or take it back, so it goes as the note becomes private. Refusing instead
    // would leave the owner waiting on grants only an admin can take away.
    ctx.db.prepare(`DELETE FROM grants WHERE ${COLUMN[word]} = ?1 AND granted_by <> ?2 AND EXISTS (SELECT 1 FROM ${table} n WHERE n.id = ?1 AND n.private_owner = ?2)`).bind(id, ctx.personId),
  ]);
  if (!updated!.meta.changes) throw new OpError("not_found", `No such ${word}`);
  return { id, private: makePrivate, removed: removed!.meta.changes };
}

export const setPrivate = async (ctx: Context, id: string, to: boolean): Promise<Results["note.setPrivate"]> => makePrivate(ctx, "notes", await loadNote(ctx, id, "view", "opens"), to);
export const setUploadPrivate = async (ctx: Context, id: string, to: boolean): Promise<Results["upload.setPrivate"]> => makePrivate(ctx, "uploads", await loadUpload(ctx, id, "view", "opens"), to);

/**
 * `canShare` as one condition on a row of `grants`: true while whoever made that grant may still
 * share what it is on. A grant that waited for its email to sign in takes effect in a statement that
 * carries this, so it can't take effect in the moment after its maker lost the right, as an invite
 * can't. test/core/access-matrix.test.ts holds it to the same table as `resolve`.
 *
 * Here the item is the note or the upload the grant is on, and both are read as one thing, `items`.
 * The maker owns the private note it is on, or else is an admin or an editor, the item is not someone
 * else's private note, and for an editor the nearest grant that names them, on the item or a folder
 * above it, doesn't narrow them to view.
 */
export const MAKER_SHARES = `EXISTS (
    WITH items (id, folder_id, private_owner) AS (SELECT id, folder_id, private_owner FROM notes UNION ALL SELECT id, folder_id, private_owner FROM uploads)
    SELECT 1 FROM members mk
    WHERE mk.workspace_id = grants.workspace_id AND mk.person_id = grants.granted_by
      AND (EXISTS (SELECT 1 FROM items pn WHERE pn.id = COALESCE(grants.note_id, grants.upload_id) AND pn.private_owner = mk.person_id) OR mk.role IN ('admin', 'editor'))
      AND NOT EXISTS (SELECT 1 FROM items pn WHERE pn.id = COALESCE(grants.note_id, grants.upload_id) AND pn.private_owner IS NOT NULL AND pn.private_owner <> mk.person_id)
      AND (mk.role = 'admin' OR EXISTS (SELECT 1 FROM items pn WHERE pn.id = COALESCE(grants.note_id, grants.upload_id) AND pn.private_owner = mk.person_id) OR COALESCE(
        (SELECT own.access FROM grants own WHERE (own.note_id = grants.note_id OR own.upload_id = grants.upload_id) AND own.person_id = mk.person_id AND own.kind = 'person'),
        (WITH RECURSIVE above (id, parent_id, depth) AS (
           SELECT f.id, f.parent_id, 0 FROM folders f WHERE f.id = COALESCE(grants.folder_id, (SELECT folder_id FROM items WHERE id = COALESCE(grants.note_id, grants.upload_id)))
           UNION ALL
           SELECT f.id, f.parent_id, above.depth + 1 FROM folders f JOIN above ON f.id = above.parent_id WHERE above.depth < 100
         )
         SELECT up.access FROM above JOIN grants up ON up.folder_id = above.id AND up.person_id = mk.person_id AND up.kind = 'person' ORDER BY above.depth LIMIT 1),
        -- The walk stops at 100 folders. A parent still above that was not read, so the maker is not treated as allowed to share.
        (SELECT CASE WHEN EXISTS (
           WITH RECURSIVE above (id, parent_id, depth) AS (
             SELECT f.id, f.parent_id, 0 FROM folders f WHERE f.id = COALESCE(grants.folder_id, (SELECT folder_id FROM items WHERE id = COALESCE(grants.note_id, grants.upload_id)))
             UNION ALL
             SELECT f.id, f.parent_id, above.depth + 1 FROM folders f JOIN above ON f.id = above.parent_id WHERE above.depth < 100
           )
           SELECT 1 FROM above WHERE above.depth = 100 AND above.parent_id IS NOT NULL
         ) THEN 'view' ELSE 'edit' END)) = 'edit')
  )`;
