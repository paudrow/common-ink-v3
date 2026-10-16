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
  /** Set when an agent limited to folders asks about a folder that is none of them or under none, or a note in one. */
  outside?: boolean;
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
 * - An agent limited to folders has nothing of what is outside them, and of what is inside exactly
 *   what the rules above give its member. The limit only ever takes away.
 */
export function resolve({ role, grants, private: privacy, outside }: Asked): Level {
  if (outside) return "none";
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
  !asked.outside && asked.role !== null && (asked.private === "mine" || ((asked.role === "admin" || asked.role === "editor") && asked.private !== "theirs" && resolve(asked) === "edit"));

/** A grant that reaches the one asking, and what it is on. */
export type Reaching = { access: GrantLevel } & ({ itemId: string; folderId?: undefined } | { folderId: string; itemId?: undefined });

/**
 * What one actor can see and do across a workspace: the single thing every operation asks. It is made
 * once for an operation, from the actor's role and the grants that reach them.
 */
export interface Sight {
  /** The person asking, when they are a member. A private note is its owner's only while they are one. */
  memberId: string | null;
  role: Role | null;
  /** The grant on each note and each upload that has one. Their ids are drawn from one space of 36^12. */
  onItems: ReadonlyMap<string, GrantLevel>;
  /** For each folder under a grant, the nearest one at or above it. */
  onFolders: ReadonlyMap<string, GrantLevel>;
  /** The folders an agent is limited to, each with every folder under it. Null when nothing limits it. */
  within: ReadonlySet<string> | null;
  /** What {@link SEEN} reads, bound as one value. */
  bind: string;
}

/** An item in a folder, a note or an upload, as access to it is decided. Both are decided the same way. */
export interface ItemFacts {
  id: string;
  folder_id: string;
  private_owner: string | null;
}

/** For each folder, what `marked` holds for the nearest folder at or above it that it holds anything for. */
function nearest<T>(parents: ReadonlyMap<string, string | null>, marked: ReadonlyMap<string, T>): Map<string, T> {
  const found = new Map<string, T>();
  if (!marked.size) return found;
  for (const id of parents.keys()) {
    // A folder's ancestors are few, and `walked` ends a walk that a loop in them would otherwise never leave.
    const walked = new Set<string>();
    for (let at: string | null | undefined = id; at && !walked.has(at); at = parents.get(at)) {
      walked.add(at);
      const mark = marked.get(at);
      if (mark !== undefined) {
        found.set(id, mark);
        break;
      }
    }
  }
  return found;
}

/**
 * `parents` holds each folder's parent, and null for one at the top. Only folders in it can be under
 * a grant, or inside `limit`: the folders an agent is limited to, or null for an actor nothing limits.
 * A folder in `limit` that isn't in `parents` (deleted, or another workspace's) stands for nothing.
 */
export function sightOf(who: { personId: string | null; role: Role | null }, grants: readonly Reaching[], parents: ReadonlyMap<string, string | null>, limit: readonly string[] | null = null): Sight {
  const onItems = new Map<string, GrantLevel>();
  const granted = new Map<string, GrantLevel>();
  for (const grant of grants) {
    if (grant.itemId !== undefined) onItems.set(grant.itemId, grant.access);
    else granted.set(grant.folderId, grant.access);
  }
  const onFolders = nearest(parents, granted);
  const within = limit && new Set(nearest(parents, new Map(limit.map((id) => [id, true]))).keys());
  const memberId = who.role ? who.personId : null;
  const sight = { memberId, role: who.role, onItems, onFolders, within };
  const bind = JSON.stringify({
    owner: memberId,
    all: who.role && !within ? 1 : 0,
    folders: [...parents.keys()].filter((id) => allows(folderLevel(sight, id), "view")),
    items: [...onItems.keys()],
    within: within && [...within],
  });
  return { ...sight, bind };
}

type Seeing = Pick<Sight, "memberId" | "role" | "onItems" | "onFolders" | "within">;

const outside = (sight: Seeing, folderId: string) => sight.within !== null && !sight.within.has(folderId);

/** Whether the actor sees every folder there is, so may be told a name is taken, and has the top of the workspace to put a folder in. A guest doesn't, nor an agent limited to folders. */
export const seesEveryFolder = (sight: Seeing) => sight.role !== null && sight.within === null;

export const folderAsked = (sight: Seeing, folderId: string): Asked => ({ role: sight.role, grants: [sight.onFolders.get(folderId) ?? null], private: null, outside: outside(sight, folderId) });

export const itemAsked = (sight: Seeing, item: ItemFacts): Asked => ({
  role: sight.role,
  grants: [sight.onItems.get(item.id) ?? null, sight.onFolders.get(item.folder_id) ?? null],
  private: item.private_owner === null ? null : item.private_owner === sight.memberId ? "mine" : "theirs",
  outside: outside(sight, item.folder_id),
});

export const folderLevel = (sight: Seeing, folderId: string): Level => resolve(folderAsked(sight, folderId));
export const itemLevel = (sight: Seeing, item: ItemFacts): Level => resolve(itemAsked(sight, item));

/**
 * The one query shape for "which notes is this actor shown", and which uploads: a condition on the
 * row of `notes` or `uploads` named `alias`, true for exactly the ones {@link itemLevel} gives view
 * or more that are in a state `covering` covers. An upload still arriving or being removed is in no
 * state anything covers. `param` is the placeholder that {@link Sight.bind} is bound to, such as `?2`.
 * Every query that lists notes, or reads anything by way of a note (a change, a link, a count),
 * carries it, and so says which states it means.
 */
export const SEEN = (alias: string, param: string, covering: Covering) =>
  `(${IN_STATE(alias, covering)} AND (json_extract(${param}, '$.within') IS NULL OR ${alias}.folder_id IN (SELECT value FROM json_each(${param}, '$.within'))) AND CASE WHEN ${alias}.private_owner IS NOT NULL AND ${alias}.private_owner IS NOT json_extract(${param}, '$.owner')
      THEN ${alias}.id IN (SELECT value FROM json_each(${param}, '$.items'))
      ELSE json_extract(${param}, '$.all') = 1
        OR ${alias}.folder_id IN (SELECT value FROM json_each(${param}, '$.folders'))
        OR ${alias}.id IN (SELECT value FROM json_each(${param}, '$.items'))
    END)`;

/** The same for folders: true for the folders row named `alias` when the actor can see that folder. */
export const SEEN_FOLDER = (alias: string, param: string) => `(json_extract(${param}, '$.all') = 1 OR ${alias}.id IN (SELECT value FROM json_each(${param}, '$.folders')))`;
