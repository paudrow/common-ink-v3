import { newId } from "./ids.ts";
import type { Me, Role } from "./protocol.ts";

export interface SignInIdentity {
  email: string;
  name: string;
}

/** The person with this email, created with a workspace of their own the first time they sign in. */
export async function signIn(db: D1Database, identity: SignInIdentity, now = Date.now()): Promise<{ personId: string }> {
  const email = identity.email.trim().toLowerCase();
  const name = identity.name.trim() || email;
  await db
    .prepare("INSERT INTO people (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(newId(), email, name, now)
    .run();
  const person = await db.prepare("SELECT id FROM people WHERE email = ?").bind(email).first<{ id: string }>();
  if (!person) throw new Error(`no person for ${email} after sign-in`);
  await arrive(db, person.id, now);
  return { personId: person.id };
}

/** An invite `i` lets someone in only while whoever made it is still an admin of its workspace. Checked as it is taken up. */
const STANDS = "EXISTS (SELECT 1 FROM members a WHERE a.workspace_id = i.workspace_id AND a.person_id = i.invited_by AND a.role = 'admin')";

/**
 * What a person finds done each time they sign in or open Common Ink: a workspace of their own if
 * they are in none, and a place in every workspace their email has been invited to. Their email was
 * checked when they signed in, so an invite is taken up by nobody else.
 */
export async function arrive(db: D1Database, personId: string, now = Date.now()): Promise<void> {
  const person = await db
    .prepare(
      `SELECT p.name, EXISTS (SELECT 1 FROM members m WHERE m.person_id = p.id) AS member, EXISTS (SELECT 1 FROM invites i WHERE i.email = p.email AND i.state = 'pending') AS invited
       FROM people p WHERE p.id = ?`,
    )
    .bind(personId)
    .first<{ name: string; member: number; invited: number }>();
  if (!person) throw new Error(`no person ${personId}`);
  if (!person.member) await createFirstWorkspace(db, personId, `${person.name.split(/\s+/)[0]}'s workspace`, now);
  if (!person.invited) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO members (workspace_id, person_id, role, joined_at)
         SELECT i.workspace_id, p.id, i.role, ?2 FROM invites i JOIN people p ON p.email = i.email WHERE p.id = ?1 AND i.state = 'pending' AND ${STANDS}
         ON CONFLICT (workspace_id, person_id) DO NOTHING`,
      )
      .bind(personId, now),
    db.prepare(`UPDATE invites AS i SET state = 'accepted', decided_at = ?2 WHERE i.state = 'pending' AND i.email = (SELECT email FROM people WHERE id = ?1) AND ${STANDS}`).bind(personId, now),
  ]);
}

/** A batch runs as one transaction, so of two racing first sign-ins only one finds no membership. */
async function createFirstWorkspace(db: D1Database, adminId: string, name: string, now: number): Promise<void> {
  const workspaceId = newId();
  const unsortedId = newId();
  await db.batch([
    db
      .prepare("INSERT INTO workspaces (id, name, unsorted_folder_id, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE person_id = ?)")
      .bind(workspaceId, name, unsortedId, now, adminId),
    db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name) SELECT ?, id, NULL, 'Unsorted' FROM workspaces WHERE id = ?").bind(unsortedId, workspaceId),
    db.prepare("INSERT INTO members (workspace_id, person_id, role, joined_at) SELECT id, ?, 'admin', ? FROM workspaces WHERE id = ?").bind(adminId, now, workspaceId),
  ]);
}

export async function whoAmI(db: D1Database, personId: string): Promise<Me> {
  const person = await db.prepare("SELECT id, email, name FROM people WHERE id = ?").bind(personId).first<Me["person"]>();
  if (!person) throw new Error(`no person ${personId}`);
  const { results } = await db
    .prepare("SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.person_id = ? ORDER BY m.joined_at, w.created_at")
    .bind(personId)
    .all<{ id: string; name: string; role: Role }>();
  return { person, workspaces: results };
}

/**
 * The workspace a note is in, if the person is a member of it. Null says nothing about whether there is such a note.
 *
 * For #15: this answers for every note in the workspace to every member, which is right only while a
 * member can see every note. Once a note can be private, or narrowed by a grant, it must answer only
 * for a note the person can see, or it tells them a hidden note exists. A non-member with a grant is
 * in no row of `members`, so finding their note's workspace needs a join on grants as well.
 */
export async function workspaceOfNote(db: D1Database, personId: string, noteId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT n.workspace_id FROM notes n JOIN members m ON m.workspace_id = n.workspace_id AND m.person_id = ? WHERE n.id = ?")
    .bind(personId, noteId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}

/**
 * The workspace an invite's link leads to, for the person the invite made a member and nobody else.
 * Null says nothing about whether there is such an invite, or whose it is.
 */
export async function workspaceOfInvite(db: D1Database, personId: string, inviteId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT i.workspace_id FROM invites i
       JOIN people p ON p.email = i.email AND p.id = ?
       JOIN members m ON m.workspace_id = i.workspace_id AND m.person_id = p.id
       WHERE i.id = ? AND i.state = 'accepted'`,
    )
    .bind(personId, inviteId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}
