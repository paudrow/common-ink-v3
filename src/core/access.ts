import { IN_STATE, type Covering } from "./lifecycle.ts";
import type { Role } from "./protocol.ts";

/** What someone may do with a note or a folder. Each level includes the ones before it. */
export type Level = "none" | "view" | "edit";
/** What a grant gives. */
export type GrantLevel = Exclude<Level, "none">;

const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };
const ROLE_LEVEL: Record<Role, GrantLevel> = { admin: "edit", editor: "edit", viewer: "view" };

export const allows = (level: Level, needed: Level) => RANK[level] >= RANK[needed];
const lesser = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);

/** Everything access to one note or folder is decided from. */
export interface Asked {
  /** The role of the one asking in the item's workspace. Null for anyone who isn't a member: a guest, or whoever holds a link. */
  role: Role | null;
  /**
   * The grants that reach the one asking, from the item outward: first the one on the item itself,
   * then the one on the folder it is in, then on that folder's parent, and so on. Null where there is
   * none. A link's grant reaches whoever came by the link.
   */
  grants: readonly (GrantLevel | null)[];
  /** For a private note, whether the one asking is its owner. Null for a note that isn't private, and for a folder. */
  private: "mine" | "theirs" | null;
}

/**
 * What the one asking may do with the item. This is the whole rule:
 *
 * - The nearest grant wins: the one on the item, or else on the closest folder above it.
 * - A member has what their role allows, and a grant can only narrow that. Nothing narrows an admin.
 * - Anyone else has only what the nearest grant gives.
 * - A private note is its owner's as any note of theirs is. For everyone else it is as if they had no
 *   role and the folders above had no grants: only a grant on the note itself lets them in, and a
 *   member still gets no more from it than their role allows.
 */
export function resolve({ role, grants, private: privacy }: Asked): Level {
  const base: Level = role ? ROLE_LEVEL[role] : "none";
  if (privacy === "theirs" || (privacy === "mine" && !role)) {
    const own = grants[0] ?? null;
    if (!own) return "none";
    return role ? lesser(base, own) : own;
  }
  if (role === "admin") return "edit";
  const nearest = grants.find((grant) => grant != null) ?? null;
  if (!role) return nearest ?? "none";
  return nearest ? lesser(base, nearest) : base;
}

/**
 * Whether the one asking may share the item: make and take back grants on it, and its link. A member
 * who can edit it can, other than a private note that is someone else's. The owner of a private note
 * can whatever their role, since nobody else can. A guest can't, whatever their grant.
 */
export const canShare = (asked: Asked): boolean =>
  asked.role !== null && (asked.private === "mine" || ((asked.role === "admin" || asked.role === "editor") && asked.private !== "theirs" && resolve(asked) === "edit"));

/** A grant that reaches the one asking, and what it is on. */
export type Reaching = { access: GrantLevel } & ({ noteId: string; folderId?: undefined } | { folderId: string; noteId?: undefined });

/**
 * What one actor can see and do across a workspace: the single thing every operation asks. It is made
 * once for an operation, from the actor's role and the grants that reach them.
 */
export interface Sight {
  /** The person asking, when they are a member. A private note is its owner's only while they are one. */
  memberId: string | null;
  role: Role | null;
  /** The grant on each note that has one. */
  onNotes: ReadonlyMap<string, GrantLevel>;
  /** For each folder under a grant, the nearest one at or above it. */
  onFolders: ReadonlyMap<string, GrantLevel>;
  /** What {@link SEEN} reads, bound as one value. */
  bind: string;
}

/** A note as access to it is decided. */
export interface NoteFacts {
  id: string;
  /** Null for a note that is going to be made. */
  folder_id: string;
  private_owner: string | null;
}

/** `parents` holds each folder's parent, and null for one at the top. Only folders in it can be under a grant. */
export function sightOf(who: { personId: string | null; role: Role | null }, grants: readonly Reaching[], parents: ReadonlyMap<string, string | null>): Sight {
  const onNotes = new Map<string, GrantLevel>();
  const granted = new Map<string, GrantLevel>();
  for (const grant of grants) {
    if (grant.noteId !== undefined) onNotes.set(grant.noteId, grant.access);
    else granted.set(grant.folderId, grant.access);
  }
  const onFolders = new Map<string, GrantLevel>();
  if (granted.size) {
    for (const id of parents.keys()) {
      // A folder's ancestors are few, and `walked` ends a walk that a loop in them would otherwise never leave.
      const walked = new Set<string>();
      for (let at: string | null | undefined = id; at && !walked.has(at); at = parents.get(at)) {
        walked.add(at);
        const grant = granted.get(at);
        if (grant) {
          onFolders.set(id, grant);
          break;
        }
      }
    }
  }
  const memberId = who.role ? who.personId : null;
  const sight = { memberId, role: who.role, onNotes, onFolders };
  const bind = JSON.stringify({
    owner: memberId,
    all: who.role ? 1 : 0,
    folders: [...parents.keys()].filter((id) => allows(folderLevel(sight, id), "view")),
    notes: [...onNotes.keys()],
  });
  return { ...sight, bind };
}

type Seeing = Pick<Sight, "memberId" | "role" | "onNotes" | "onFolders">;

export const folderAsked = (sight: Seeing, folderId: string): Asked => ({ role: sight.role, grants: [sight.onFolders.get(folderId) ?? null], private: null });

export const noteAsked = (sight: Seeing, note: NoteFacts): Asked => ({
  role: sight.role,
  grants: [sight.onNotes.get(note.id) ?? null, sight.onFolders.get(note.folder_id) ?? null],
  private: note.private_owner === null ? null : note.private_owner === sight.memberId ? "mine" : "theirs",
});

export const folderLevel = (sight: Seeing, folderId: string): Level => resolve(folderAsked(sight, folderId));
export const noteLevel = (sight: Seeing, note: NoteFacts): Level => resolve(noteAsked(sight, note));

/**
 * The one query shape for "which notes is this actor shown": a condition on the notes row named
 * `alias`, true for exactly the notes {@link noteLevel} gives view or more that are in a state
 * `covering` covers. `param` is the placeholder that {@link Sight.bind} is bound to, such as `?2`.
 * Every query that lists notes, or reads anything by way of a note (a change, a link, a count),
 * carries it, and so says which states it means.
 */
export const SEEN = (alias: string, param: string, covering: Covering) =>
  `(${IN_STATE(alias, covering)} AND CASE WHEN ${alias}.private_owner IS NOT NULL AND ${alias}.private_owner IS NOT json_extract(${param}, '$.owner')
      THEN ${alias}.id IN (SELECT value FROM json_each(${param}, '$.notes'))
      ELSE json_extract(${param}, '$.all') = 1
        OR ${alias}.folder_id IN (SELECT value FROM json_each(${param}, '$.folders'))
        OR ${alias}.id IN (SELECT value FROM json_each(${param}, '$.notes'))
    END)`;

/** The same for folders: true for the folders row named `alias` when the actor can see that folder. */
export const SEEN_FOLDER = (alias: string, param: string) => `(json_extract(${param}, '$.all') = 1 OR ${alias}.id IN (SELECT value FROM json_each(${param}, '$.folders')))`;
