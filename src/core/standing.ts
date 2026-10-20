import { sightOf, type GrantLevel, type Reaching, type Sight } from "./access.ts";
import { OpError, type Role, type Standing as StandingName } from "./protocol.ts";
import { linkHash } from "./linkSeal.ts";

/** Where someone stands in a workspace for one operation: who they are there, and what they can see. */
export interface Standing {
  workspaceId: string;
  /** Null for whoever opened a link. */
  personId: string | null;
  name: string;
  /** Null for a guest and for whoever opened a link. */
  role: Role | null;
  /** The most they can do with anything in the workspace. */
  most: GrantLevel | "manage";
  /** What they are called when they are refused: "A viewer", "A guest". */
  as: StandingName | "link";
  sight: Sight;
}

interface GrantRow {
  note_id: string | null;
  folder_id: string | null;
  upload_id: string | null;
  access: GrantLevel;
}

const reaching = (row: GrantRow): Reaching => (row.folder_id !== null ? { folderId: row.folder_id, access: row.access } : { itemId: (row.note_id ?? row.upload_id)!, access: row.access });

async function folderParents(db: D1Database, workspaceId: string): Promise<Map<string, string | null>> {
  const { results } = await db.prepare("SELECT id, parent_id FROM folders WHERE workspace_id = ?").bind(workspaceId).all<{ id: string; parent_id: string | null }>();
  return new Map(results.map((f) => [f.id, f.parent_id]));
}

const MOST: Record<Role, Standing["most"]> = { admin: "manage", editor: "edit", viewer: "view" };

/**
 * Where a person stands in a workspace: as a member with a role, or as a guest, whom at least one
 * grant names. Null for anyone else, and that says nothing about whether there is such a workspace.
 * `limit` is the folders an agent acting for them is limited to: its sight is theirs, less what is
 * outside those.
 */
export async function standingIn(db: D1Database, personId: string, workspaceId: string, limit: readonly string[] | null = null): Promise<Standing | null> {
  const [who, granted] = await db.batch<{ name: string; role: Role | null } & GrantRow>([
    // A workspace being deleted is no workspace to anyone, though its members are already gone: this says so whatever is still there.
    db.prepare("SELECT p.name, m.role FROM people p LEFT JOIN members m ON m.person_id = p.id AND m.workspace_id = ?2 WHERE p.id = ?1 AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ?2 AND w.deleting_at IS NOT NULL)").bind(personId, workspaceId),
    db.prepare("SELECT note_id, folder_id, upload_id, access FROM grants WHERE workspace_id = ?2 AND person_id = ?1 AND kind = 'person'").bind(personId, workspaceId),
  ]);
  const person = who!.results[0];
  const grants = granted!.results;
  if (!person || (!person.role && !grants.length)) return null;
  const { role, name } = person;
  // A member with no grant on a folder sees every folder, so there is nothing to work out from them.
  const parents = !role || limit || grants.some((g) => g.folder_id !== null) ? await folderParents(db, workspaceId) : new Map<string, string | null>();
  return {
    workspaceId,
    personId,
    name,
    role,
    most: role ? MOST[role] : grants.some((g) => g.access === "edit") ? "edit" : "view",
    as: role ?? "guest",
    sight: sightOf({ personId, role }, grants.map(reaching), parents, limit),
  };
}

export const NO_SUCH_LINK = "No such link";
export const SIGN_IN_FIRST = "Sign in to open this link";

/**
 * Where whoever holds a link stands: they can read what the link is on, and nothing else, whoever
 * they are. A signed-in link opens only for a person, and which person makes no difference.
 */
/** The link whose token is ?2 and whose hash is ?1: found by its hash, or by its token while it is one kept from before links were sealed. */
export const BY_TOKEN = (g: string) => `(${g}.token_hash = ?1 OR (${g}.token_hash IS NULL AND ${g}.token = ?2))`;

export async function standingByLink(db: D1Database, token: string, personId: string | null): Promise<Standing> {
  const link = await db
    // A link on a note in Trash opens nothing until the note is restored.
    .prepare(`SELECT workspace_id, note_id, folder_id, upload_id, access, kind FROM grants WHERE ${BY_TOKEN("grants")} AND kind IN ('public', 'signed_in') AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = grants.note_id AND n.state = 'trashed') AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = grants.workspace_id AND w.deleting_at IS NOT NULL)`)
    .bind(await linkHash(token), token)
    .first<GrantRow & { workspace_id: string; kind: "public" | "signed_in" }>();
  if (!link) throw new OpError("not_found", NO_SUCH_LINK);
  if (link.kind === "signed_in" && !personId) throw new OpError("forbidden", SIGN_IN_FIRST);
  const parents = link.folder_id !== null ? await folderParents(db, link.workspace_id) : new Map<string, string | null>();
  return { workspaceId: link.workspace_id, personId: null, name: "", role: null, most: "view", as: "link", sight: sightOf({ personId: null, role: null }, [reaching(link)], parents) };
}
