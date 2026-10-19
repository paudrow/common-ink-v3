import { allows, itemLevel } from "./access.ts";
import { newId } from "./ids.ts";
import type { Me, Standing } from "./protocol.ts";
import { MAKER_SHARES } from "./sharing.ts";
import { standingIn } from "./standing.ts";

export interface SignInIdentity {
  email: string;
  name: string;
}

/** The person with this email, created with a workspace of their own the first time they sign in. */
export async function signIn(db: D1Database, identity: SignInIdentity, now = Date.now()): Promise<{ personId: string; sessionsEnded: number }> {
  const email = identity.email.trim().toLowerCase();
  const name = identity.name.trim() || email;
  await db
    .prepare("INSERT INTO people (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(newId(), email, name, now)
    .run();
  const person = await db.prepare("SELECT id, sessions_ended FROM people WHERE email = ?").bind(email).first<{ id: string; sessions_ended: number }>();
  if (!person) throw new Error("no person for that email after sign-in");
  await arrive(db, person.id, now);
  return { personId: person.id, sessionsEnded: person.sessions_ended };
}

/** Whether a session started when the person's sessions had been ended `sessionsEnded` times still holds: none has been ended since. */
export async function sessionHolds(db: D1Database, personId: string, sessionsEnded: number): Promise<boolean> {
  const person = await db.prepare("SELECT sessions_ended FROM people WHERE id = ?").bind(personId).first<{ sessions_ended: number }>();
  return person?.sessions_ended === sessionsEnded;
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
      `SELECT p.name, p.email, EXISTS (SELECT 1 FROM members m WHERE m.person_id = p.id) AS member, EXISTS (SELECT 1 FROM invites i WHERE i.email = p.email AND i.state = 'pending') AS invited,
         EXISTS (SELECT 1 FROM grants g WHERE g.email = p.email AND g.kind = 'person' AND g.person_id IS NULL) AS granted
       FROM people p WHERE p.id = ?`,
    )
    .bind(personId)
    .first<{ name: string; email: string; member: number; invited: number; granted: number }>();
  if (!person) throw new Error(`no person ${personId}`);
  if (!person.member) await createFirstWorkspace(db, personId, `${person.name.split(/\s+/)[0]}'s workspace`, now);
  if (person.granted) await takeUpGrants(db, personId, person.email);
  if (!person.invited) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO members (workspace_id, person_id, role, joined_at)
         SELECT i.workspace_id, p.id, i.role, ?2 FROM invites i JOIN people p ON p.email = i.email WHERE p.id = ?1 AND i.state = 'pending' AND ${STANDS}
         ON CONFLICT (workspace_id, person_id) DO NOTHING`,
      )
      .bind(personId, now),
    // Whoever was a guest is a member now, with the role they were offered. The grants that made them a guest
    // would from here on only narrow that role, which nobody chose, so they go. One on a private note stays: it is what lets them in.
    db
      .prepare(
        `DELETE FROM grants WHERE kind = 'person' AND person_id = ?1
           AND EXISTS (SELECT 1 FROM invites i JOIN people p ON p.email = i.email WHERE p.id = ?1 AND i.workspace_id = grants.workspace_id AND i.state = 'pending' AND ${STANDS})
           AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = grants.note_id AND n.private_owner IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.id = grants.upload_id AND u.private_owner IS NOT NULL)`,
      )
      .bind(personId),
    db.prepare(`UPDATE invites AS i SET state = 'accepted', decided_at = ?2 WHERE i.state = 'pending' AND i.email = (SELECT email FROM people WHERE id = ?1) AND ${STANDS}`).bind(personId, now),
  ]);
}

/**
 * Makes the grants that were waiting for this email the person's. One whose maker can no longer
 * share what it is on is taken away instead, as an invite from someone who is no longer an admin is.
 * Each grant is decided by the statement that makes it theirs, so none takes effect just after its
 * maker lost the right.
 */
const takeUpGrants = (db: D1Database, personId: string, email: string) =>
  db.batch([
    db.prepare(`UPDATE grants SET person_id = ?1 WHERE email = ?2 AND kind = 'person' AND person_id IS NULL AND ${MAKER_SHARES}`).bind(personId, email),
    db.prepare("DELETE FROM grants WHERE email = ? AND kind = 'person' AND person_id IS NULL").bind(email),
  ]);

/** A batch runs as one transaction, so of two racing first sign-ins only one finds no membership. */
async function createFirstWorkspace(db: D1Database, adminId: string, name: string, now: number): Promise<void> {
  const workspaceId = newId();
  const unsortedId = newId();
  await db.batch([
    db
      .prepare("INSERT INTO workspaces (id, name, unsorted_folder_id, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE person_id = ?)")
      .bind(workspaceId, name, unsortedId, now, adminId),
    db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name, name_key) SELECT ?, id, NULL, 'Unsorted', 'unsorted' FROM workspaces WHERE id = ?").bind(unsortedId, workspaceId),
    db.prepare("INSERT INTO members (workspace_id, person_id, role, joined_at) SELECT id, ?, 'admin', ? FROM workspaces WHERE id = ?").bind(adminId, now, workspaceId),
  ]);
}

/** `dev` is the Worker's to say: whether this is a place where dev sign-in is on. */
export async function whoAmI(db: D1Database, personId: string, dev = false): Promise<Me> {
  const person = await db.prepare("SELECT id, email, name FROM people WHERE id = ?").bind(personId).first<Me["person"]>();
  if (!person) throw new Error(`no person ${personId}`);
  // The workspaces they are a member of, in the order they came to them, then those they are a guest in.
  const { results } = await db
    .prepare(
      `SELECT w.id, w.name, COALESCE(m.role, 'guest') AS role FROM workspaces w
       LEFT JOIN members m ON m.workspace_id = w.id AND m.person_id = ?1
       WHERE m.person_id IS NOT NULL OR EXISTS (SELECT 1 FROM grants g WHERE g.workspace_id = w.id AND g.person_id = ?1 AND g.kind = 'person')
       ORDER BY m.person_id IS NULL, m.joined_at, w.created_at, w.name`,
    )
    .bind(personId)
    .all<{ id: string; name: string; role: Standing }>();
  return { person, workspaces: results, dev };
}

/**
 * The workspace a note is in, for a person who can see the note. Null says nothing about whether
 * there is such a note: one they can't see is no note to them.
 */
export async function workspaceOfNote(db: D1Database, personId: string, noteId: string): Promise<string | null> {
  const note = await db.prepare("SELECT id, workspace_id, folder_id, private_owner FROM notes WHERE id = ?").bind(noteId).first<{ id: string; workspace_id: string; folder_id: string; private_owner: string | null }>();
  if (!note) return null;
  const standing = await standingIn(db, personId, note.workspace_id);
  return standing && allows(itemLevel(standing.sight, note), "view") ? note.workspace_id : null;
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
