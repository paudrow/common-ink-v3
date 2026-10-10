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
  const person = await db.prepare("SELECT id, name FROM people WHERE email = ?").bind(email).first<{ id: string; name: string }>();
  if (!person) throw new Error(`no person for ${email} after sign-in`);

  const member = await db.prepare("SELECT 1 FROM members WHERE person_id = ? LIMIT 1").bind(person.id).first();
  if (!member) await createWorkspace(db, person.id, `${person.name.split(/\s+/)[0]}'s workspace`, now);
  return { personId: person.id };
}

async function createWorkspace(db: D1Database, adminId: string, name: string, now: number): Promise<string> {
  const workspaceId = newId();
  const unsortedId = newId();
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, unsorted_folder_id, created_at) VALUES (?, ?, ?, ?)").bind(workspaceId, name, unsortedId, now),
    db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name) VALUES (?, ?, NULL, 'Unsorted')").bind(unsortedId, workspaceId),
    db.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'admin')").bind(workspaceId, adminId),
  ]);
  return workspaceId;
}

export async function whoAmI(db: D1Database, personId: string): Promise<Me> {
  const person = await db.prepare("SELECT id, email, name FROM people WHERE id = ?").bind(personId).first<Me["person"]>();
  if (!person) throw new Error(`no person ${personId}`);
  const { results } = await db
    .prepare("SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.person_id = ? ORDER BY w.created_at")
    .bind(personId)
    .all<{ id: string; name: string; role: Role }>();
  return { person, workspaces: results };
}
