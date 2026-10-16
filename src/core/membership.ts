import { newId } from "./ids.ts";
import { NO_SUCH_WORKSPACE, OpError, type Invite, type Member, type Results, type Role } from "./protocol.ts";

/** Who is asking for a change to a workspace's members, and when. */
export interface Asking {
  db: D1Database;
  workspaceId: string;
  personId: string;
  now: number;
}

/*
 * Each change below is one statement that checks what it depends on as it writes: that the one asking
 * is an admin at that moment, and that the workspace is left with an admin. So two admins who demote
 * or remove each other at once can't both succeed, and neither can an admin demoted a moment ago.
 * In every statement ?1 is the workspace, ?2 the one asking, and ?3 the member it is about.
 */
const STILL_ADMIN = "EXISTS (SELECT 1 FROM members a WHERE a.workspace_id = ?1 AND a.person_id = ?2 AND a.role = 'admin')";
const anotherAdminThan = (member: "?2" | "?3") => `EXISTS (SELECT 1 FROM members o WHERE o.workspace_id = ?1 AND o.role = 'admin' AND o.person_id <> ${member})`;
const ANOTHER_ADMIN = anotherAdminThan("?3");

/**
 * Takes back the pending invites of a person who is no longer an admin of the workspace, and none
 * while they still are. It goes in the batch with whatever may have ended that, so an invite never
 * outlasts the right to make it. The person is named by id, or by email.
 */
const orphaned = ({ db, workspaceId, now }: Asking, by: { id: string } | { email: string }) =>
  db
    .prepare(
      `UPDATE invites SET state = 'revoked', decided_at = ?3 WHERE workspace_id = ?1 AND state = 'pending' AND invited_by = ${"id" in by ? "?2" : "(SELECT id FROM people WHERE email = ?2)"}
         AND NOT EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ?1 AND m.person_id = invites.invited_by AND m.role = 'admin')`,
    )
    .bind(workspaceId, "id" in by ? by.id : by.email, now);

/*
 * What goes with a member who is no longer one, in the batch that took them out. Each does nothing
 * while they still are one.
 *
 * Their grants go: a grant on a member only narrowed their role, and left behind it would let them
 * back in as a guest. Their private notes stop being private, since nobody else could ever reach
 * them, and each keeps whose it was, when, and who took the member out.
 */
const gone = (member: string) => `NOT EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ?1 AND m.person_id = ${member})`;
const ungranted = ({ db, workspaceId }: Asking, memberId: string) => db.prepare(`DELETE FROM grants WHERE workspace_id = ?1 AND person_id = ?2 AND ${gone("?2")}`).bind(workspaceId, memberId);
const released = ({ db, workspaceId, personId, now }: Asking, memberId: string) =>
  db
    .prepare(`UPDATE notes SET private_owner = NULL, released_from = ?3, released_by = ?2, released_at = ?4 WHERE workspace_id = ?1 AND private_owner = ?3 AND ${gone("?3")}`)
    .bind(workspaceId, personId, memberId, now);

const LAST_ADMIN = "A workspace needs an admin. Make someone else an admin first.";
const ownsPrivate = (notes: number, trashed: number) =>
  `You have ${notes === 1 ? "a private note" : `${notes} private notes`} here besides your daily notes, which nobody else can reach. Stop ${notes === 1 ? "it" : "them"} being private first, so ${notes === 1 ? "it isn't" : "they aren't"} left with nobody.${trashed ? " Look in Trash too." : ""}`;
/** A private note that is not one of its owner's daily notes, which go to the workspace when the owner leaves. */
const KEPT_PRIVATE = "n.workspace_id = ?1 AND n.private_owner = ?2 AND n.id NOT IN (SELECT d.note_id FROM daily_notes d WHERE d.workspace_id = ?1 AND d.person_id = ?2)";

/** Why a statement that changes a member changed nothing. */
async function refusal({ db, workspaceId, personId }: Asking, doing: string, memberId: string, needs: "admin" | "member" = "admin"): Promise<OpError> {
  const { results } = await db
    .prepare("SELECT person_id, role FROM members WHERE workspace_id = ? AND person_id IN (?, ?)")
    .bind(workspaceId, personId, memberId)
    .all<{ person_id: string; role: Role }>();
  const asking = results.find((r) => r.person_id === personId);
  if (!asking) return new OpError("not_found", NO_SUCH_WORKSPACE);
  if (needs === "admin" && asking.role !== "admin") return new OpError("forbidden", `A ${asking.role} can't ${doing}`);
  if (!results.some((r) => r.person_id === memberId)) return new OpError("not_found", "No such member");
  const kept = needs === "member" ? await db.prepare(`SELECT COUNT(*) AS notes, COALESCE(SUM(n.state = 'trashed'), 0) AS trashed FROM notes n WHERE ${KEPT_PRIVATE}`).bind(workspaceId, personId).first<{ notes: number; trashed: number }>() : null;
  if (kept?.notes) return new OpError("invalid", ownsPrivate(kept.notes, kept.trashed));
  return new OpError("invalid", LAST_ADMIN);
}

const MEMBER_COLUMNS = "p.id AS personId, p.name, m.role, p.email FROM members m JOIN people p ON p.id = m.person_id";

/** Everyone in the workspace. An email is how a person signs in, so only an admin, who invites by it, is told it. */
export async function listMembers(db: D1Database, workspaceId: string, { emails }: { emails: boolean }): Promise<Member[]> {
  const { results } = await db.prepare(`SELECT ${MEMBER_COLUMNS} WHERE m.workspace_id = ? ORDER BY p.name COLLATE NOCASE, p.id`).bind(workspaceId).all<Required<Member>>();
  return emails ? results : results.map(({ email: _, ...member }) => member);
}

const loadMember = (db: D1Database, workspaceId: string, memberId: string) =>
  db.prepare(`SELECT ${MEMBER_COLUMNS} WHERE m.workspace_id = ? AND m.person_id = ?`).bind(workspaceId, memberId).first<Member>();

export async function setRole(asking: Asking, memberId: string, role: Role): Promise<Member> {
  const { db, workspaceId, personId } = asking;
  const [changed] = await db.batch([
    db.prepare(`UPDATE members SET role = ?4 WHERE workspace_id = ?1 AND person_id = ?3 AND ${STILL_ADMIN} AND (?4 = 'admin' OR role <> 'admin' OR ${ANOTHER_ADMIN})`).bind(workspaceId, personId, memberId, role),
    orphaned(asking, { id: memberId }),
  ]);
  if (!changed!.meta.changes) throw await refusal(asking, "member.setRole", memberId);
  const member = await loadMember(db, workspaceId, memberId);
  // Taken out between the two statements: the role was theirs for that moment.
  if (!member) throw new OpError("not_found", "No such member");
  return member;
}

export async function removeMember(asking: Asking, memberId: string): Promise<{ memberId: string }> {
  const { db, workspaceId, personId } = asking;
  const [removed] = await db.batch([
    db.prepare(`DELETE FROM members WHERE workspace_id = ?1 AND person_id = ?3 AND ${STILL_ADMIN} AND (role <> 'admin' OR ${ANOTHER_ADMIN})`).bind(workspaceId, personId, memberId),
    orphaned(asking, { id: memberId }),
    ungranted(asking, memberId),
    released(asking, memberId),
  ]);
  if (!removed!.meta.changes) throw await refusal(asking, "member.remove", memberId);
  return { memberId };
}

/**
 * Anyone may leave, except the workspace's only admin, and except while they have private notes:
 * those are theirs to hand to the workspace, by stopping them being private, before they go. Their
 * daily notes are the exception. They are released as a removed member's private notes are.
 */
export async function leave(asking: Asking): Promise<{ memberId: string }> {
  const { db, workspaceId, personId } = asking;
  const [left] = await db.batch([
    db
      .prepare(
        `DELETE FROM members WHERE workspace_id = ?1 AND person_id = ?2 AND (role <> 'admin' OR ${anotherAdminThan("?2")})
           AND NOT EXISTS (SELECT 1 FROM notes n WHERE ${KEPT_PRIVATE})`,
      )
      .bind(workspaceId, personId),
    orphaned(asking, { id: personId }),
    ungranted(asking, personId),
    // Their daily notes were made private for them, not by them, so they don't hold them here: each stops being private and keeps whose it was.
    released(asking, personId),
  ]);
  if (!left!.meta.changes) throw await refusal(asking, "member.leave", personId, "member");
  return { memberId: personId };
}

interface InviteRow {
  id: string;
  email: string;
  role: Role;
  invited_by: string;
  invited_by_name: string;
  created_at: number;
}

const INVITE_COLUMNS = "i.id, i.email, i.role, i.invited_by, p.name AS invited_by_name, i.created_at FROM invites i JOIN people p ON p.id = i.invited_by";

const toInvite = (r: InviteRow): Invite => ({ id: r.id, email: r.email, role: r.role, invitedBy: { personId: r.invited_by, name: r.invited_by_name }, createdAt: r.created_at });

/**
 * One batch decides which it is, so the email's person can't arrive between the two: they are a
 * member, whose role this changes, or they aren't, and an invite waits for them.
 */
export async function invite(asking: Asking, email: string, role: Role): Promise<Results["member.invite"]> {
  const { db, workspaceId, personId, now } = asking;
  const INVITED = "(SELECT id FROM people WHERE email = ?3)";
  const [changed, made] = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE members SET role = ?4 WHERE workspace_id = ?1 AND person_id = ${INVITED} AND ${STILL_ADMIN}
           AND (?4 = 'admin' OR role <> 'admin' OR EXISTS (SELECT 1 FROM members o WHERE o.workspace_id = ?1 AND o.role = 'admin' AND o.person_id <> members.person_id))
         RETURNING person_id AS id`,
      )
      .bind(workspaceId, personId, email, role),
    // The pending invite for this email keeps its id, so a link already shared still names it.
    db
      .prepare(
        `INSERT INTO invites (id, workspace_id, email, role, invited_by, created_at)
         SELECT ?5, ?1, ?3, ?4, ?2, ?6 WHERE ${STILL_ADMIN} AND NOT EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ?1 AND m.person_id = ${INVITED})
         ON CONFLICT (workspace_id, email) WHERE state = 'pending' DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by
         RETURNING id`,
      )
      .bind(workspaceId, personId, email, role, newId(), now),
    orphaned(asking, { email }),
  ]);
  const member = changed!.results[0];
  if (member) return { member: (await loadMember(db, workspaceId, member.id)) ?? (() => { throw new OpError("not_found", "No such member"); })(), invite: null };
  const pending = made!.results[0];
  if (pending) return { member: null, invite: toInvite((await db.prepare(`SELECT ${INVITE_COLUMNS} WHERE i.id = ?`).bind(pending.id).first<InviteRow>())!) };
  const theirs = await db.prepare("SELECT m.person_id FROM members m JOIN people p ON p.id = m.person_id WHERE m.workspace_id = ? AND p.email = ?").bind(workspaceId, email).first<{ person_id: string }>();
  throw await refusal(asking, "member.invite", theirs?.person_id ?? personId);
}

export async function listInvites(db: D1Database, workspaceId: string): Promise<Invite[]> {
  const { results } = await db.prepare(`SELECT ${INVITE_COLUMNS} WHERE i.workspace_id = ? AND i.state = 'pending' ORDER BY i.created_at, i.id`).bind(workspaceId).all<InviteRow>();
  return results.map(toInvite);
}

/** Revoking twice is fine. An invite that was taken up can't be taken back: that person is a member now. */
export async function revokeInvite(asking: Asking, id: string): Promise<{ id: string }> {
  const { db, workspaceId, personId, now } = asking;
  const { meta } = await db
    .prepare(`UPDATE invites SET state = 'revoked', decided_at = ?4 WHERE id = ?3 AND workspace_id = ?1 AND state = 'pending' AND ${STILL_ADMIN}`)
    .bind(workspaceId, personId, id, now)
    .run();
  if (meta.changes) return { id };
  const row = await db.prepare("SELECT state FROM invites WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<{ state: "pending" | "accepted" | "revoked" }>();
  if (!row) throw new OpError("not_found", "No such invite");
  if (row.state === "accepted") throw new OpError("invalid", "They have already joined. Remove them from the members instead.");
  if (row.state === "revoked") return { id };
  throw await refusal(asking, "invite.revoke", personId);
}
