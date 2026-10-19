import { ChangeSet, MapMode } from "@codemirror/state";
import { z } from "zod";
import { blame, runsOfLines } from "./blame.ts";
import type { ConnectedAgent } from "./agents.ts";
import { SEEN, SEEN_FOLDER, allows, canShare, folderLevel, itemAsked, itemLevel, seesEveryFolder, type GrantLevel, type Sight } from "./access.ts";
import { dailySettings, dailyText, dayFor, filedOn, type DailySettings } from "./daily.ts";
import { lineDiff, textDiff } from "./diff.ts";
import { atPath, nameKey as folderKey, pathsOf } from "./folder-names.ts";
import { following as lineFollowing } from "./follow.ts";
import { dayIn, dayStartIn, linesAsOf, rebased, redoTarget, revertOfAuthor, revertedBy, revertible, reverting, runsOf, settledRevert, undoTarget, type Choice, type Resolution, type Reverting, type Step } from "./history.ts";
import { IN_TRASH, listing, purgesAt, type Covering, type NoteState, type Trashed } from "./lifecycle.ts";
import { newId } from "./ids.ts";
import { isNoteId, linkedIds, linksIn, retargeted } from "./links.ts";
import { summarize } from "./markdown.ts";
import { isPersonId, mentionIndex, mentionKey, mentionName, mentionsIn, mentionsOn, personKey, rementioned, writtenMention, type WrittenMention } from "./mentions.ts";
import { invite, leave, listInvites, listMembers, removeMember, revokeInvite, setRole, signOut, type Asking } from "./membership.ts";
import {
  NO_SUCH_WORKSPACE,
  MAX_NOTE_LENGTH,
  MAX_SETTINGS_LENGTH,
  Op,
  OpError,
  TODO_SORTS,
  TODO_SORT_WORDS,
  type Author,
  type AuthorRef,
  type ChangeEntry,
  type DiffRun,
  type Folder,
  type HistoryEntry,
  type Linked,
  type LinkedNote,
  type LinkTitles,
  type ListedFolder,
  type NoteAbout,
  type ListedTodo,
  type Mentioned,
  type Note,
  type NoteDiff,
  type NoteRevertPreview,
  type RevertConflict,
  type NoteSummary,
  type OpInput,
  type OpType,
  type PersonPage,
  type Member as MemberCard,
  type Results,
  type Resolve,
  type RevertedNotes,
  type Reverts,
  type Role,
  type SharedNote,
  type TrashedNote,
  type TodoSort,
  type UnresolvedLink,
  type Visit,
  type Written,
} from "./protocol.ts";
import { ownSandboxed } from "./ownPlugins.ts";
import { codeHash, scaffold, validate } from "./plugins.ts";
import { actingPlugin, discardDraft, framePlugin, installPlugin, listDrafts, listPlugins, permitPlugin, readDraft, readPlugin, requestPlugin, saveDraft, trustPlugin, uninstallPlugin } from "./pluginRecord.ts";
import { removing, forgetRemoved } from "./purge.ts";
import { uploadIds } from "./uploadRefs.ts";
import { NO_FILES, abortUpload, archiveUpload, createUpload, finishUpload, listUploads, moveUpload, openUpload, placeUpload, purgeUpload, putPart, readUpload, referred, restoreUpload, resumeUpload, startUpload, trashUpload, trashedUploads, uploadStorage, type Files } from "./uploads.ts";
import { FILTERS, MAX_BOUND, PRIORITIES, conditionOf, dayOf, folded, isRelative, matchOf, names, orderOf, parse, shift, soughtIn, topTerms, walk, written as writtenValue, type Bound, type Compiling, type Filter, type Node, type Query, type Scope } from "./query.ts";
import { matchesIn } from "./search.ts";
import { linkTo, listGrants, revokeGrant, setGrant, setPrivate, setUploadPrivate } from "./sharing.ts";
import { noteSlug } from "./slug.ts";
import { NO_SOURCES, calendarFor, calendarSettings, contactCards, createContact, createEvent, listContacts, listEvents, listSources, photoContact, readRecord, referencesTo, refer, updateContact, updateEvent, type Sources } from "./sources.ts";
import { referencesIn } from "./references.ts";
import { NO_SUCH_LINK, standingByLink, standingIn, type Standing as ActorStanding } from "./standing.ts";
import { applyChanges, changesBetween } from "./text.ts";
import { ruleLabel } from "./recurrence.ts";
import { changeTodo, checkedOff, completeTodo, nameKey, parseTodo, rolledForward, tagsBesides, todoIndex, todosIn, type Completed } from "./todos.ts";

/** Who is performing an operation, and where. */
export type Actor =
  /** A signed-in person, in a workspace they are a member of or a guest in. */
  | { kind: "member"; personId: string; workspaceId: string }
  /** An agent acts as `personId`: their role and grants in the workspace, so their access, and no more. */
  | { kind: "agent"; agentId: string; personId: string; workspaceId: string; scope?: AgentScope }
  /**
   * A plugin installed in the workspace, running in `personId`'s browser. It acts as them and within
   * what the workspace permits it, so it has no more than either. `pluginId` is the install the app
   * made the plugin's frame for, and never anything the plugin said. With `draft` it is that
   * person's own copy of the plugin, which runs for nobody else. One an admin granted full trust,
   * and that this person turned on, runs inside the app: it may perform what the member may, as
   * them, except what is the member's alone.
   */
  | { kind: "plugin"; pluginId: string; personId: string; workspaceId: string; draft?: boolean };

/** Whoever holds a link, signed in or not. The link says which workspace, and what in it they can read. */
export interface Visitor {
  kind: "visitor";
  token: string;
  personId: string | null;
}

/** What narrows an agent's token below its member: one workspace, no changes, and only some folders. */
export interface AgentScope {
  pinnedWorkspaceId?: string | null;
  readOnly?: boolean;
  /** The folders it is limited to, each with the folders under it. Null or left out for every note its member can reach. */
  folderIds?: readonly string[] | null;
}

/**
 * The actor an agent's token stands for in a workspace, with everything that narrows it. Every way
 * in makes it here: one that spelled the scope out itself left the folder limit behind.
 */
export const agentActor = (agent: ConnectedAgent, workspaceId: string): Extract<Actor, { kind: "agent" }> => ({
  kind: "agent",
  agentId: agent.agentId,
  personId: agent.personId,
  workspaceId,
  scope: { pinnedWorkspaceId: agent.workspaceId, readOnly: agent.readOnly, folderIds: agent.folderIds },
});

export const authorId = ({ author }: Context) => (author.kind === "agent" ? author.agentId : author.kind === "plugin" ? author.pluginId : author.personId);
/** The member an agent or a plugin is acting for, which is kept beside what it wrote. A plugin acts for every member, so nothing else says. */
const authorOwner = ({ author }: Context) => (author.kind === "member" ? null : author.onBehalfOf);

export interface Context {
  db: D1Database;
  actor: Actor | Visitor;
  author: Author;
  /** True for a plugin that runs shut off from the app, which is told only what its permissions name: nothing of uploads or of who a mention means. One running with full trust is told what its member is. */
  shutOff: boolean;
  workspaceId: string;
  /** The person acting, or the person an agent acts for. Null for whoever opened a link. */
  personId: string | null;
  /** Their role, or null for a guest and for whoever opened a link. */
  role: Role | null;
  /** What they can see and do. Every read of a note or a folder is checked against it. */
  sight: Sight;
  now: number;
  /** Where the asker's data sources come from. */
  sources: Sources;
  /** Where uploads' bytes are kept, and the bytes that came with this operation. */
  files: Files;
}

type Access = "view" | "edit" | "manage";
const ALLOWS: Record<ActorStanding["most"], ReadonlySet<Access>> = {
  manage: new Set(["view", "edit", "manage"]),
  edit: new Set(["view", "edit"]),
  view: new Set(["view"]),
};

type Handler<K extends OpType> = {
  /**
   * The most the operation needs of anything, which someone who has that of nothing is refused for
   * before it runs. What it needs of each note and folder it touches is asked by `loadNote` and
   * `loadFolder`, and of the notes it lists by `SEEN`.
   */
  needs: Access;
  /**
   * Who alone may ask. `member`: the person themself, signed in, and not an agent acting for them.
   * `owner`: the person, or an agent of theirs acting in their role, and never a plugin.
   * `visitor`: whoever holds a link, who may ask nothing else.
   */
  by?: "member" | "owner" | "visitor";
  /** Set when only a member of the workspace may ask, and one who sees all of it: not a guest, and not an agent limited to folders. */
  members?: true;
  /** Set when it changes something though it needs no more than `view` of the workspace, so a read-only token is refused it. */
  changes?: true;
  /** Set when it answers from what is the asker's own and in no folder, as their data sources are and how far they have read: an agent limited to folders is refused it. */
  own?: true;
  run: (ctx: Context, op: Extract<Op, { type: K }>) => Promise<Results[K]>;
};

/** Every operation on a workspace. The web app, CLI, and MCP server all come through here. */
export async function perform<T extends OpInput>(db: D1Database, actor: Actor | Visitor, input: T, now = Date.now(), sources: Sources = NO_SOURCES, files: Files = NO_FILES): Promise<Results[T["type"]]> {
  const parsed = Op.safeParse(input);
  if (!parsed.success) throw new OpError("invalid", z.prettifyError(parsed.error));
  const op = parsed.data;
  const handler = HANDLERS[op.type] as Handler<OpType>;

  if (actor.kind === "agent" && actor.scope?.pinnedWorkspaceId && actor.scope.pinnedWorkspaceId !== actor.workspaceId) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  const standing = actor.kind === "visitor" ? await standingByLink(db, actor.token, actor.personId) : await standingIn(db, actor.personId, actor.workspaceId, actor.kind === "agent" ? (actor.scope?.folderIds ?? null) : null);
  if (!standing) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  // Whoever holds a link is let into the operations made for them and no other, whatever is added later.
  if ((actor.kind === "visitor") !== (handler.by === "visitor")) throw new OpError("forbidden", actor.kind === "visitor" ? `A link can't ${op.type}` : `Only a link can ${op.type}`);
  if (actor.kind === "agent" && handler.by === "member") throw new OpError("forbidden", `An agent can't ${op.type}`);
  if (actor.kind === "agent" && actor.scope?.readOnly && (handler.needs !== "view" || handler.changes)) throw new OpError("forbidden", `A read-only token can't ${op.type}`);
  if ((handler.members || handler.own) && standing.sight.within) throw new OpError("forbidden", `An agent limited to folders can't ${op.type}`);
  // A plugin is refused everything but what a permission it was given names. Members run plugins, so a guest's is refused whatever it asks, before anything is said of the plugin.
  // The plugins that come with Common Ink are the app's, so a guest's app has them too: each acts as the guest, within what it declares. A draft is a member's.
  const runsPlugins = standing.role !== null || (actor.kind === "plugin" && !actor.draft && ownSandboxed(actor.pluginId) !== null);
  const plugin = actor.kind === "plugin" && runsPlugins ? await actingPlugin(db, standing.workspaceId, actor.pluginId, actor.personId, actor.draft) : null;
  if (actor.kind === "plugin") {
    if (!plugin) throw new OpError("forbidden", `A ${standing.as} runs no plugins: they are for the workspace's members`);
    if ("refused" in plugin) throw new OpError("forbidden", plugin.refused);
    // What is the member's alone is no plugin's, full trust or not: it is asked in the member's own name, where their role is what is checked.
    if (handler.by === "member" || handler.by === "owner" || (plugin.allowed !== "all" && !plugin.allowed.has(op.type))) throw new OpError("forbidden", `${plugin.name} isn't permitted to ${op.type}`);
  }
  if ((handler.members && !standing.role) || !ALLOWS[standing.most].has(handler.needs)) throw new OpError("forbidden", `A ${standing.as} can't ${op.type}`);

  let author: Author = { kind: "member", personId: standing.personId ?? "", name: standing.name };
  if (actor.kind === "agent") {
    const agent = await db.prepare("SELECT name FROM agents WHERE id = ?").bind(actor.agentId).first<{ name: string }>();
    author = { kind: "agent", agentId: actor.agentId, name: agent?.name ?? "An agent", onBehalfOf: actor.personId };
  }
  if (actor.kind === "plugin") author = { kind: "plugin", pluginId: actor.pluginId, name: (plugin as { name: string }).name, onBehalfOf: actor.personId };
  const shutOff = plugin !== null && "allowed" in plugin && plugin.allowed !== "all";
  const ctx: Context = { db, actor, author, shutOff, workspaceId: standing.workspaceId, personId: standing.personId, role: standing.role, sight: standing.sight, now, sources, files };
  return handler.run(ctx, op as never) as Promise<Results[T["type"]]>;
}

/**
 * A full-trust plugin's code, for the app's page to load as a module from its own address: the page's
 * policy allows script only from there, and no `eval`. It is answered only to a member it runs for now,
 * and only when `hash` is the code the admin's grant and their own turning on are both of. Null
 * otherwise, which says nothing of why: the member reads the code as text by `plugin.read`.
 */
export async function trustedCode(db: D1Database, actor: Extract<Actor, { kind: "member" }>, pluginId: string, hash: string): Promise<string | null> {
  // Asked as the member first, so a guest, a stranger or someone removed is answered as for no plugin.
  if (!(await perform(db, actor, { type: "plugin.read", id: pluginId }).catch(() => null))) return null;
  const acting = await actingPlugin(db, actor.workspaceId, pluginId, actor.personId);
  if (!("allowed" in acting) || acting.allowed !== "all") return null;
  // The code is read in one statement with the member's own row for that same code, which an update, a revocation or turning it off deletes.
  const row = await db
    .prepare(
      `SELECT i.code FROM plugin_installs i JOIN plugin_trust t ON t.workspace_id = i.workspace_id AND t.plugin_id = i.id AND t.person_id = ?3 AND t.code_hash = i.code_hash
       WHERE i.id = ?1 AND i.workspace_id = ?2 AND i.removed_at IS NULL AND i.code_hash = ?4`,
    )
    .bind(pluginId, actor.workspaceId, actor.personId, hash)
    .first<{ code: string }>();
  // What is served is the code of that hash as it is worked out here, not as it was stored.
  return row && (await codeHash(row.code)) === hash ? row.code : null;
}

interface SummaryRow {
  /** The note's text, for a note whose title and snippet were stored by an older rule and that `mend` hasn't come to yet. They are read from it. */
  unmade?: string | null;
  id: string;
  folder_id: string;
  revision: number;
  title: string;
  snippet: string;
  open_todos: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
  updated_by_kind: AuthorRef["kind"];
  updated_by_name: string | null;
  updated_by_owner: string | null;
  private_owner: string | null;
  state: NoteState;
  /** When its state last changed: when it was archived, trashed, unarchived or restored. Null for a note that has only ever been live. */
  state_at: number | null;
}

export interface NoteRow extends SummaryRow {
  text: string;
  /** The person who made it, or whose agent did. Null for a note made before that was kept. */
  created_by: string | null;
  /** Below {@link MADE} for a note whose links, todos and search text haven't been made from its text since there were tables for them. */
  indexed: number;
  /** For a note in Trash: the state it had, and the folder it was in. */
  restores_as?: "live" | "archived" | null;
  restores_to?: string | null;
}

/** What a note's `indexed` is once its title and snippet, its links, todos, tags, mentions, search text and the uploads it refers to have been made from its text as they are made now. */
const MADE = 8;

/** A note as it is made: live. */
const NEW = { state: "live", state_at: null } as const;

/**
 * Who an author is, for a row that names one by kind and id: `name` and `owner` from the joins that
 * `named` writes. A plugin is named from its install, which outlasts its being uninstalled, and the
 * member it acted for is whoever the row itself says, since a plugin acts for every member.
 */
const NAME = "COALESCE(p.name, a.name, json_extract(pi.manifest, '$.name'))";
const named = (kind: string, id: string) =>
  `LEFT JOIN people p ON ${kind} = 'member' AND p.id = ${id}
   LEFT JOIN agents a ON ${kind} = 'agent' AND a.id = ${id}
   LEFT JOIN plugin_installs pi ON ${kind} = 'plugin' AND pi.id = ${id}`;

const SUMMARY_COLUMNS = `CASE WHEN n.indexed < ${MADE} THEN n.text END AS unmade, n.id, n.folder_id, n.revision, n.title, n.snippet, n.open_todos, n.created_at, n.updated_at, n.updated_by, n.updated_by_kind, n.private_owner, n.state, n.state_at,
    ${NAME} AS updated_by_name, COALESCE(a.person_id, n.updated_by_owner) AS updated_by_owner
  FROM notes n
  ${named("n.updated_by_kind", "n.updated_by")}`;

/** The member, agent or plugin a change or a note names by the kind and id stored with it. */
export const authorOf = (kind: string, id: string, name: string | null, owner: string | null): Author =>
  kind === "agent"
    ? { kind: "agent", agentId: id, name: name ?? "An agent", onBehalfOf: owner ?? "" }
    : kind === "plugin"
      ? { kind: "plugin", pluginId: id, name: name ?? "A plugin", onBehalfOf: owner ?? "" }
      : { kind: "member", personId: id, name: name ?? "Someone" };

/** A note as the one asking is told of it. Only a row they can see is ever handed here. */
export const toSummary = (ctx: Context, stored: SummaryRow): NoteSummary => summaryOf(ctx, typeof stored.unmade === "string" ? { ...stored, ...made(stored.unmade) } : stored);

function made(text: string) {
  const { title, snippet, openTodos } = summarize(text);
  return { title, snippet, open_todos: openTodos };
}

/** A note's row as it was read, with its title and snippet by today's rule, so whatever is made from the row starts from them. */
function current<T extends NoteRow | null>(row: T): T {
  if (row && typeof row.unmade === "string") Object.assign(row, made(row.text), { unmade: null });
  return row;
}

const summaryOf = (ctx: Context, row: SummaryRow): NoteSummary => ({
  id: row.id,
  title: row.title,
  slug: noteSlug(row.title),
  folderId: allows(folderLevel(ctx.sight, row.folder_id), "view") ? row.folder_id : null,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: authorOf(row.updated_by_kind, row.updated_by, row.updated_by_name, row.updated_by_owner),
  snippet: row.snippet,
  openTodos: row.open_todos,
  access: itemLevel(ctx.sight, row) === "edit" ? "edit" : "view",
  private: row.private_owner !== null,
  state: row.state,
  purgesAt: row.state === "trashed" && row.state_at !== null ? purgesAt(row.state_at) : null,
  stateAt: row.state_at,
});

/** A note as whoever holds a link is told of it: nothing of who wrote it, or of how it is shared. */
function toShared(ctx: Context, row: SummaryRow, within: (folderId: string | null) => string | null): SharedNote {
  const { id, title, slug, folderId, updatedAt, snippet } = toSummary(ctx, row);
  return { id, title, slug, folderId: within(folderId), updatedAt, snippet };
}

function toNote(ctx: Context, row: NoteRow, text = row.text, revision = row.revision): Note {
  if (text !== row.text) row = { ...row, ...made(text) };
  return { ...toSummary(ctx, row), revision, text };
}

/** The columns every change to a note's text sets. */
function written(ctx: Context, text: string) {
  const { title, snippet, openTodos } = summarize(text);
  const { author } = ctx;
  return {
    text,
    title,
    snippet,
    open_todos: openTodos,
    updated_at: ctx.now,
    updated_by: authorId(ctx),
    updated_by_kind: ctx.author.kind,
    updated_by_name: author.name,
    updated_by_owner: authorOwner(ctx),
  };
}

const kindOf = (by: "people" | "agents" | undefined) => (by === "people" ? "member" : by === "agents" ? "agent" : null);

const sameAuthor = (a: AuthorRef, b: AuthorRef) => a.kind === b.kind && a.id === b.id;
const isBy = (ctx: Context, author: AuthorRef) => sameAuthor(author, { kind: ctx.author.kind, id: authorId(ctx) });

const NO_SUCH_NOTE = "No such note";
const NOT_DISCARDED = "Only a note you made that has never had anything in it but spaces or a lone # is discarded. Move it to Trash instead.";
/** Whether a note's text says nothing: spaces and line breaks, and at most the mark of a title. */
export const blank = (text: string) => /^#?$/.test(text.trim());
const NO_SUCH_FOLDER = "No such folder";

/** The folder bound as ?4 and every folder under it, for a listing narrowed to a folder. */
const UNDER = "WITH RECURSIVE under (id) AS (SELECT ?4 UNION SELECT f.id FROM folders f JOIN under u ON f.parent_id = u.id)";

const CANT_CHANGE = "You can read this note, and not change it";

/**
 * The note, for someone who may do `need` with it. This is the one place a single note is read, so
 * it is where a note the actor can't see is the same as no note at all, and where every operation
 * says what it does with a note in Trash. Who is asking is settled first: only someone who may do
 * `need` with the note is ever told it is in Trash.
 */
export async function loadNote(ctx: Context, id: string, need: GrantLevel, trashed: Trashed): Promise<NoteRow> {
  const row = current(
    await ctx.db
      .prepare(`SELECT n.text, n.created_by, n.indexed, n.restores_as, n.restores_to, ${SUMMARY_COLUMNS} WHERE n.id = ? AND n.workspace_id = ?`)
      .bind(id, ctx.workspaceId)
      .first<NoteRow>(),
  );
  const level = row ? itemLevel(ctx.sight, row) : "none";
  if (!row || level === "none" || (row.state === "trashed" && trashed === "hidden")) throw new OpError("not_found", NO_SUCH_NOTE);
  if (!allows(level, need)) throw new OpError("forbidden", CANT_CHANGE);
  if (row.state === "trashed" && trashed === "refused") throw new OpError("conflict", IN_TRASH);
  return row;
}

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  unsorted: number;
}

const FOLDER_COLUMNS = "f.id, f.parent_id, f.name, f.id = w.unsorted_folder_id AS unsorted FROM folders f JOIN workspaces w ON w.id = f.workspace_id";

/** A folder as the one asking is told of it: one whose parent they can't see is at the top for them. */
const toFolder = (ctx: Context, row: FolderRow): Folder => ({ id: row.id, name: row.name, parentId: row.parent_id && allows(folderLevel(ctx.sight, row.parent_id), "view") ? row.parent_id : null });

/**
 * The folder `id` in the actor's workspace, or its Unsorted folder when `id` is undefined, for
 * someone who may do `need` with it. The one place a single folder is read, as `loadNote` is for a note.
 */
export async function loadFolder(ctx: Context, id: string | undefined, need: GrantLevel): Promise<FolderRow> {
  const row = await ctx.db
    .prepare(`SELECT ${FOLDER_COLUMNS} WHERE f.workspace_id = ? AND f.id = COALESCE(?, w.unsorted_folder_id)`)
    .bind(ctx.workspaceId, id ?? null)
    .first<FolderRow>();
  const level = row ? folderLevel(ctx.sight, row.id) : "none";
  // Unsorted is no secret, so an agent that named no folder is told why it has none to fall back on.
  if (row && level === "none" && id === undefined && ctx.sight.within) throw new OpError("invalid", "Say which folder: this agent is limited to folders, and Unsorted isn't one of them");
  if (!row || level === "none") throw new OpError("not_found", NO_SUCH_FOLDER);
  if (!allows(level, need)) throw new OpError("forbidden", "You can read this folder, and not change it");
  return row;
}

/** The folders the asker can see, each with its path, and which they may change. */
async function listFolders(ctx: Context): Promise<{ unsortedId: string | null; folders: ListedFolder[] }> {
  const { results } = await ctx.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id AND ${SEEN("n", "?2", "live")}) AS note_count,
         (SELECT COUNT(*) FROM uploads u WHERE u.folder_id = f.id AND ${SEEN("u", "?2", "live")}) AS upload_count, ${FOLDER_COLUMNS}
       WHERE f.workspace_id = ?1 AND ${SEEN_FOLDER("f", "?2")} ORDER BY f.name COLLATE NOCASE, f.id`,
    )
    .bind(ctx.workspaceId, ctx.sight.bind)
    .all<FolderRow & { note_count: number; upload_count: number }>();
  const folders = results.map((row) => toFolder(ctx, row));
  const paths = pathsOf(folders);
  return {
    unsortedId: results.find((row) => row.unsorted)?.id ?? null,
    folders: results.map((row, i) => ({ ...folders[i]!, noteCount: row.note_count, uploadCount: ctx.shutOff ? 0 : row.upload_count, access: folderLevel(ctx.sight, row.id) === "edit" ? "edit" : "view", path: paths.get(row.id)! })),
  };
}

/**
 * Every folder in `parentId`, or at the top of the workspace when it is null, whether or not the
 * asker can see it: a name is taken by a folder they can't see too. Folders made before names had
 * keys have none, so the names are compared here and the index on keys only settles a race.
 */
async function siblings(ctx: Context, parentId: string | null): Promise<{ id: string; name: string }[]> {
  const { results } = await ctx.db.prepare("SELECT id, name FROM folders WHERE workspace_id = ? AND parent_id IS ?").bind(ctx.workspaceId, parentId).all<{ id: string; name: string }>();
  return results;
}

/** A write naming a folder or putting something in one, whose folder may have been deleted since it was loaded. */
export async function intoFolder<T>(write: Promise<T>, name?: string): Promise<T> {
  try {
    return await write;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/FOREIGN KEY constraint failed/.test(message)) throw new OpError("not_found", NO_SUCH_FOLDER);
    if (/UNIQUE constraint failed: index 'folders_by_(name|key)'/.test(message)) throw new OpError("invalid", `There's already a folder named "${name}" here`);
    throw err;
  }
}

/**
 * The notes the actor can see among those `among` selects by id, latest change first. The other end
 * of a link is only ever read through here: a backlink, a linked note's title, a title to link by.
 * So a note the actor can't see is left out of all three by narrowing this one query.
 */
export async function seenAmong(ctx: Context, covering: Covering, among: string, ...binds: unknown[]): Promise<SummaryRow[]> {
  const { results } = await ctx.db
    .prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (${among}) AND ${SEEN("n", `?${binds.length + 2}`, covering)} ORDER BY n.updated_at DESC, n.id`)
    .bind(ctx.workspaceId, ...binds, ctx.sight.bind)
    .all<SummaryRow>();
  return results;
}

const IDS_IN = "SELECT value FROM json_each(?2)";

/** Each note `text` links to by id, with its title and state now for the ones the actor is shown. */
async function linksOf(ctx: Context, text: string, covering: Covering): Promise<LinkedNote[]> {
  const ids = linkedIds(text);
  const seen = new Map(ids.length ? (await seenAmong(ctx, covering, IDS_IN, JSON.stringify(ids))).map((r) => [r.id, r]) : []);
  return ids.map((id) => ({ id, title: seen.get(id)?.title ?? null, state: seen.get(id)?.state ?? null }));
}

const quoted = (title: string) => JSON.stringify(title);

/**
 * The text with each link the write introduces stored by its note's id. A write introduces a link
 * when no link in `base`, the text it was based on, has the same target as written. So a link the
 * note already had is left exactly as it is, wherever in the note it now stands and however often,
 * and a writer is only ever refused for a link they wrote themselves. A new target is looked up as
 * an id and as a title: a note with that id is the one meant, and otherwise the one note so titled.
 * A note in Trash is never the one meant. An archived note is, by its id, and by its title when no
 * live note has that title.
 * A target that is neither is left as written and named in `unresolved`, or refused when `how` is
 * `resolve-strict`.
 */
async function linkedById(ctx: Context, text: string, base: string, how: LinkTitles): Promise<{ text: string; unresolved: UnresolvedLink[] }> {
  if (how === "keep") return { text, unresolved: [] };
  const had = new Set(linksIn(base).map((link) => link.target));
  const introduced = [...new Set(linksIn(text).map((link) => link.target))].filter((target) => !had.has(target));
  if (!introduced.length) return { text, unresolved: [] };
  // A title is looked up as it is made now, for a note last written under an older rule too.
  await mend(ctx);
  // Each title as written and in lower case: the database folds case for unaccented letters only.
  const found = await seenAmong(
    ctx,
    "kept",
    "SELECT t.id FROM notes t WHERE t.workspace_id = ?1 AND (t.id IN (SELECT value FROM json_each(?2)) OR t.title COLLATE NOCASE IN (SELECT value FROM json_each(?3)))",
    JSON.stringify(introduced.filter(isNoteId)),
    JSON.stringify(introduced.flatMap((target) => [target, target.toLowerCase()])),
  );
  const ids = new Set(found.map((row) => row.id));
  const byTitle = Map.groupBy(found, (row) => row.title.toLowerCase());
  const unresolved = new Map<string, UnresolvedLink>();
  const stored = retargeted(text, (target) => {
    if (had.has(target) || ids.has(target)) return undefined;
    const titled = byTitle.get(target.toLowerCase()) ?? [];
    const live = titled.filter((n) => n.state === "live");
    const notes = live.length ? live : titled;
    if (notes.length === 1) return notes[0]!.id;
    if (how === "resolve") {
      unresolved.set(target, { target, matches: notes.map((n) => n.id) });
      return undefined;
    }
    if (notes.length > 1) throw new OpError("invalid", `${notes.length} notes are titled ${quoted(target)}: ${notes.map((n) => n.id).join(", ")}. Link the one you mean as [[id]].`);
    throw new OpError("invalid", `No note ${isNoteId(target) ? "has the id or the title" : "is titled"} ${quoted(target)}. Link a note by its title or as [[id]], with ids from the list of notes, or leave out linkTitles "resolve-strict" to keep [[${target}]] as written.`);
  });
  if (stored.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With its links stored by id, the note would be over ${MAX_NOTE_LENGTH} characters`);
  return { text: stored, unresolved: [...unresolved.values()] };
}

type Member = { id: string; name: string };

/**
 * The members of the workspace among `targets`, each a person's id or a name, ignoring case. None
 * for an asker who isn't told who is in the workspace, a guest or an agent limited to folders: not
 * by a name that came back as an id any more than by a list. None for a plugin either, whatever it was
 * permitted: reading or writing notes is not being told who the members are.
 */
async function membersMeant(ctx: Context, targets: readonly string[]): Promise<{ byId: Map<string, Member>; byName: Map<string, Member[]> }> {
  const asked = [...new Set(targets)];
  if (!seesEveryFolder(ctx.sight) || ctx.shutOff || !asked.length) return { byId: new Map(), byName: new Map() };
  // Each name as written and in lower case: the database folds case for unaccented letters only.
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.name FROM members m JOIN people p ON p.id = m.person_id
       WHERE m.workspace_id = ?1 AND (p.id IN (SELECT value FROM json_each(?2)) OR p.name COLLATE NOCASE IN (SELECT value FROM json_each(?3))) ORDER BY p.id`,
    )
    .bind(ctx.workspaceId, JSON.stringify(asked.filter(isPersonId)), JSON.stringify(asked.flatMap((target) => [target, target.toLowerCase()])))
    .all<Member>();
  return { byId: new Map(results.map((m) => [m.id, m])), byName: Map.groupBy(results, (m) => m.name.toLowerCase()) };
}

/** The one member a name or an id means, or undefined when it is nobody's. Refused when the name is several members'. */
function memberMeant(found: Awaited<ReturnType<typeof membersMeant>>, target: string): Member | undefined {
  const byId = found.byId.get(target);
  if (byId) return byId;
  const members = found.byName.get(target.toLowerCase()) ?? [];
  if (members.length > 1) throw new OpError("invalid", `${members.length} members are named ${quoted(target)}: ${members.map((m) => m.id).join(", ")}. Mention the one you mean as @[[id]], with ids from member.list.`);
  return members[0];
}

/** Who a mention is of, as the asker may be told: a member by their name now, and anyone else by the name as written. */
const mentioned = (members: ReadonlyMap<string, Member>, who: string, name: string): Mentioned => {
  const member = members.get(who);
  return { id: isPersonId(who) ? who : null, name: member?.name ?? name, member: member !== undefined };
};

/** Each person `mentions` are of, once, in the order they first appear. */
function mentionedIn(members: ReadonlyMap<string, Member>, mentions: readonly WrittenMention[]): Mentioned[] {
  const first = new Map<string, WrittenMention>();
  for (const mention of mentions) if (!first.has(mentionKey(mention))) first.set(mentionKey(mention), mention);
  return [...first].map(([who, mention]) => mentioned(members, who, mentionName(mention)));
}

/** Each person `text` mentions. */
async function mentionsOf(ctx: Context, text: string): Promise<Mentioned[]> {
  const mentions = mentionsIn(text);
  return mentionedIn((await membersMeant(ctx, mentions.map((m) => m.target).filter(isPersonId))).byId, mentions);
}

/**
 * The text with each mention the write introduces that is of a member stored by that member's id,
 * with their name: `@[[Ada Lovelace]]` and `@[[id]]` both become `@[[id|Ada Lovelace]]`. As with a
 * link, a write introduces a mention when no mention in `base` has the same target as written, so
 * one the note already had is left exactly as it is. A name no member has is left too: it is a
 * mention of someone by name. Only a name several members have is refused.
 */
async function mentionedById(ctx: Context, text: string, base: string, how: "resolve" | "keep"): Promise<string> {
  if (how === "keep") return text;
  const had = new Set(mentionsIn(base).map((m) => m.target));
  const introduced = mentionsIn(text).filter((m) => !had.has(m.target));
  if (!introduced.length) return text;
  const found = await membersMeant(ctx, introduced.map((m) => m.target));
  const stored = rementioned(text, (mention) => {
    if (had.has(mention.target)) return undefined;
    const member = memberMeant(found, mention.target);
    if (!member || (member.id === mention.target && mention.label)) return undefined;
    return writtenMention({ id: member.id, name: mention.label ?? member.name });
  });
  if (stored.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With its mentions stored by id, the note would be over ${MAX_NOTE_LENGTH} characters`);
  return stored;
}

/** The text a write stores: what was written, with the links and mentions it introduces stored by id. */
const storedAs = async (ctx: Context, text: string, base: string, op: { linkTitles: LinkTitles; mentionNames: "resolve" | "keep" }) => {
  const resolved = await linkedById(ctx, text, base, op.linkTitles);
  return { text: await mentionedById(ctx, resolved.text, base, op.mentionNames), unresolved: resolved.unresolved };
};

/** The answer to a write, naming the links by title it left as written when there are any. */
const linked = <T extends object>(result: T, unresolved: UnresolvedLink[]): Linked<T> => Object.assign({}, result, unresolved.length ? { unresolved } : {});

/**
 * The statements that make the record of a note's links what `text` says, or none when `was` says
 * the same. They go in the batch that changes the text, so the record can't differ from it. With
 * `atRevision`, they do nothing unless the note is still at that revision.
 */
function linking(ctx: Context, noteId: string, text: string, { was, atRevision }: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] {
  const ids = (of: string) => linkedIds(of).filter((id) => id !== noteId);
  const targets = JSON.stringify(ids(text));
  if (was !== undefined && JSON.stringify(ids(was)) === targets) return [];
  const current = "(?3 IS NULL OR EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND revision = ?3))";
  return [
    ctx.db.prepare(`DELETE FROM links WHERE source_id = ?1 AND target_id NOT IN (${IDS_IN}) AND ${current}`).bind(noteId, targets, atRevision ?? null),
    ctx.db.prepare(`INSERT OR IGNORE INTO links (source_id, target_id) SELECT ?1, value FROM json_each(?2) WHERE ${current}`).bind(noteId, targets, atRevision ?? null),
  ];
}

/** A bound value has a largest size, which the index of a long note of nothing but todos would pass, so its rows go in a few at a time. */
const INDEX_ROWS_LENGTH = 250_000;

function inParts(rows: readonly unknown[]): string[] {
  const parts: string[][] = [[]];
  let length = 0;
  for (const row of rows.map((r) => JSON.stringify(r))) {
    if (length + row.length > INDEX_ROWS_LENGTH && parts.at(-1)!.length) {
      parts.push([]);
      length = 0;
    }
    parts.at(-1)!.push(row);
    length += row.length + 1;
  }
  return parts.filter((part) => part.length).map((part) => `[${part.join(",")}]`);
}

/** Each order of todo.list, before its ties by note and line. */
const TODO_ORDER: Record<TodoSort, string> = {
  due: "t.due IS NULL, t.due, t.importance DESC, n.title COLLATE NOCASE",
  priority: "t.importance DESC, t.due IS NULL, t.due, n.title COLLATE NOCASE",
  changed: "n.updated_at DESC",
  note: "n.title COLLATE NOCASE",
  text: "t.words COLLATE NOCASE",
};

const INDEXED = {
  todos:
    "INSERT INTO todos (note_id, line, done, importance, due, text, words, recurs) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[0]') IN (SELECT value FROM json_each(?4))",
  tags: "INSERT INTO note_tags (note_id, tag, name) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]')",
  mentions: "INSERT INTO mentions (note_id, line, who, name) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')",
} as const;
const INDEX_TABLE = { todos: "todos", tags: "note_tags", mentions: "mentions" } as const;
const indexOf = (text: string) => ({ ...todoIndex(text), mentions: mentionIndex(text) });

/**
 * The statements that make the index of a note's todos, its tags, and its mentions what `text`
 * says, or none for a part that `was` says the same of. Like `linking`, they go in the batch that
 * changes the text, and with `atRevision` do nothing unless the note is still at that revision.
 */
function indexing(ctx: Context, noteId: string, text: string, { was, atRevision }: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] {
  const now = indexOf(text);
  const before = was === undefined ? null : indexOf(was);
  const current = "(?2 IS NULL OR EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND revision = ?2))";
  const at = atRevision ?? null;
  // Whether a todo recurs is said by its line, so it changes only when the todos do.
  const recurring = JSON.stringify(todosIn(text).filter((todo) => todo.every).map((todo) => todo.line));
  return (Object.keys(INDEXED) as (keyof typeof INDEXED)[]).flatMap((part) => {
    if (before && JSON.stringify(before[part]) === JSON.stringify(now[part])) return [];
    return [
      ctx.db.prepare(`DELETE FROM ${INDEX_TABLE[part]} WHERE note_id = ?1 AND ${current}`).bind(noteId, at),
      // Each todo with its words as the index folds them, a space before each, so a word is found by its start. A due date, a repeat, a last-done mark and an assignee are not words of it.
      ...inParts(part === "todos" ? now.todos.map((row) => [...row, ` ${folded(parseTodo(row[4])?.words ?? "")}`]) : now[part]).map((rows) => ctx.db.prepare(`${INDEXED[part]} FROM json_each(?3) WHERE ${current}`).bind(noteId, at, rows, ...(part === "todos" ? [recurring] : []))),
    ];
  });
}

/**
 * The statements that make the text search reads what `text` says, or none when `was` says the same.
 * Like `linking`, they go in the batch that changes the text, and with `atRevision` do nothing
 * unless the note is still at that revision.
 */
function searching(ctx: Context, noteId: string, text: string, { was, atRevision }: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] {
  if (was === text) return [];
  const current = "(?2 IS NULL OR EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND revision = ?2))";
  const at = atRevision ?? null;
  return [
    ctx.db.prepare(`INSERT OR IGNORE INTO note_search_rows (note_id) SELECT ?1 WHERE ${current}`).bind(noteId, at),
    ctx.db.prepare(`DELETE FROM note_search WHERE rowid = (SELECT id FROM note_search_rows WHERE note_id = ?1) AND ${current}`).bind(noteId, at),
    ctx.db.prepare(`INSERT INTO note_search (rowid, workspace, title, text) SELECT r.id, ?3, ?4, ?5 FROM note_search_rows r WHERE r.note_id = ?1 AND ${current}`).bind(noteId, at, ctx.workspaceId, summarize(text).title, text),
  ];
}

/** The same for the record of which uploads a note refers to. */
function referring(ctx: Context, noteId: string, text: string, { was, atRevision }: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] {
  const targets = JSON.stringify(uploadIds(text));
  if (was !== undefined && JSON.stringify(uploadIds(was)) === targets) return [];
  const current = "(?3 IS NULL OR EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND revision = ?3))";
  return [
    ctx.db.prepare(`DELETE FROM upload_refs WHERE note_id = ?1 AND upload_id NOT IN (${IDS_IN}) AND ${current}`).bind(noteId, targets, atRevision ?? null),
    ctx.db.prepare(`INSERT OR IGNORE INTO upload_refs (note_id, upload_id) SELECT ?1, value FROM json_each(?2) WHERE ${current}`).bind(noteId, targets, atRevision ?? null),
  ];
}

/** Everything that is made from a note's text and kept beside it: its links, the uploads it refers to, its todos and tags, and what search reads. */
const deriving = (ctx: Context, noteId: string, text: string, from: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] => [
  ...linking(ctx, noteId, text, from),
  ...referring(ctx, noteId, text, from),
  ...indexing(ctx, noteId, text, from),
  ...searching(ctx, noteId, text, from),
];

/** Whose notes are read in: the asker's own, or every note of the workspace. */
type Mending = "seen" | "all";

/** A condition on `notes`, true for a note of the workspace (`?1`) that is waiting to be read in and that `mending` covers. `?2` is the asker's sight. */
function waiting(mending: Mending): string {
  return `workspace_id = ?1 AND indexed < ${MADE} AND ${mending === "seen" ? SEEN("notes", "?2", "any") : "?2 IS NOT NULL"}`;
}

/**
 * Makes the title, snippet, links, todos, tags and search rows of notes that haven't had them made as they are made now,
 * from their text: notes written before there were tables for them, and every note after a rebuild
 * asks. It reads in the notes the asker is shown, so many a call, and is false when there are more.
 * A note they can't see waits for someone who can: whether it is waiting, and how many are, would
 * otherwise show in how often the asker is told to ask again. A rebuild by someone who sees every
 * folder covers every note.
 */
export async function mend(ctx: Context, mending: Mending = "seen"): Promise<boolean> {
  for (let batch = 0; batch < MEND_BATCHES; batch++) {
    const { results } = await ctx.db
      .prepare(`SELECT id, revision, text FROM notes WHERE ${waiting(mending)} LIMIT ?3`)
      .bind(ctx.workspaceId, ctx.sight.bind, MEND_NOTES + 1)
      .all<{ id: string; revision: number; text: string }>();
    const notes = results.slice(0, MEND_NOTES);
    // A note written since it was read here is left to that write, which made all of it.
    if (notes.length) {
      await ctx.db.batch(
        notes.flatMap((n) => {
          const { title, snippet, openTodos } = summarize(n.text);
          return [
            ...deriving(ctx, n.id, n.text, { atRevision: n.revision }),
            ctx.db.prepare("UPDATE notes SET title = ?, snippet = ?, open_todos = ?, indexed = ? WHERE id = ? AND revision = ?").bind(title, snippet, openTodos, MADE, n.id, n.revision),
          ];
        }),
      );
    }
    if (results.length <= MEND_NOTES) return true;
  }
  return false;
}

/**
 * Has every note's links and index made again. A call that finds notes still waiting from the call
 * before carries on with them, and one that finds none starts over. An agent limited to folders
 * rebuilds its own notes and is told of no other.
 */
const rebuild = {
  needs: "manage",
  async run(ctx: Context) {
    const mending: Mending = seesEveryFolder(ctx.sight) ? "all" : "seen";
    const left = await ctx.db.prepare(`SELECT 1 FROM notes WHERE ${waiting(mending)} LIMIT 1`).bind(ctx.workspaceId, ctx.sight.bind).first();
    if (!left) await ctx.db.prepare(`UPDATE notes SET indexed = 0 WHERE ${waiting(mending).replace(`indexed < ${MADE}`, "indexed >= 0")}`).bind(ctx.workspaceId, ctx.sight.bind).run();
    return { done: await mend(ctx, mending) };
  },
} as const;

/** The note's text at `revision`, and the changes after it up to `current`. */
async function replay(ctx: Context, id: string, revision: number, current: number): Promise<{ text: string; since: ChangeSet[] }> {
  const { results } = await ctx.db
    .prepare("SELECT revision, diff FROM changes WHERE note_id = ? AND revision <= ? ORDER BY revision")
    .bind(id, current)
    .all<{ revision: number; diff: string }>();
  let text = "";
  const since: ChangeSet[] = [];
  for (const row of results) {
    const changes = ChangeSet.fromJSON(JSON.parse(row.diff));
    if (row.revision <= revision) text = applyChanges(changes, text);
    else since.push(changes);
  }
  return { text, since };
}

const MAX_WRITE_ATTEMPTS = 12;
/** The longest wait before a write's second attempt. Each later attempt may wait as much again. */
const WRITE_RETRY_MS = 15;
/** Reverting an author reads each note's whole record and costs a few queries a note, and a request is allowed only so many. */
const REVERT_AUTHOR_NOTES = 10;
/** A handful of statements a note, in one batch. */
const MEND_NOTES = 15;
/** As many batches as one request makes, so a workspace of any size is mended over a few. */
const MEND_BATCHES = 20;
/** A write that lost to another: its revision of a note, a member's daily note for a day, or a folder's name was taken first. */
const isTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: (?:changes\.|daily_notes\.|index 'folders_by_(?:name|key)')/.test(err.message);

/** What a change records beyond its diff. */
interface Recording {
  writeId?: string;
  reverts?: Reverts;
  resolution?: Resolution | null;
}

/** Records `changes` to a note whose text was `before`, with the lines it added and removed counted. */
function insertChange(ctx: Context, noteId: string, revision: number, baseRevision: number, before: string, changes: ChangeSet, { writeId, reverts, resolution }: Recording = {}) {
  const { added, removed } = lineDiff(before, changes);
  return ctx.db
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, author_owner, diff, created_at, write_id, reverts, resolution, added, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      noteId,
      revision,
      baseRevision,
      ctx.author.kind,
      authorId(ctx),
      authorOwner(ctx),
      JSON.stringify(changes.toJSON()),
      ctx.now,
      writeId ?? null,
      reverts ? JSON.stringify(reverts) : null,
      resolution ? JSON.stringify({ reverted: resolution.reverted.toJSON(), edit: resolution.edit.toJSON() }) : null,
      added,
      removed,
    );
}

/**
 * Counts the lines of every change written before changes were counted as they are written, in the
 * notes named. Each such note is replayed once, and never again.
 */
async function countLines(ctx: Context, noteIds: readonly string[]): Promise<void> {
  if (!noteIds.length) return;
  const { results } = await ctx.db
    .prepare(
      `SELECT note_id, revision, diff, added FROM changes
       WHERE note_id IN (SELECT DISTINCT c.note_id FROM changes c WHERE c.note_id IN (SELECT value FROM json_each(?)) AND c.added IS NULL)
       ORDER BY note_id, revision`,
    )
    .bind(JSON.stringify(noteIds))
    .all<{ note_id: string; revision: number; diff: string; added: number | null }>();
  const counts: D1PreparedStatement[] = [];
  for (const rows of Map.groupBy(results, (r) => r.note_id).values()) {
    let text = "";
    for (const row of rows) {
      const changes = ChangeSet.fromJSON(JSON.parse(row.diff));
      if (row.added === null) {
        const { added, removed } = lineDiff(text, changes);
        counts.push(ctx.db.prepare("UPDATE changes SET added = ?, removed = ? WHERE note_id = ? AND revision = ? AND added IS NULL").bind(added, removed, row.note_id, row.revision));
      }
      text = applyChanges(changes, text);
    }
  }
  if (counts.length) await ctx.db.batch(counts);
}

/** The note as recording `changes` as its next revision leaves it, and the statements that do. */
function recording(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, recorded?: Recording): { next: NoteRow; statements: D1PreparedStatement[] } {
  const revision = row.revision + 1;
  const text = applyChanges(changes, row.text);
  if (text.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With the other changes merged in, the note would be over ${MAX_NOTE_LENGTH} characters`);
  const next: NoteRow = { ...row, revision, indexed: MADE, ...written(ctx, text) };
  // A note never indexed has all of it made now, whatever this change touched.
  const was = row.indexed < MADE ? {} : { was: row.text };
  return {
    next,
    statements: [
      insertChange(ctx, row.id, revision, baseRevision, row.text, changes, recorded),
      ctx.db
        .prepare("UPDATE notes SET revision = ?, text = ?, title = ?, snippet = ?, open_todos = ?, updated_at = ?, updated_by = ?, updated_by_kind = ?, updated_by_owner = ?, indexed = ? WHERE id = ? AND revision = ?")
        .bind(revision, next.text, next.title, next.snippet, next.open_todos, next.updated_at, next.updated_by, next.updated_by_kind, next.updated_by_owner, MADE, row.id, row.revision),
      ...deriving(ctx, row.id, text, was),
    ],
  };
}

/** Runs the statements as one batch: all of them or none. False when another write took what one of them needed first. */
async function landed(ctx: Context, statements: D1PreparedStatement[]): Promise<boolean> {
  try {
    await ctx.db.batch(statements);
    return true;
  } catch (err) {
    if (isTaken(err)) return false;
    throw err;
  }
}

/**
 * The todo that was listed as line `at.line` reading `at.text` at `at.revision` of its note, where it
 * is now: the line the caller was shown, followed through each change recorded since. What a line
 * says never decides which line it is, since another todo may say the same. Undefined when the line
 * is gone. It may read otherwise than it did, which is the caller's to look at.
 */
async function listedTodo(ctx: Context, row: NoteRow, at: { revision: number; line: number; text: string }) {
  if (at.revision > row.revision) throw new OpError("invalid", `The note has no revision ${at.revision}`);
  const then = at.revision === row.revision ? { text: row.text, since: [] } : await replay(ctx, row.id, at.revision, row.revision);
  const listed = todosIn(then.text).find((todo) => todo.line === at.line && todo.text === at.text);
  const now = !listed ? null : followed(then.since, listed.from);
  return now === null ? undefined : todosIn(row.text).find((t) => t.from <= now && now <= t.from + t.text.length);
}

/** Where `at` is after each of the changes `since`, one at a time. Null when one of them deleted the text it was in. */
const followed = (since: readonly ChangeSet[], at: number) => since.reduce<number | null>((pos, made) => (pos === null ? null : made.mapPos(pos, 1, MapMode.TrackAfter)), at);

/** Records `changes` as the next revision of `row`. Null when another write took that revision first. */
async function record(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, recorded?: Recording): Promise<NoteRow | null> {
  const { next, statements } = recording(ctx, row, changes, baseRevision, recorded);
  return (await landed(ctx, statements)) ? next : null;
}

/** Whoever is completing a todo, as filing it needs them: their settings for daily notes, and the day it is for them. */
interface Completing {
  settings: DailySettings;
  day: string;
}

const memberSettings = async (db: D1Database, workspaceId: string, personId: string | null) =>
  dailySettings((await db.prepare("SELECT text FROM settings WHERE workspace_id = ? AND person_id = ?").bind(workspaceId, personId).first<{ text: string }>())?.text);

/** `on` is the day as the one asking said it. With none, it is today where their settings say they are. */
async function completing(ctx: Context, on: string | undefined): Promise<Completing> {
  const settings = await memberSettings(ctx.db, ctx.workspaceId, ctx.personId);
  return { settings, day: on ?? dayFor(settings, ctx.now) };
}

/** The time zone a member's settings name in a workspace, which their agent is told times in, or null for UTC. */
export const timeZoneOf = async (db: D1Database, workspaceId: string, personId: string) => (await memberSettings(db, workspaceId, personId)).timeZone;

const NOTE_BY_ID = `SELECT n.text, n.created_by, n.indexed, ${SUMMARY_COLUMNS} WHERE n.id = ?`;

/**
 * The daily note for `day` of the member acting, or of the member an agent acts for, that can still
 * be used: the one place that says which note that is. `stale` is the note the day is kept for when
 * that note can no longer be used, which a new daily note then takes the place of. A note in Trash
 * can't be used: the member threw that day's note away, so the next thing filed gets a new one, and
 * the trashed one is an ordinary note if it is restored after that. Restored before, it is still the day's.
 */
async function usableDaily(ctx: Context, day: string): Promise<{ note: NoteRow | null; stale: string | null }> {
  const kept = await ctx.db.prepare("SELECT note_id FROM daily_notes WHERE workspace_id = ? AND person_id = ? AND day = ?").bind(ctx.workspaceId, ctx.personId, day).first<{ note_id: string }>();
  if (!kept) return { note: null, stale: null };
  const note = current(await ctx.db.prepare(NOTE_BY_ID).bind(kept.note_id).first<NoteRow>());
  return note && note.state !== "trashed" ? { note, stale: null } : { note: null, stale: kept.note_id };
}

/** The folder at the top of the workspace that the member's settings name for daily notes, ignoring case, when there is one. */
const dailyFolder = async (ctx: Context, settings: DailySettings) => (await siblings(ctx, null)).find((f) => folderKey(f.name) === folderKey(settings.folder)) ?? null;

/**
 * A new daily note for `day` holding `text`, and the statements that make it, in `folder` or in a
 * folder made with it when there is none. Null when the member can't make a note there. The row in
 * `daily_notes` is what makes it theirs for that day, and what refuses a second one. It takes the
 * place of `stale`, a daily note of that day that can no longer be used.
 */
function newDaily(ctx: Context, { settings, day }: Completing, text: string, folder: { id: string } | null, stale: string | null): { row: NoteRow; statements: D1PreparedStatement[] } | null {
  // With no folder yet, one is made at the top of the workspace, which only someone who sees all of it may do: not an agent limited to folders.
  if (folder ? !allows(folderLevel(ctx.sight, folder.id), "edit") : !ctx.role || ctx.role === "viewer" || !seesEveryFolder(ctx.sight)) return null;
  const folderId = folder?.id ?? newId();
  const id = newId();
  const row: NoteRow = { id, folder_id: folderId, revision: 1, created_at: ctx.now, created_by: ctx.personId, private_owner: settings.private ? ctx.personId : null, indexed: MADE, ...NEW, ...written(ctx, text) };
  return {
    row,
    statements: [
      ...(folder ? [] : [ctx.db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name, name_key) VALUES (?, ?, NULL, ?, ?)").bind(folderId, ctx.workspaceId, settings.folder, folderKey(settings.folder))]),
      ctx.db
        .prepare(
          `INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, snippet, open_todos, created_at, updated_at, updated_by, updated_by_kind, updated_by_owner, created_by, created_by_kind, private_owner, indexed)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.workspaceId, folderId, row.text, row.title, row.snippet, row.open_todos, row.created_at, row.updated_at, row.updated_by, row.updated_by_kind, row.updated_by_owner, row.created_by, ctx.author.kind, row.private_owner, row.indexed),
      insertChange(ctx, id, 1, 0, "", changesBetween("", text)),
      ...(stale ? [ctx.db.prepare("DELETE FROM daily_notes WHERE workspace_id = ? AND person_id = ? AND day = ? AND note_id = ?").bind(ctx.workspaceId, ctx.personId, day, stale)] : []),
      ctx.db.prepare("INSERT INTO daily_notes (workspace_id, person_id, day, note_id) VALUES (?, ?, ?, ?)").bind(ctx.workspaceId, ctx.personId, day, id),
      ...deriving(ctx, id, text, { was: "" }),
    ],
  };
}

/**
 * Whether a todo's words may be copied from its note onto a daily note. They may when the daily note
 * is private to the one completing and shared with nobody, who could read the todo. They may when
 * neither note is private and nothing narrows or widens who reads either: no grant and no link on
 * either note or on any folder above them. Otherwise someone who reads the daily note might not be
 * let to read the todo, and what is filed is the link back alone.
 */
async function wordsMayBeFiled(ctx: Context, source: NoteRow, daily: { id: string | null; folderId: string | null; privateOwner: string | null }): Promise<boolean> {
  if (daily.privateOwner !== null) {
    if (daily.privateOwner !== ctx.personId) return false;
    return daily.id === null || !(await ctx.db.prepare("SELECT 1 FROM grants WHERE note_id = ? LIMIT 1").bind(daily.id).first());
  }
  if (source.private_owner !== null) return false;
  const shared = await ctx.db
    .prepare(
      `WITH RECURSIVE up (id) AS (SELECT value FROM json_each(?1) UNION SELECT f.parent_id FROM folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL)
       SELECT 1 FROM grants g WHERE g.note_id IN (SELECT value FROM json_each(?2)) OR g.folder_id IN (SELECT id FROM up) LIMIT 1`,
    )
    .bind(JSON.stringify([source.folder_id, daily.folderId].filter((id) => id !== null)), JSON.stringify([source.id, daily.id].filter((id) => id !== null)))
    .first();
  return !shared;
}

/**
 * Records a change that checked off recurring todos, and files each on the daily note of whoever
 * made it, as one batch: the change to the todos' note, the change to the daily note or the making
 * of it, and the record of each completion all happen or none does. A filed line links back to the
 * note it came from. Someone who can't have a daily note here, a guest or a member who can't write
 * in their daily folder, completes the todo all the same and files nothing. Null when another write
 * got in first, to be run again.
 */
async function recordCompleting(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, filed: readonly { line: string; at: number }[], mine: Completing, recorded?: Recording): Promise<Written | null> {
  const daily = ctx.role ? await usableDaily(ctx, mine.day) : undefined;
  const folder = daily && !daily.note ? await dailyFolder(ctx, mine.settings) : null;
  const words = !daily || daily.note?.id === row.id || (await wordsMayBeFiled(ctx, row, daily.note ? { id: daily.note.id, folderId: daily.note.folder_id, privateOwner: daily.note.private_owner } : { id: null, folderId: folder?.id ?? null, privateOwner: mine.settings.private ? ctx.personId : null }));
  const lines = filed.map((f) => (words ? `${f.line} [[${row.id}]]` : `- [x] [[${row.id}]]`));
  const statements: D1PreparedStatement[] = [];
  /** The daily note the lines go on, the revision that puts them there, and where the first starts. */
  let on: { id: string; revision: number | null; at: number } | null = null;
  if (daily?.note?.id === row.id) {
    // The todo is on the daily note it is filed on, which gets the one change. Taking that change back takes the line with it.
    const text = applyChanges(changes, row.text);
    changes = changes.compose(changesBetween(text, filedOn(text, lines)));
    on = { id: row.id, revision: null, at: 0 };
  } else if (daily?.note) {
    if (itemLevel(ctx.sight, daily.note) === "edit") {
      const text = filedOn(daily.note.text, lines);
      statements.push(...recording(ctx, daily.note, changesBetween(daily.note.text, text), daily.note.revision).statements);
      on = { id: daily.note.id, revision: daily.note.revision + 1, at: text.length - filedOn("", lines).length };
    }
  } else if (daily) {
    const made = newDaily(ctx, mine, dailyText(mine.day, lines), folder, daily.stale);
    if (made) {
      statements.push(...made.statements);
      on = { id: made.row.id, revision: 1, at: dailyText(mine.day).length };
    }
  }
  const source = recording(ctx, row, changes, baseRevision, recorded);
  let at = on?.at ?? 0;
  const completions = filed.map((f, i) => {
    const insert = ctx.db
      .prepare("INSERT INTO completions (note_id, revision, at, person_id, author_kind, author_id, done_on, daily_note_id, daily_revision, daily_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, source.next.revision, f.at, ctx.personId, ctx.author.kind, authorId(ctx), mine.day, on?.id ?? null, on?.revision ?? null, on?.revision == null ? null : at, ctx.now);
    at += lines[i]!.length + 1;
    return insert;
  });
  if (!(await landed(ctx, [...source.statements, ...statements, ...completions]))) return null;
  return { ...toNote(ctx, source.next), filed: { on: mine.day, dailyNoteId: on?.id ?? null, todos: filed.length } };
}

/** A completion with where the line it completed starts in the note as it is now. */
interface Followed<C> {
  completion: C;
  at: number;
}

interface CompletionRow {
  revision: number;
  at: number;
  done_on: string;
  daily_note_id: string | null;
  created_at: number;
  author_kind: string;
  author_id: string;
  name: string | null;
  agent_owner: string | null;
}

/**
 * Each completion of a todo in the note that still stands, with where its line starts now: the place
 * it was recorded at, followed through every change to the note since, as `following` follows a
 * line. A todo has no id, so this is what says which completions are one todo's.
 */
async function completionsNow(ctx: Context, noteId: string): Promise<Followed<CompletionRow>[]> {
  const [done, later] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db
      .prepare(
        `SELECT c.revision, c.at, c.done_on, c.daily_note_id, c.created_at, c.author_kind, c.author_id, ${NAME} AS name, COALESCE(a.person_id, CASE c.author_kind WHEN 'plugin' THEN c.person_id END) AS agent_owner
         FROM completions c
         ${named("c.author_kind", "c.author_id")}
         WHERE c.note_id = ?1 ORDER BY c.revision, c.at`,
      )
      .bind(noteId),
    ctx.db.prepare("SELECT revision, diff, reverts FROM changes WHERE note_id = ?1 ORDER BY revision").bind(noteId),
  ]);
  const completions = done!.results as unknown as CompletionRow[];
  const changes = later!.results as unknown as { revision: number; diff: string; reverts: string | null }[];
  const undone = revertedBy(changes.map(stepOf));
  const following: Followed<CompletionRow>[] = [];
  let next = 0;
  let text = "";
  for (const change of changes) {
    const moved = ChangeSet.fromJSON(JSON.parse(change.diff));
    const was = text;
    text = applyChanges(moved, was);
    const after = following.length ? lineFollowing(was, moved, text) : null;
    // A line that is gone keeps the place it was at, where a revert would put it back.
    for (const follow of following) follow.at = after!(follow.at) ?? moved.mapPos(follow.at, 1);
    for (; next < completions.length && completions[next]!.revision === change.revision; next++) following.push({ completion: completions[next]!, at: completions[next]!.at });
  }
  return following.filter(({ completion }) => !undone.has(completion.revision));
}

/** Whether a note's change at `revision` has been reverted, by a change that still stands. */
async function takenBack(ctx: Context, noteId: string, revision: number): Promise<boolean> {
  const { results } = await ctx.db.prepare("SELECT revision, reverts FROM changes WHERE note_id = ? AND revision >= ? ORDER BY revision").bind(noteId, revision).all<{ revision: number; reverts: string | null }>();
  return revertedBy(results.map(stepOf)).has(revision);
}

/** What taking completions back did to the lines they filed. */
interface Refiling {
  statements: D1PreparedStatement[];
  unfiled?: NonNullable<Written["unfiled"]>;
}

/**
 * What a change that reverts others does to the daily notes: a completion it reverts has its filed
 * line taken off the daily note, and one that stands again, because the change that reverted it was
 * itself reverted, has it filed again unless it is still there. The line is found by following the place it was filed at through the daily
 * note's changes since, never by what it says. One that was edited or deleted since is left as the
 * member has it. The statements go in the batch that records the change itself.
 */
function mayRefile(ctx: Context, daily: NoteRow): boolean {
  const asked = itemAsked(ctx.sight, daily);
  if (asked.outside) return false;
  const level = itemLevel(ctx.sight, daily);
  const privateToSomeoneElse = asked.private === "theirs" && level === "none";
  return level === "edit" || privateToSomeoneElse;
}

async function refiling(ctx: Context, row: NoteRow, history: readonly Recorded[], reverts: Reverts): Promise<Refiling> {
  const { results } = await ctx.db
    .prepare("SELECT revision, at, daily_note_id, daily_revision, daily_at FROM completions WHERE note_id = ?1 AND daily_note_id <> ?1 AND daily_revision IS NOT NULL ORDER BY revision, at")
    .bind(row.id)
    .all<{ revision: number; at: number; daily_note_id: string; daily_revision: number; daily_at: number }>();
  if (!results.length) return { statements: [] };
  const [before, after] = [revertedBy(history), revertedBy([...history, { revision: history.length + 1, reverts }])];
  const moved = results.filter((c) => before.has(c.revision) !== after.has(c.revision));
  const refiled: Refiling = { statements: [], unfiled: { removed: 0, left: 0, dailyNoteIds: [] } };
  for (const [dailyId, completions] of Map.groupBy(moved, (c) => c.daily_note_id)) {
    const daily = await ctx.db.prepare(NOTE_BY_ID).bind(dailyId).first<NoteRow>();
    if (!daily) continue;
    if (daily.state === "trashed" || !mayRefile(ctx, daily)) {
      refiled.unfiled!.left += completions.filter((c) => after.has(c.revision)).length;
      continue;
    }
    const removals: { from: number; to: number }[] = [];
    const additions: { completion: (typeof completions)[number]; line: string }[] = [];
    let touched = false;
    for (const completion of completions) {
      const then = await replay(ctx, daily.id, completion.daily_revision, daily.revision);
      const line = then.text.slice(completion.daily_at).split("\n", 1)[0]!;
      const now = followed(then.since, completion.daily_at);
      const stands = now !== null && (now === 0 || daily.text[now - 1] === "\n") && daily.text.slice(now).split("\n", 1)[0] === line;
      if (after.has(completion.revision)) {
        if (stands) removals.push({ from: now, to: Math.min(daily.text.length, now + line.length + 1) });
        // Reverting an author takes the daily note's change that filed the line back out too, before this or after: either way the line is off.
        const off = stands || (await takenBack(ctx, daily.id, completion.daily_revision));
        refiled.unfiled![off ? "removed" : "left"]++;
        if (off && !stands) touched = true;
      } else if (!stands) additions.push({ completion, line });
    }
    if (touched && itemLevel(ctx.sight, daily) !== "none") refiled.unfiled!.dailyNoteIds.push(daily.id);
    if (!removals.length && !additions.length) continue;
    const end = daily.text.length;
    const filedAgain = additions.length ? `${end === 0 || daily.text.endsWith("\n") || removals.some((r) => r.to === end) ? "" : "\n"}${additions.map((a) => `${a.line}\n`).join("")}` : "";
    const changes = ChangeSet.of([...removals, ...(filedAgain ? [{ from: end, insert: filedAgain }] : [])], end);
    const { next, statements } = recording(ctx, daily, changes, daily.revision);
    refiled.statements.push(...statements);
    let at = next.text.length - additions.reduce((length, a) => length + a.line.length + 1, 0);
    for (const { completion, line } of additions) {
      refiled.statements.push(ctx.db.prepare("UPDATE completions SET daily_revision = ?, daily_at = ? WHERE note_id = ? AND revision = ? AND at = ?").bind(next.revision, at, row.id, completion.revision, completion.at));
      at += line.length + 1;
    }
    if (!touched && itemLevel(ctx.sight, daily) !== "none") refiled.unfiled!.dailyNoteIds.push(daily.id);
  }
  return refiled.statements.length || refiled.unfiled!.left || refiled.unfiled!.removed ? refiled : { statements: [] };
}

/**
 * Records the change that takes `reverts` back out of `row`, and what that does to the daily notes
 * its completions were filed on, as one batch. Every revert goes through here, of one note or of
 * many. Null when another write got in first.
 */
async function recordTakenBack(ctx: Context, row: NoteRow, history: readonly Recorded[], reverts: Reverts, changes: ChangeSet, resolution: Resolution | null, filed = true): Promise<{ next: NoteRow; unfiled?: NonNullable<Written["unfiled"]> } | null> {
  const { next, statements } = recording(ctx, row, changes, row.revision, { reverts, resolution });
  const refiled = filed ? await refiling(ctx, row, history, reverts) : { statements: [] };
  if (!(await landed(ctx, [...statements, ...refiled.statements]))) return null;
  return { next, ...(refiled.unfiled && { unfiled: refiled.unfiled }) };
}

/**
 * Runs a write again from the note as it now stands, each time another write took its revision.
 * Writers that lost to the same one wait for different lengths of time, so they don't all meet
 * again. One that still can't get in is told so as a conflict: nothing of it was written, and the
 * same request sent again is merged as any other.
 */
async function settle<T>(write: () => Promise<T | null>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const done = await write();
    if (done !== null) return done;
    if (attempt < MAX_WRITE_ATTEMPTS) await new Promise((resume) => setTimeout(resume, Math.random() * WRITE_RETRY_MS * attempt));
  }
  throw new OpError("conflict", "The note was being changed by others too fast for this change to be written. Nothing of it was: send it again");
}

interface ChangeRow {
  note_id: string;
  revision: number;
  base_revision: number;
  author_kind: string;
  author_id: string;
  name: string | null;
  agent_owner: string | null;
  created_at: number;
  reverts: string | null;
  label: string | null;
  added: number | null;
  removed: number | null;
}

const CHANGE_COLUMNS = `c.note_id, c.revision, c.base_revision, c.author_kind, c.author_id, ${NAME} AS name, COALESCE(a.person_id, c.author_owner) AS agent_owner, c.created_at, c.reverts, c.added, c.removed, l.name AS label
  FROM changes c
  ${named("c.author_kind", "c.author_id")}
  LEFT JOIN labels l ON l.note_id = c.note_id AND l.revision = c.revision`;

const revertsOf = (json: string | null) => (json ? (JSON.parse(json) as Reverts) : null);
const stepOf = (r: { revision: number; reverts: string | null }) => ({ revision: r.revision, reverts: revertsOf(r.reverts) });

/** What a note's changes come to: which were taken back out and by what, and which took others out. */
interface Standing {
  reverted: ReadonlyMap<number, number>;
  reverts: ReadonlySet<number>;
}

const standingOf = (steps: readonly Step[]): Standing => ({ reverted: revertedBy(steps), reverts: new Set(steps.filter((s) => s.reverts).map((s) => s.revision)) });

const toEntry = (r: ChangeRow, { reverted, reverts }: Standing): ChangeEntry => ({
  revision: r.revision,
  baseRevision: r.base_revision,
  author: authorOf(r.author_kind, r.author_id, r.name, r.agent_owner),
  createdAt: r.created_at,
  label: r.label,
  reverts: revertsOf(r.reverts),
  revertedBy: reverted.get(r.revision) ?? null,
  added: r.added ?? 0,
  removed: r.removed ?? 0,
  restores: revertsOf(r.reverts)?.revisions.filter((revision) => reverts.has(revision)).length ?? 0,
});

/** A note's change as moving through history reads it. */
interface Recorded {
  revision: number;
  author: AuthorRef;
  named: Author;
  changes: ChangeSet;
  reverts: Reverts | null;
  resolution: Resolution | null;
}

interface RecordedRow {
  revision: number;
  author_kind: AuthorRef["kind"];
  author_id: string;
  name: string | null;
  agent_owner: string | null;
  diff: string;
  reverts: string | null;
  resolution: string | null;
}

function resolutionOf(json: string | null): Resolution | null {
  if (!json) return null;
  const { reverted, edit } = JSON.parse(json) as { reverted: unknown; edit: unknown };
  return { reverted: ChangeSet.fromJSON(reverted), edit: ChangeSet.fromJSON(edit) };
}

const toRecorded = (r: RecordedRow): Recorded => ({
  ...stepOf(r),
  author: { kind: r.author_kind, id: r.author_id },
  named: authorOf(r.author_kind, r.author_id, r.name, r.agent_owner),
  changes: ChangeSet.fromJSON(JSON.parse(r.diff)),
  resolution: resolutionOf(r.resolution),
});

/** Names the changes to take back out from the note's changes so far, or returns null to leave the note as it is. */
type Choose = (history: Recorded[], reverted: Map<number, number>) => Reverts | null;

/** A revert as it would be made: the note as it stands, what the revert finds in it, and the change to record with its conflicts settled as asked. Null `reverts` leaves the note as it is. */
interface TakingBack {
  row: NoteRow;
  history: Recorded[];
  reverts: Reverts | null;
  found: Reverting;
  changes: ChangeSet;
  resolution: Resolution | null;
}

const RECORDED_COLUMNS = `c.note_id, c.revision, c.author_kind, c.author_id, ${NAME} AS name, COALESCE(a.person_id, c.author_owner) AS agent_owner, c.diff, c.reverts, c.resolution
       FROM changes c
       ${named("c.author_kind", "c.author_id")}`;

async function takingBack(ctx: Context, id: string, need: GrantLevel, choose: Choose, resolve?: Resolve): Promise<TakingBack> {
  const row = await loadNote(ctx, id, need, need === "edit" ? "refused" : "opens");
  const { results } = await ctx.db.prepare(`SELECT ${RECORDED_COLUMNS} WHERE c.note_id = ? AND c.revision <= ? ORDER BY c.revision`).bind(row.id, row.revision).all<RecordedRow>();
  return takingBackOf(row, results.map(toRecorded), choose, resolve);
}

/**
 * The notes named, each with its changes up to the revision it was read at, in two reads however
 * many they are. A note that isn't in the workspace, or that the actor can't see, is left out: the
 * two are the same to whoever asks. What they may do with each note that is here is still to ask.
 */
/** Of these notes, those with a completion filed on a daily note, whose revert may change that note too. */
async function filedElsewhere(ctx: Context, ids: readonly string[]): Promise<Set<string>> {
  const { results } = await ctx.db
    .prepare("SELECT DISTINCT note_id FROM completions WHERE note_id IN (SELECT value FROM json_each(?1)) AND daily_note_id <> note_id AND daily_revision IS NOT NULL")
    .bind(JSON.stringify(ids))
    .all<{ note_id: string }>();
  return new Set(results.map((r) => r.note_id));
}

async function loadWithHistory(ctx: Context, ids: readonly string[]): Promise<Map<string, { row: NoteRow; history: Recorded[] }>> {
  const named = JSON.stringify(ids);
  const [notes, changes] = await ctx.db.batch<NoteRow & RecordedRow & { note_id: string }>([
    ctx.db.prepare(`SELECT n.text, n.created_by, ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3", "any")}`).bind(ctx.workspaceId, named, ctx.sight.bind),
    ctx.db
      .prepare(`SELECT ${RECORDED_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ?1 AND c.note_id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3", "any")} ORDER BY c.note_id, c.revision`)
      .bind(ctx.workspaceId, named, ctx.sight.bind),
  ]);
  const recorded = Map.groupBy(changes!.results, (r) => r.note_id);
  return new Map(notes!.results.map((row) => [row.id, { row, history: (recorded.get(row.id) ?? []).filter((r) => r.revision <= row.revision).map(toRecorded) }]));
}

/** A revert's conflicts as a preview tells them: who made the later changes, and where each is on the diffs of the changes asked for, a run of them at a time. */
function toldConflicts(history: readonly Recorded[], found: Reverting, asked?: readonly number[]): RevertConflict[] {
  const runs = asked ? runsOf(asked.filter((r) => r <= history.length)) : [];
  return found.conflicts.map((c) => ({
    ...c,
    later: c.later.map((revision) => ({ revision, author: history[revision - 1]!.named })),
    runs: runs.map((run) => ({ revision: run.to, ...linesAsOf(history, found, run.to, c.line, c.kept.length) })),
  }));
}

/** `takingBack` of a note already read with its changes. */
function takingBackOf(row: NoteRow, history: Recorded[], choose: Choose, resolve?: Resolve): TakingBack {
  if (resolve && resolve.at !== row.revision) {
    throw new OpError("invalid", `The note has changed since this revert was previewed: it was at revision ${resolve.at} and is at ${row.revision}. Preview the revert again, and settle its conflicts as they are now`);
  }
  const reverts = choose(history, revertedBy(history));
  const found: Reverting = reverts ? reverting(history, reverts, row.text) : { changes: ChangeSet.empty(row.text.length), overlaps: [], conflicts: [] };
  const settled = settledRevert(found, row.text, choicesFor(found, resolve));
  // Said of a preview too, so that a revert it shows is one that can be made.
  if (settled.changes.newLength > MAX_NOTE_LENGTH) throw new OpError("invalid", `With ${resolve ? "these choices" : "the other changes merged in,"} the note would be over ${MAX_NOTE_LENGTH} characters`);
  return { row, history, reverts, found, ...settled };
}

/** A choice for each conflict the revert has. */
function choicesFor({ conflicts }: Reverting, resolve?: Resolve): Choice[] {
  const choices = resolve?.choices ?? "keep";
  if (typeof choices === "string") return conflicts.map(() => choices);
  if (choices.length !== conflicts.length) {
    const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? "" : "s"}`;
    throw new OpError("invalid", `This revert has ${count(conflicts.length, "conflict")} to settle, and ${count(choices.length, "choice")} ${choices.length === 1 ? "was" : "were"} given: give one for each, in the order the preview lists them`);
  }
  return choices;
}

/** Records one change that takes other changes back out of a note, and what that does to the daily notes its completions were filed on. */
function takeBack(ctx: Context, id: string, choose: Choose, resolve?: Resolve): Promise<Written> {
  return settle(async (): Promise<Written | null> => {
    const { row, history, reverts, changes, resolution } = await takingBack(ctx, id, "edit", choose, resolve);
    if (!reverts) return toNote(ctx, row);
    const done = await recordTakenBack(ctx, row, history, reverts, changes, resolution);
    return done && { ...toNote(ctx, done.next), ...(done.unfiled && { unfiled: done.unfiled }) };
  });
}

/** The chosen revisions in order, each one a change the note has. */
function chosen(revisions: number[], history: Recorded[]): number[] {
  const missing = revisions.find((r) => r > history.length);
  if (missing !== undefined) throw new OpError("not_found", `The note has no change ${missing}`);
  return [...new Set(revisions)].sort((a, b) => a - b);
}

function isJsonObject(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** What has a place in a folder and a life: a note or an upload. Each is moved through its life by the same statements. */
export type Kept = "notes" | "uploads";

/**
 * Moves a note or an upload to Trash, remembering the state it had and the folder it was in. One
 * statement, which does nothing to one already there, or one `only` rules out. It answers how many it moved.
 */
export async function trashing(ctx: Context, id: string, only = "state IN ('live', 'archived')", table: Kept = "notes"): Promise<number> {
  const { meta } = await ctx.db
    .prepare(`UPDATE ${table} SET restores_as = state, restores_to = folder_id, state = 'trashed', state_at = ?3, state_by = ?4, state_by_kind = ?5 WHERE id = ?1 AND workspace_id = ?2 AND ${only}`)
    .bind(id, ctx.workspaceId, ctx.now, authorId(ctx), ctx.author.kind)
    .run();
  return meta.changes;
}

/** Archives a note or an upload, or brings it back. It does nothing to one in Trash. */
export const archiving = (ctx: Context, table: Kept, id: string, state: "live" | "archived") =>
  ctx.db
    .prepare(`UPDATE ${table} SET state = ?2, state_at = ?3, state_by = ?4, state_by_kind = ?5 WHERE id = ?1 AND state IN ('live', 'archived')`)
    .bind(id, state, ctx.now, authorId(ctx), ctx.author.kind)
    .run();

/**
 * Brings a note or an upload back from Trash, to the state it had. Null when it was no longer there
 * to bring back. Whoever could trash it can put it back where it was. Only one whose folder was
 * deleted since goes somewhere new, to Unsorted, and that takes edit there.
 */
export async function restoring(ctx: Context, table: Kept, row: { id: string; folder_id: string; restores_as?: "live" | "archived" | null; restores_to?: string | null }): Promise<{ state: "live" | "archived"; folderGone: boolean } | null> {
  const folderGone = row.restores_to != null && row.restores_to !== row.folder_id;
  if (folderGone && !allows(folderLevel(ctx.sight, row.folder_id), "edit")) throw new OpError("forbidden", `The folder this ${table === "notes" ? "note" : "upload"} was in was deleted, so it returns to Unsorted, which you can't change`);
  const state = row.restores_as ?? "live";
  const { meta } = await ctx.db
    .prepare(`UPDATE ${table} SET state = ?2, state_at = ?3, state_by = ?4, state_by_kind = ?5, restores_as = NULL, restores_to = NULL WHERE id = ?1 AND state = 'trashed'`)
    .bind(row.id, state, ctx.now, authorId(ctx), ctx.author.kind)
    .run();
  return meta.changes ? { state, folderGone } : null;
}

/** Only for an operation that is `by: "member"`, which is always asked by a person. */
/** Whose data sources an operation reads: the person asking, or the person an agent asks for. Never anyone an operation names. */
const asker = (ctx: Context) => ({ db: ctx.db, sources: ctx.sources, personId: ctx.personId!, now: ctx.now });

const asking = (ctx: Context): Asking => ({ db: ctx.db, workspaceId: ctx.workspaceId, personId: ctx.personId!, now: ctx.now });

/** How far the person asking has read the changes in the workspace. */
async function visit(ctx: Context): Promise<Visit> {
  const row = await ctx.db.prepare("SELECT read_until FROM visits WHERE workspace_id = ? AND person_id = ?").bind(ctx.workspaceId, ctx.personId).first<{ read_until: number }>();
  return { readUntil: row?.read_until ?? null, now: ctx.now };
}

/** Every change after `revision`: the note goes back to how it was then. */
const revertBy =
  (author: AuthorRef): Choose =>
  (history) =>
    revertOfAuthor(history, (c) => sameAuthor(c.author, author));

const revertTo =
  (revision: number): Choose =>
  (history) => {
    if (revision > history.length) throw new OpError("not_found", `The note has no revision ${revision}`);
    if (revision === history.length) return null;
    return { how: "revert", revisions: history.slice(revision).map((c) => c.revision), to: revision };
  };

const revertOf =
  (revisions: number[]): Choose =>
  (history, reverted) => {
    const standing = chosen(revisions, history);
    const gone = standing.find((r) => reverted.has(r));
    if (gone !== undefined) throw new OpError("invalid", `Change ${gone} was already reverted, by change ${reverted.get(gone)}. Revert change ${reverted.get(gone)} to have it again`);
    return { how: "revert", revisions: standing };
  };

/** The picked changes that still stand, or that a picked change took out: a change something else already took out is left be. */
const revertStanding =
  (revisions: number[]): Choose =>
  (history) => {
    const standing = revertible(history, chosen(revisions, history)).revisions;
    return standing.length ? { how: "revert", revisions: standing } : null;
  };

type RevertedItem = Extract<Op, { type: "history.revert" }>["changes"][number];

/** One note's revert among several, as it would be made. */
function takingBackItem(row: NoteRow, history: Recorded[], item: RevertedItem): TakingBack {
  const choose = item.author ? revertBy(item.author) : item.to !== undefined ? revertTo(item.to) : revertStanding(item.revisions!);
  return takingBackOf(row, history, choose, item.choices !== undefined ? { at: item.at!, choices: item.choices } : undefined);
}

const titled = (row: NoteRow) => ({ noteId: row.id, noteTitle: row.title });

/** As many diff lines as one answer of `history.diff` holds. A run past them comes without its diff. */
const is = (word: string): Filter => ({ kind: "filter", key: "is", cmp: "=", value: word });
/** Says a word of `is:` without narrowing by it, which is what the old fields that widen a listing do. */
const either = (word: string): Node => ({ kind: "or", of: [is(word), { kind: "not", of: is(word) }] });

const any = (of: Node[]): Node => (of.length > 1 ? { kind: "or", of } : of[0]!);

/** What the fields a listing had before there was a query language say, as the query says it. */
export const OLD = {
  archived: (includeArchived: boolean | "only"): Node[] => (includeArchived === "only" ? [is("archived")] : includeArchived ? [either("archived")] : []),
  completed: (includeCompleted: boolean): Node[] => (includeCompleted ? [either("done")] : []),
};

/** What a query asks of the database: a condition over the notes row `n` and, for todos, the todos row `t`, or for uploads the uploads row `u`, with what it binds after the workspace and the asker's sight. */
export interface Finding {
  query: Query;
  covering: Covering;
  condition: string;
  /** Binds one more value, for what the operation asks besides the condition, and answers its placeholder. */
  bind: (value: string | number) => string;
  /** The statement that asks it, with every value bound: the workspace is `?1` and the asker's sight `?2`. */
  prepare: (sql: string) => D1PreparedStatement;
}

/**
 * What a statement's values are bound through: each is given a placeholder, the one it already has
 * when it was bound before, so a statement holds each of its values once. D1 takes a hundred, and
 * one more is refused here, in words, where the database would refuse the whole statement.
 */
export function binder(values: (string | number)[]): (value: string | number) => string {
  return (value) => {
    const had = values.indexOf(value);
    if (had >= 0) return `?${had + 1}`;
    if (values.length >= MAX_BOUND) throw new OpError("invalid", `This query asks for more than the ${MAX_BOUND} values a search can take: say it in fewer terms`);
    return `?${values.push(value)}`;
  };
}

/**
 * Reads a query and makes it a condition, for `search`, `todo.list` and `upload.list` alike: the
 * one place a query meets the database. Every value is bound. A name is looked up among what the
 * asker can already see, so a folder they can't see, or someone who has changed no note or uploaded
 * no file they can see, is refused in the very words a name nobody has is. `also` is ANDed with it: the old fields of the
 * operation, said as a query says them. Which states of a note it covers is read from its `is:`.
 */
export async function finding(ctx: Context, scope: Scope, op: { query: string; today?: string; zone?: string }, also: readonly Bound[]): Promise<Finding> {
  const parsed = parse(op.query, scope);
  if (!parsed.ok) {
    const { message, from, to } = parsed.error;
    throw new OpError("invalid", `${message} (characters ${from + 1} to ${Math.max(to, from + 1)} of the query${to > from ? `: ${op.query.slice(from, to)}` : ""})`);
  }
  const { query } = parsed;
  const said = (word: string) => names(query.where, word) || also.some((node) => names(node as Node, word));
  const covering: Covering = said("trashed") ? "any" : said("archived") ? "kept" : "live";
  // Todos are the open ones until a query says anything of whether one is done, a NOT of it included.
  const open = scope === "todos" && !said("open") && !said("done");

  let folders: Promise<{ id: string; parent_id: string | null; name: string }[]> | undefined;
  const folderIds = async (named: string): Promise<string[]> => {
    folders ??= ctx.db.prepare("SELECT id, parent_id, name FROM folders WHERE workspace_id = ?").bind(ctx.workspaceId).all<{ id: string; parent_id: string | null; name: string }>().then((r) => r.results);
    const all = await folders;
    const found = all.filter((f) => (f.id === named || f.name.toLowerCase() === named.toLowerCase()) && allows(folderLevel(ctx.sight, f.id), "view")).map((f) => f.id);
    if (!found.length) throw new OpError("invalid", `No folder named "${named}"`);
    const under = new Set(found);
    // A folder's parent is listed before or after it, so the folders are gone over until none is added.
    for (let added = true; added; ) {
      added = false;
      for (const f of all) if (f.parent_id && under.has(f.parent_id) && !under.has(f.id)) added = !!under.add(f.id);
    }
    return [...under];
  };
  const authors = async (named: string): Promise<string[]> => {
    if (named.toLowerCase() === "@me") return [`${ctx.author.kind}:${authorId(ctx)}`];
    const changed = (kind: string, id: string) => `EXISTS (SELECT 1 FROM changes c JOIN notes n ON n.id = c.note_id WHERE c.author_kind = '${kind}' AND c.author_id = ${id} AND n.workspace_id = ?1 AND ${SEEN("n", "?2", "any")})`;
    const { results } = await ctx.db
      .prepare(
        `SELECT 'member:' || p.id AS author FROM people p WHERE p.name = ?3 COLLATE NOCASE AND ${changed("member", "p.id")}
         UNION ALL SELECT 'agent:' || a.id FROM agents a WHERE a.name = ?3 COLLATE NOCASE AND ${changed("agent", "a.id")}`,
      )
      .bind(ctx.workspaceId, ctx.sight.bind, named)
      .all<{ author: string }>();
    if (!results.length) throw new OpError("invalid", `Nobody named "${named}" has changed a note you can see`);
    return results.map((r) => r.author);
  };
  /** Who uploaded, as `authors` is who changed: found only among the uploads the asker can see. */
  const uploaders = async (named: string): Promise<string[]> => {
    if (named.toLowerCase() === "@me") return [`${ctx.author.kind}:${authorId(ctx)}`];
    const uploaded = (kind: string, id: string) => `EXISTS (SELECT 1 FROM uploads u WHERE u.uploaded_by = ${id} AND u.uploaded_by_kind = '${kind}' AND u.workspace_id = ?1 AND ${SEEN("u", "?2", "any")})`;
    const { results } = await ctx.db
      .prepare(
        `SELECT 'member:' || p.id AS author FROM people p WHERE p.name = ?3 COLLATE NOCASE AND ${uploaded("member", "p.id")}
         UNION ALL SELECT 'agent:' || a.id FROM agents a WHERE a.name = ?3 COLLATE NOCASE AND ${uploaded("agent", "a.id")}`,
      )
      .bind(ctx.workspaceId, ctx.sight.bind, named)
      .all<{ author: string }>();
    if (!results.length) throw new OpError("invalid", `Nobody named "${named}" has uploaded a file you can see`);
    return results.map((r) => r.author);
  };
  /**
   * Who a mention of `named` is matched by: the name itself, which is how a mention by name alone is
   * kept, and the id of each member so named for an asker who is told who the members are. `@me` is
   * the asker, or an agent's member. Nobody is refused: a name no note mentions finds nothing, as a
   * name in a note the asker can't see does.
   */
  const mentionedAs = async (named: string): Promise<string[]> => {
    if (named.toLowerCase() === "@me") return ctx.personId ? [ctx.personId] : [];
    const meant = await membersMeant(ctx, [named]);
    return [...new Set([personKey(named), ...(meant.byId.has(named) ? [named] : []), ...(meant.byName.get(named.toLowerCase()) ?? []).map((m) => m.id)])];
  };
  let shared: Promise<string[]> | undefined;
  /** The notes, or the uploads, with a grant of their own that the asker may list the grants of: what sharing one shows them, and no more. */
  const sharedIds = () =>
    (shared ??= (async () => {
      if (ctx.actor.kind !== "member") return [];
      const [table, column] = scope === "uploads" ? ["uploads", "upload_id"] : ["notes", "note_id"];
      const { results } = await ctx.db
        .prepare(`SELECT DISTINCT n.id, n.folder_id, n.private_owner FROM grants g JOIN ${table} n ON n.id = g.${column} WHERE g.workspace_id = ?1 AND ${SEEN("n", "?2", "any")}`)
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<{ id: string; folder_id: string; private_owner: string | null }>();
      return results.filter((note) => canShare(itemAsked(ctx.sight, note))).map((note) => note.id);
    })());
  const day = (written: string): string => {
    if (!isRelative(written)) return written;
    if (!op.today) throw new OpError("invalid", `"${written}" is counted from today, and the server doesn't know your day: pass today, as YYYY-MM-DD`);
    return dayOf(written, op.today);
  };
  const resolved = async (node: Node | Bound): Promise<Bound> => {
    if (node.kind === "and" || node.kind === "or") return { kind: node.kind, of: await Promise.all(node.of.map(resolved)) };
    if (node.kind === "not") return { kind: "not", of: await resolved(node.of) };
    if (node.kind !== "filter" || "ids" in node) return node;
    const { type } = FILTERS[node.key].value;
    if (type === "folder") return { ...node, ids: await folderIds(node.value) };
    if (type === "person") return { ...node, ids: await (node.key === "uploader" ? uploaders : authors)(node.value) };
    if (type === "mentioned") return { ...node, ids: await mentionedAs(node.value) };
    if (type === "day") return { ...node, value: day(node.value), ...(node.to !== undefined && { to: day(node.to) }) };
    if (node.key === "is" && node.value === "shared") return { ...node, ids: await sharedIds() };
    return node;
  };
  const parts = [...(query.where ? [query.where] : []), ...also, ...(open ? [is("open")] : [])];
  const where = parts.length > 1 ? await resolved({ kind: "and", of: parts as Bound[] }) : parts.length ? await resolved(parts[0]!) : null;

  let zone: (day: string) => number;
  let settingsZone: string | null | undefined;
  const timed = [...walk(where as Node | null)].some(({ node }) => node.kind === "filter" && (node.key === "updated" || node.key === "created" || node.key === "uploaded"));
  if (timed && !op.zone) {
    const row = await ctx.db.prepare("SELECT text FROM settings WHERE workspace_id = ? AND person_id = ?").bind(ctx.workspaceId, ctx.personId).first<{ text: string }>();
    settingsZone = dailySettings(row?.text).timeZone;
  }
  const start = () => (zone ??= dayStartIn(op.zone ?? settingsZone ?? "UTC"));

  const binds: (string | number)[] = [ctx.workspaceId, ctx.sight.bind];
  const bind = binder(binds);
  const compiling: Compiling = { scope, workspaceId: ctx.workspaceId, in: query.in, bind, seen: (alias) => SEEN(alias, "?2", "kept"), dayStart: (d) => start()(d), dayEnd: (d) => start()(shift(d, 1)) };
  return { query, covering, condition: conditionOf(where, compiling), bind, prepare: (sql) => ctx.db.prepare(sql).bind(...binds) };
}


/** As much of a line as a person's page shows of it, around where it first mentions them. */
const MENTION_LINE = 300;

/** What starts a line of a list, a task, a heading or a quote: the marks, not the words. */
const BLOCK_MARKS = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)/;

/** The line's words with each mention written as the name it shows the asker, and no more of it than a page shows. */
function lineAsShown(line: string, members: ReadonlyMap<string, Member>, keys: ReadonlySet<string>): string {
  const words = line.replace(BLOCK_MARKS, (marks) => " ".repeat(marks.length));
  const at = mentionsOn(words).find((m) => keys.has(mentionKey(m)))?.from ?? 0;
  const shown = rementioned(words, (mention) => `@${members.get(mention.target)?.name ?? mentionName(mention)}`).trim();
  if (shown.length <= MENTION_LINE) return shown;
  const from = Math.max(0, Math.min(at - MENTION_LINE / 3, shown.length - MENTION_LINE));
  return `${from > 0 ? "…" : ""}${shown.slice(Math.round(from), Math.round(from) + MENTION_LINE)}…`;
}

/**
 * What a person's page shows the asker. Each part goes through what the asker may be told: the
 * member only to whoever is told who the members are, their email only as member.list tells it,
 * contacts only the asker's own and never to an agent limited to folders, and todos and lines only
 * from the notes the asker can see.
 */
async function readPerson(ctx: Context, op: Extract<Op, { type: "person.read" }>): Promise<PersonPage> {
  await mend(ctx);
  const meant = await membersMeant(ctx, [op.who]);
  const namesakes = meant.byName.get(op.who.toLowerCase()) ?? [];
  const one = meant.byId.get(op.who) ?? (namesakes.length === 1 ? namesakes[0] : undefined);
  const full = one ? (await listMembers(ctx.db, ctx.workspaceId, { emails: true })).find((m) => m.personId === one.id) : undefined;
  const toldEmail = ctx.author.kind === "member" && ctx.role === "admin" ? full?.email : undefined;
  const member: MemberCard | null = full ? { personId: full.personId, name: full.name, role: full.role, ...(toldEmail && { email: toldEmail }) } : null;
  const who = member?.personId ?? op.who;
  // Who their mentions are: as `mentions:` reads the name they are asked by, or a member's name when one member has it, so a
  // mention written by name before they joined is theirs too, and the page's search finds what the page lists.
  const byName = member && isPersonId(op.who) ? ((await membersMeant(ctx, [member.name])).byName.get(member.name.toLowerCase()) ?? []) : namesakes;
  const searchedAs = member && byName.length > 1 ? member.personId : (member?.name ?? op.who);
  const keys = new Set(member && byName.length > 1 ? [member.personId] : [personKey(searchedAs), ...byName.map((m) => m.id)]);

  const { results } = await ctx.db
    .prepare(
      `SELECT a.note_id, a.line, a.name, n.title, n.text, n.updated_at FROM mentions a JOIN notes n ON n.id = a.note_id
       WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "live")} AND a.who IN (SELECT value FROM json_each(?3))
       ORDER BY n.updated_at DESC, n.id, a.line LIMIT ?4`,
    )
    .bind(ctx.workspaceId, ctx.sight.bind, JSON.stringify([...keys]), op.limit + 1)
    .all<{ note_id: string; line: number; name: string; title: string; text: string; updated_at: number }>();
  const listed = results.slice(0, op.limit).map((r) => ({ ...r, said: r.text.split("\n")[r.line] ?? "" }));
  const ids = listed.flatMap((r) => mentionsOn(r.said).map((m) => m.target)).filter(isPersonId);
  const shown = (await membersMeant(ctx, ids)).byId;
  const name = member?.name ?? (isPersonId(op.who) ? (results[0]?.name ?? op.who) : op.who);

  // A contact is the asker's own, read from their data sources: an agent limited to folders is refused those, as contact.list is.
  const theirs = ctx.personId !== null && ctx.actor.kind !== "visitor" && !ctx.sight.within;
  // Matched by the member's email only for an asker the member list tells it to: for anyone else a match would confirm a guess.
  const emails = new Set(toldEmail ? [toldEmail.toLowerCase()] : []);
  const contacts = theirs ? await contactCards(asker(ctx), (c) => folded(c.name) === folded(name) || c.emails.some((e) => emails.has(e.value.toLowerCase()))) : [];

  const query = `mentions:${writtenValue(searchedAs)}`;
  const todoQuery = `assignee:${writtenValue(searchedAs)}`;
  const todoList = Op.parse({ type: "todo.list", query: todoQuery }) as Extract<Op, { type: "todo.list" }>;
  const { todos } = await HANDLERS["todo.list"].run(ctx, todoList);
  return {
    who,
    name,
    member,
    contacts,
    todos,
    mentionedIn: listed.map((r) => ({ noteId: r.note_id, noteTitle: r.title, line: r.line, text: lineAsShown(r.said, shown, keys), updatedAt: r.updated_at })),
    more: results.length > op.limit,
    query,
    todoQuery,
  };
}

export const MAX_ANSWER_LINES = 2000;

const HANDLERS: { [K in OpType]: Handler<K> } = {
  "note.list": {
    needs: "view",
    async run(ctx, op) {
      // A list is where titles are read, so it is where the ones made by an older rule are made again.
      await mend(ctx);
      // A folder the asker can't see lists nothing. The note stays in the unfiltered list, with no folder, as note.read says.
      const { results } = await ctx.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND (?2 IS NULL OR (n.folder_id = ?2 AND EXISTS (SELECT 1 FROM folders f WHERE f.workspace_id = ?1 AND f.id = ?2 AND ${SEEN_FOLDER("f", "?4")}))) AND (?3 IS NULL OR n.updated_at >= ?3 OR n.state_at >= ?3) AND ${SEEN("n", "?4", listing(op.includeArchived))}
             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM note_tags g WHERE g.note_id = n.id AND g.tag = ?5))
           ORDER BY n.updated_at DESC`,
        )
        .bind(ctx.workspaceId, op.folderId ?? null, op.updatedSince ?? null, ctx.sight.bind, op.tag === undefined ? null : nameKey(op.tag))
        .all<SummaryRow>();
      return results.map((row) => toSummary(ctx, row));
    },
  },

  "note.create": {
    needs: "edit",
    async run(ctx, op) {
      const folder = await loadFolder(ctx, op.folderId, "edit");
      const id = newId();
      const revision = op.text ? 1 : 0;
      const { text, unresolved } = await storedAs(ctx, op.text, "", op);
      const row: NoteRow = { id, folder_id: folder.id, revision, created_at: ctx.now, created_by: ctx.personId, private_owner: null, indexed: MADE, ...NEW, ...written(ctx, text) };
      const insertNote = ctx.db
        .prepare(
          `INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, snippet, open_todos, created_at, updated_at, updated_by, updated_by_kind, updated_by_owner, created_by, created_by_kind, indexed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.workspaceId, row.folder_id, revision, row.text, row.title, row.snippet, row.open_todos, row.created_at, row.updated_at, row.updated_by, row.updated_by_kind, row.updated_by_owner, row.created_by, ctx.author.kind, row.indexed);
      await intoFolder(ctx.db.batch(text ? [insertNote, insertChange(ctx, id, 1, 0, "", changesBetween("", text)), ...deriving(ctx, id, text, { was: "" })] : [insertNote, ...searching(ctx, id, text)]));
      return linked(toNote(ctx, row), unresolved);
    },
  },

  "note.read": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "opens");
      if (op.revision !== undefined && op.revision > row.revision) throw new OpError("not_found", `The note has no revision ${op.revision}`);
      const note = op.revision === undefined || op.revision === row.revision ? toNote(ctx, row) : toNote(ctx, row, (await replay(ctx, op.id, op.revision, row.revision)).text, op.revision);
      // Reading notes is not reading uploads: a plugin is told nothing of the ones a note refers to. Its mentions are as written, by `membersMeant`.
      return { ...note, links: await linksOf(ctx, note.text, "any"), mentions: await mentionsOf(ctx, note.text), uploads: ctx.shutOff ? [] : await referred(ctx, note.text, "any") };
    },
  },

  "note.backlinks": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "opens");
      // An archived note keeps its links, so it is still what links here. A note in Trash is in no listing but Trash.
      return (await seenAmong(ctx, "kept", "SELECT source_id FROM links WHERE target_id = ?2", row.id)).map((from) => toSummary(ctx, from));
    },
  },

  "links.rebuild": rebuild,

  "todo.list": {
    needs: "view",
    async run(ctx, op) {
      await mend(ctx);
      // The folder narrows inside what the asker sees and never widens it: one they can't see is no folder.
      const folder = op.folderId === undefined ? null : (await loadFolder(ctx, op.folderId, "view")).id;
      const due = (cmp: Filter["cmp"], value: string): Filter => ({ kind: "filter", key: "due", cmp, value });
      const { query, covering, condition, bind, prepare } = await finding(ctx, "todos", op, [
        ...(folder ? [{ kind: "filter", key: "folder", cmp: "=", value: folder } as const] : []),
        ...(op.tag === undefined ? [] : [{ kind: "filter", key: "tag", cmp: "=", value: nameKey(op.tag) } as const]),
        ...(op.dueFrom ? [due(">=", op.dueFrom)] : []),
        ...(op.dueTo ? [due("<=", op.dueTo)] : []),
        ...(op.noDue ? [{ kind: "not", of: { kind: "filter", key: "has", cmp: "=", value: "due" } } as const] : []),
        ...(op.importance ? [any(op.importance.map((level): Filter => ({ kind: "filter", key: "priority", cmp: "=", value: PRIORITIES[level] })))] : []),
        ...(op.noteId ? [{ kind: "note", id: op.noteId } as const] : []),
        ...(op.assignee === undefined ? [] : [{ kind: "filter", key: "assignee", cmp: "=", value: op.assignee } as const]),
        ...(op.assignedToMe ? [{ kind: "filter", key: "assignee", cmp: "=", value: "@me" } as const] : []),
        ...OLD.completed(op.includeCompleted),
        ...OLD.archived(op.includeArchived),
      ]);
      // The query's sort: says the order where it has one, and `sort` where it hasn't. The done ones are last either way, and a
      // word the Todos page's Sort menu offers breaks its ties as the menu's order does.
      const sort = query.sort ? TODO_SORTS.find((s) => TODO_SORT_WORDS[s] === query.sort) : op.sort;
      const order = `t.done, ${sort ? TODO_ORDER[sort] : orderOf(query.sort!)}`;
      const { results } = await prepare(
        `SELECT t.note_id, t.line, t.done, t.importance, t.due, t.text, n.title, n.revision, n.folder_id, n.private_owner,
           (SELECT json_group_array(name) FROM (SELECT g.name FROM note_tags g WHERE g.note_id = t.note_id ORDER BY g.rowid)) AS tags
         FROM todos t JOIN notes n ON n.id = t.note_id
         WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", covering)} AND ${condition}
         ORDER BY ${order}, t.note_id, t.line
         LIMIT ${bind(op.limit + 1)} OFFSET ${bind(op.offset)}`,
      ).all<{ note_id: string; line: number; done: number; importance: ListedTodo["importance"]; due: string | null; text: string; title: string; revision: number; folder_id: string; private_owner: string | null; tags: string }>();
      const page = results.slice(0, op.limit).map((r) => ({ r, todo: parseTodo(r.text) }));
      const members = (await membersMeant(ctx, page.flatMap(({ todo }) => todo?.assignees.map((a) => a.target).filter(isPersonId) ?? []))).byId;
      const tagged = page.filter(({ r }) => r.tags !== "[]").map(({ r }) => r.note_id);
      const texts = new Map(
        tagged.length === 0 ? [] : (await ctx.db.prepare("SELECT id, text FROM notes WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...new Set(tagged)])).all<{ id: string; text: string }>()).results.map((n) => [n.id, n.text]),
      );
      return {
        todos: page.map(({ r, todo }) => {
          return {
            noteId: r.note_id,
            noteTitle: r.title,
            revision: r.revision,
            line: r.line,
            text: r.text,
            done: r.done === 1,
            importance: r.importance,
            due: r.due,
            every: todo?.every?.written ?? null,
            recurs: todo?.every ? ruleLabel(todo.every.rule) : null,
            lastDone: todo?.lastDone ? { on: todo.lastDone.on, times: todo.lastDone.times } : null,
            tags: JSON.parse(r.tags) as string[],
            tagsElsewhere: tagsBesides(texts.get(r.note_id) ?? "", r.line),
            assignees: mentionedIn(members, todo?.assignees ?? []),
            words: todo?.words ?? r.text,
            access: itemLevel(ctx.sight, { id: r.note_id, folder_id: r.folder_id, private_owner: r.private_owner }) === "edit" ? "edit" : "view",
          };
        }),
        next: results.length > op.limit ? op.offset + op.limit : null,
      };
    },
  },

  "todo.filters": {
    needs: "view",
    async run(ctx, op) {
      await mend(ctx);
      const covering = listing(op.includeArchived);
      const [tags, assigned] = await ctx.db.batch<{ name: string; who?: string }>([
        ctx.db
          .prepare(
            `SELECT MIN(g.name) AS name FROM note_tags g JOIN notes n ON n.id = g.note_id
             WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", covering)} AND EXISTS (SELECT 1 FROM todos t WHERE t.note_id = g.note_id) GROUP BY g.tag ORDER BY g.tag`,
          )
          .bind(ctx.workspaceId, ctx.sight.bind),
        ctx.db
          .prepare(
            `SELECT a.who, MIN(a.name) AS name FROM mentions a JOIN notes n ON n.id = a.note_id
             WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", covering)} AND EXISTS (SELECT 1 FROM todos t WHERE t.note_id = a.note_id AND t.line = a.line) GROUP BY a.who`,
          )
          .bind(ctx.workspaceId, ctx.sight.bind),
      ]);
      const members = (await membersMeant(ctx, assigned!.results.map((r) => r.who!).filter(isPersonId))).byId;
      const assignees = assigned!.results.map((r) => mentioned(members, r.who!, r.name));
      // Members first, then everyone else, each by name.
      assignees.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id ?? "").localeCompare(b.id ?? ""));
      return { tags: tags!.results.map((r) => r.name), assignees };
    },
  },

  "todo.set": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async (): Promise<Written | null> => {
        const row = await loadNote(ctx, op.id, "edit", "refused");
        const { id: _, type: __, revision: ___, line: ____, text: listedAs, on, assign, unassign, ...rest } = op;
        // A member is assigned by their id with their name, whichever they were named by, as a mention a write introduces is stored.
        // Taking a todo from a name takes it from the member so named too, whom the line holds by their id.
        const meant = await membersMeant(ctx, [assign, unassign].filter((who) => who !== undefined));
        const theirs = assign === undefined ? undefined : memberMeant(meant, assign);
        const taken = unassign === undefined ? undefined : memberMeant(meant, unassign);
        const from = unassign === undefined ? undefined : [unassign, ...(taken ? [taken.id] : [])];
        if (from && !parseTodo(listedAs)?.assignees.some((a) => from.map(personKey).includes(mentionKey(a)))) throw new OpError("invalid", `This todo isn't assigned to ${quoted(unassign!)}`);
        const change = { ...rest, ...(from && { unassign: from }) };
        const mine = change.done || change.skip ? await completing(ctx, on) : null;
        let wanted: Completed;
        try {
          // Someone who isn't told the members assigns by an id the note already holds, as the Todos page does: the name is the one the note calls them.
          const called = assign === undefined || theirs ? undefined : mentionsIn(row.text).find((m) => m.target === assign && m.label)?.label;
          wanted = changeTodo(listedAs, assign === undefined ? change : { ...change, assign: theirs ?? (called ? { id: assign, name: called } : { name: assign }) }, mine?.day ?? "");
        } catch (err) {
          throw err instanceof RangeError ? new OpError("invalid", err.message) : err;
        }
        const todo = await listedTodo(ctx, row, op);
        // Asked again after it was done, as a double click or a call that failed on its way back is: the
        // line already says so. A recurring todo's line says so too, with the due date this call moved it to.
        if (todo && todo.text !== listedAs && todo.text === wanted.line) return toNote(ctx, row);
        if (!todo || todo.text !== listedAs) throw new OpError("conflict", "This todo was changed since it was listed. List the todos again.");
        if (wanted.line === listedAs) return toNote(ctx, row);
        const changes = changesBetween(row.text, row.text.slice(0, todo.from) + wanted.line + row.text.slice(todo.from + todo.text.length));
        if (wanted.filed) return recordCompleting(ctx, row, changes, row.revision, [{ line: wanted.filed, at: todo.from }], mine!);
        const next = await record(ctx, row, changes, row.revision);
        return next && toNote(ctx, next);
      }),
  },

  "todo.history": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "opens");
      const todo = await listedTodo(ctx, row, op);
      if (!todo) throw new OpError("conflict", "This todo was changed since it was listed. List the todos again.");
      const mine = (await completionsNow(ctx, row.id)).filter(({ at }) => at === todo.from).map((f) => f.completion);
      const dailies = [...new Set(mine.flatMap((c) => (c.daily_note_id ? [c.daily_note_id] : [])))];
      const seen = new Set(dailies.length ? (await seenAmong(ctx, "any", IDS_IN, JSON.stringify(dailies))).map((r) => r.id) : []);
      return {
        completions: mine
          .map((c) => ({ on: c.done_on, at: c.created_at, by: authorOf(c.author_kind, c.author_id, c.name, c.agent_owner), dailyNoteId: c.daily_note_id && seen.has(c.daily_note_id) ? c.daily_note_id : null }))
          .reverse(),
      };
    },
  },

  "daily.open": {
    needs: "edit",
    members: true,
    run: (ctx, op) =>
      settle(async () => {
        const mine = await completing(ctx, op.on);
        const daily = await usableDaily(ctx, mine.day);
        if (daily.note) {
          if (itemLevel(ctx.sight, daily.note) === "none") throw new OpError("not_found", NO_SUCH_NOTE);
          return toNote(ctx, daily.note);
        }
        const made = newDaily(ctx, mine, dailyText(mine.day), await dailyFolder(ctx, mine.settings), daily.stale);
        if (!made) throw new OpError("forbidden", `You can't make notes in "${mine.settings.folder}", the folder your settings name for daily notes`);
        return (await landed(ctx, made.statements)) ? toNote(ctx, made.row) : null;
      }),
  },

  "daily.find": {
    needs: "view",
    members: true,
    async run(ctx, op) {
      const { note } = await usableDaily(ctx, (await completing(ctx, op.on)).day);
      return { note: note && itemLevel(ctx.sight, note) !== "none" ? toSummary(ctx, note) : null };
    },
  },

  // A read, and only that: what the asker can't see now is left out here and kept, so a pin is there again when the note is.
  "pin.list": {
    needs: "view",
    async run(ctx, op) {
      const { results } = await ctx.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} JOIN pins k ON k.note_id = n.id AND k.person_id = ?2 WHERE n.workspace_id = ?1 AND ${SEEN("n", "?3", listing(op.includeArchived))} ORDER BY k.pinned_at, n.id`)
        .bind(ctx.workspaceId, ctx.personId, ctx.sight.bind)
        .all<SummaryRow>();
      return results.map((row) => toSummary(ctx, row));
    },
  },

  "pin.set": {
    needs: "view",
    changes: true,
    async run(ctx, op) {
      if (op.pinned) {
        const note = await loadNote(ctx, op.id, "view", "refused");
        await ctx.db.prepare("INSERT INTO pins (workspace_id, person_id, note_id, pinned_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(ctx.workspaceId, ctx.personId, note.id, ctx.now).run();
      } else {
        // Asked of a note they can't see, or of none, it answers the same: there was no pin of theirs to take.
        // And only a note they can see: an agent limited to folders takes no pin of its member's from a note outside them.
        await ctx.db
          .prepare(`DELETE FROM pins WHERE workspace_id = ?1 AND person_id = ?2 AND note_id = ?3 AND EXISTS (SELECT 1 FROM notes n WHERE n.id = ?3 AND ${SEEN("n", "?4", "any")})`)
          .bind(ctx.workspaceId, ctx.personId, op.id, ctx.sight.bind)
          .run();
      }
      return { id: op.id, pinned: op.pinned };
    },
  },

  // It is the member's own and in no folder, so an agent limited to folders isn't told it.
  "visit.read": {
    needs: "view",
    own: true,
    run: (ctx) => visit(ctx),
  },

  // Only the member says what they have read, so an agent can't move it for them: see NOT_FOR_AGENTS.
  "visit.mark": {
    needs: "view",
    by: "member",
    async run(ctx, op) {
      await ctx.db
        .prepare("INSERT INTO visits (workspace_id, person_id, read_until) VALUES (?1, ?2, ?3) ON CONFLICT (workspace_id, person_id) DO UPDATE SET read_until = MAX(read_until, excluded.read_until)")
        .bind(ctx.workspaceId, ctx.personId, Math.min(op.until, ctx.now))
        .run();
      return visit(ctx);
    },
  },

  "todos.rebuild": rebuild,

  "note.write": {
    needs: "edit",
    run: async (ctx, op) => {
      let unresolved: UnresolvedLink[] = [];
      const written = await settle(async (): Promise<Written | null> => {
        const row = await loadNote(ctx, op.id, "edit", "refused");
        if (op.writeId) {
          const recorded = await ctx.db.prepare("SELECT 1 FROM changes WHERE note_id = ? AND write_id = ?").bind(row.id, op.writeId).first();
          if (recorded) return toNote(ctx, row);
        }
        if (op.baseRevision > row.revision) throw new OpError("invalid", `The note has no revision ${op.baseRevision}`);
        const base = op.baseRevision === row.revision ? { text: row.text, since: null } : await replay(ctx, row.id, op.baseRevision, row.revision);
        const resolved = await storedAs(ctx, op.text, base.text, op);
        const stored = resolved.text;
        unresolved = resolved.unresolved;
        const changes = base.since ? rebased(base.text, stored, base.since) : changesBetween(base.text, stored);
        if (changes.empty) return toNote(ctx, row);
        // A write that checks a recurring todo's box completes it, as todo.set does, whoever wrote it and however.
        const merged = applyChanges(changes, row.text);
        const checked = checkedOff(row.text, changes);
        if (checked.length) {
          const mine = await completing(ctx, op.on);
          // A todo completed since the writer read the note is not completed again by a check made on what they read, as this same write sent twice would.
          const since = op.baseRevision === row.revision ? [] : (await completionsNow(ctx, row.id)).filter((f) => f.completion.revision > op.baseRevision).map((f) => changes.mapPos(f.at, 1));
          const rolled = rolledForward(merged, checked, mine.day, (todo) => since.some((at) => todo.from <= at && at <= todo.from + todo.text.length));
          // Read again as the smallest edit, which leaves the box as it was: the same write sent again then checks it again, and is seen to.
          const completed = changesBetween(row.text, rolled.text);
          if (completed.empty) return toNote(ctx, row);
          if (rolled.filed.length) return recordCompleting(ctx, row, completed, op.baseRevision, rolled.filed, mine, { writeId: op.writeId });
          const next = await record(ctx, row, completed, op.baseRevision, { writeId: op.writeId });
          return next && toNote(ctx, next);
        }
        const next = await record(ctx, row, changes, op.baseRevision, { writeId: op.writeId });
        return next && toNote(ctx, next);
      });
      return linked(written, unresolved);
    },
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id, "view", "opens");
      await countLines(ctx, [op.id]);
      const { results } = await ctx.db.prepare(`SELECT ${CHANGE_COLUMNS} WHERE c.note_id = ? ORDER BY c.revision`).bind(op.id).all<ChangeRow>();
      const standing = standingOf(results.map(stepOf));
      return results.map((r) => toEntry(r, standing));
    },
  },

  "note.diff": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "opens");
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no change ${op.revision}`);
      const { text, since } = await replay(ctx, row.id, op.revision - 1, op.revision);
      return lineDiff(text, since[0]!);
    },
  },

  "note.blame": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "opens");
      await countLines(ctx, [row.id]);
      const { results } = await ctx.db.prepare(`SELECT c.diff, ${CHANGE_COLUMNS} WHERE c.note_id = ? AND c.revision <= ? ORDER BY c.revision`).bind(row.id, row.revision).all<ChangeRow & { diff: string }>();
      const lines = runsOfLines(blame(results.map((r) => ({ changes: ChangeSet.fromJSON(JSON.parse(r.diff)), reverts: revertsOf(r.reverts) }))));
      const named = new Set(lines.map((run) => run.revision));
      const standing = standingOf(results.map(stepOf));
      const changes = results.filter((r) => named.has(r.revision)).map((r) => toEntry(r, standing));
      const owners = [...new Set(changes.flatMap((c) => (c.author.kind === "agent" ? [c.author.onBehalfOf] : [])))];
      // Who an agent is for is who is in the workspace, which only someone who may list its members is told.
      const { results: members } = owners.length && ctx.role && !ctx.sight.within
        ? await ctx.db
            .prepare("SELECT p.id, p.name FROM members m JOIN people p ON p.id = m.person_id WHERE m.workspace_id = ? AND p.id IN (SELECT value FROM json_each(?))")
            .bind(ctx.workspaceId, JSON.stringify(owners))
            .all<{ id: string; name: string }>()
        : { results: [] };
      return { revision: row.revision, text: row.text, lines, changes, owners: Object.fromEntries(members.map((p) => [p.id, p.name])) };
    },
  },

  "note.label": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "refused");
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no revision ${op.revision}`);
      if (op.name === null) {
        await ctx.db.prepare("DELETE FROM labels WHERE note_id = ? AND revision = ?").bind(row.id, op.revision).run();
      } else {
        try {
          await ctx.db
            .prepare(
              `INSERT INTO labels (note_id, revision, name, author_kind, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (note_id, revision) DO UPDATE SET name = excluded.name, author_kind = excluded.author_kind, author_id = excluded.author_id, created_at = excluded.created_at`,
            )
            .bind(row.id, op.revision, op.name, ctx.author.kind, authorId(ctx), ctx.now)
            .run();
        } catch (err) {
          if (err instanceof Error && /UNIQUE constraint failed: labels\.note_id, labels\.name/.test(err.message)) throw new OpError("invalid", `Another revision of this note is already labeled "${op.name}"`);
          throw err;
        }
      }
      return { id: row.id, revision: op.revision, label: op.name };
    },
  },

  "note.revert": {
    needs: "edit",
    run: (ctx, op) => takeBack(ctx, op.id, revertTo(op.revision), op.resolve),
  },

  "note.revertChanges": {
    needs: "edit",
    run: (ctx, op) => takeBack(ctx, op.id, revertOf(op.revisions), op.resolve),
  },

  "note.previewRevert": {
    // It shows nothing a viewer can't already read: the note at any revision, and every change's diff.
    needs: "view",
    async run(ctx, op) {
      const author = op.author;
      const choose: Choose = author ? revertBy(author) : op.to !== undefined ? revertTo(op.to) : revertOf(op.revisions!);
      const { row, history, reverts, found, changes } = await takingBack(ctx, op.id, "view", choose, op.resolve);
      return { revision: row.revision, revisions: reverts?.revisions ?? [], diff: lineDiff(row.text, changes), overlaps: found.overlaps, conflicts: toldConflicts(history, found, op.revisions) };
    },
  },

  "note.undo": {
    needs: "edit",
    run: (ctx, op) =>
      takeBack(ctx, op.id, (history, reverted) => {
        const target = undoTarget(history.filter((c) => isBy(ctx, c.author)), reverted);
        if (target === null) throw new OpError("invalid", "There's nothing of yours to undo in this note");
        return { how: "undo", revisions: [target] };
      }),
  },

  "note.redo": {
    needs: "edit",
    run: (ctx, op) =>
      takeBack(ctx, op.id, (history, reverted) => {
        const target = redoTarget(history.filter((c) => isBy(ctx, c.author)), reverted);
        if (target === null) throw new OpError("invalid", "There's nothing of yours to redo in this note");
        return { how: "redo", revisions: [target] };
      }),
  },

  "history.summary": {
    needs: "view",
    async run(ctx, op) {
      const narrowed = `n.workspace_id = ?1 AND ${SEEN("n", "?6", op.noteIds ? "any" : "kept")}
             AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
             AND (?4 IS NULL OR c.created_at >= ?4)
             AND (?5 IS NULL OR c.created_at < ?5)
             AND (?7 IS NULL OR c.author_kind = ?7)`;
      const binds = [ctx.workspaceId, op.noteIds ? JSON.stringify(op.noteIds) : null, op.authors ? JSON.stringify(op.authors) : null, op.from ?? null, op.to ?? null, ctx.sight.bind, kindOf(op.by)];
      interface Row {
        note_id: string;
        title: string;
        changes: number;
        added: number;
        removed: number;
        first_at: number;
        last_at: number;
        uncounted: number;
      }
      const read = () =>
        ctx.db
          .prepare(
            `SELECT c.note_id, n.title, COUNT(*) AS changes, COALESCE(SUM(c.added), 0) AS added, COALESCE(SUM(c.removed), 0) AS removed,
               MIN(c.created_at) AS first_at, MAX(c.created_at) AS last_at, MAX(c.added IS NULL) AS uncounted
             FROM changes c JOIN notes n ON n.id = c.note_id
             WHERE ${narrowed}
             GROUP BY c.note_id
             HAVING ?8 IS NULL OR last_at < ?8 OR (last_at = ?8 AND c.note_id < ?9)
             ORDER BY last_at DESC, c.note_id DESC
             LIMIT ?10`,
          )
          .bind(...binds, op.before?.lastAt ?? null, op.before?.noteId ?? null, op.limit + 1)
          .all<Row>();
      let { results } = await read();
      const uncounted = results.filter((r) => r.uncounted).map((r) => r.note_id);
      if (uncounted.length) {
        await countLines(ctx, uncounted);
        ({ results } = await read());
      }
      const page = results.slice(0, op.limit);
      const last = results.length > op.limit ? page.at(-1)! : null;
      const { results: wrote } = await ctx.db
        .prepare(
          `SELECT c.note_id, c.author_kind, c.author_id, ${NAME} AS name, a.person_id AS agent_owner
           FROM changes c
           JOIN notes n ON n.id = c.note_id
           ${named("c.author_kind", "c.author_id")}
           WHERE ${narrowed} AND c.note_id IN (SELECT value FROM json_each(?8))
           GROUP BY c.note_id, c.author_kind, c.author_id
           ORDER BY MAX(c.created_at) DESC, c.author_id`,
        )
        .bind(...binds, JSON.stringify(page.map((r) => r.note_id)))
        .all<Pick<ChangeRow, "note_id" | "author_kind" | "author_id" | "name" | "agent_owner">>();
      const authors = Map.groupBy(wrote, (r) => r.note_id);
      return {
        notes: page.map((r) => ({
          noteId: r.note_id,
          noteTitle: r.title,
          changes: r.changes,
          added: r.added,
          removed: r.removed,
          firstAt: r.first_at,
          lastAt: r.last_at,
          authors: (authors.get(r.note_id) ?? []).map((w) => authorOf(w.author_kind, w.author_id, w.name, w.agent_owner)),
        })),
        next: last && { lastAt: last.last_at, noteId: last.note_id },
      };
    },
  },

  "history.list": {
    needs: "view",
    async run(ctx, op) {
      const read = () =>
        ctx.db
          .prepare(
            `SELECT n.title, ${CHANGE_COLUMNS}
             JOIN notes n ON n.id = c.note_id
             WHERE n.workspace_id = ?1 AND ${SEEN("n", "?10", op.noteIds ? "any" : "kept")}
               AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
               AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
               AND (?12 IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(?12) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
               AND (?4 IS NULL OR c.created_at >= ?4)
               AND (?5 IS NULL OR c.created_at < ?5)
               AND (?6 IS NULL OR (c.created_at, c.note_id, c.revision) < (?6, ?7, ?8))
               AND (?11 IS NULL OR c.author_kind = ?11)
             ORDER BY c.created_at DESC, c.note_id DESC, c.revision DESC
             LIMIT ?9`,
          )
          .bind(
            ctx.workspaceId,
            op.noteIds ? JSON.stringify(op.noteIds) : null,
            op.authors ? JSON.stringify(op.authors) : null,
            op.from ?? null,
            op.to ?? null,
            op.before?.createdAt ?? null,
            op.before?.noteId ?? null,
            op.before?.revision ?? null,
            op.limit + 1,
            ctx.sight.bind,
            kindOf(op.by),
            op.notAuthors ? JSON.stringify(op.notAuthors) : null,
          )
          .all<ChangeRow & { title: string }>();
      let { results } = await read();
      const uncounted = [...new Set(results.filter((r) => r.added === null).map((r) => r.note_id))];
      if (uncounted.length) {
        await countLines(ctx, uncounted);
        ({ results } = await read());
      }
      const page = results.slice(0, op.limit);
      const last = results.length > op.limit ? page.at(-1)! : null;

      // Whether a change still stands needs every later change, and its diff needs the text before it.
      const { results: recorded } = await ctx.db
        .prepare(`SELECT note_id, revision, reverts${op.diffs ? ", diff" : ""} FROM changes WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY note_id, revision`)
        .bind(JSON.stringify([...new Set(page.map((r) => r.note_id))]))
        .all<{ note_id: string; revision: number; reverts: string | null; diff?: string }>();
      const standing = new Map<string, Standing>();
      const diffs = new Map<string, HistoryEntry["diff"]>();
      for (const [noteId, rows] of Map.groupBy(recorded, (r) => r.note_id)) {
        standing.set(noteId, standingOf(rows.map(stepOf)));
        if (!op.diffs) continue;
        const shown = new Set(page.filter((r) => r.note_id === noteId).map((r) => r.revision));
        let text = "";
        for (const row of rows) {
          const changes = ChangeSet.fromJSON(JSON.parse(row.diff!));
          if (shown.has(row.revision)) diffs.set(`${noteId}/${row.revision}`, lineDiff(text, changes));
          text = applyChanges(changes, text);
        }
      }
      return {
        changes: page.map((r) => ({ ...toEntry(r, standing.get(r.note_id)!), noteId: r.note_id, noteTitle: r.title, diff: diffs.get(`${r.note_id}/${r.revision}`) ?? null })),
        next: last && { createdAt: last.created_at, noteId: last.note_id, revision: last.revision },
      };
    },
  },

  "history.authors": {
    needs: "view",
    async run(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT DISTINCT c.author_kind, c.author_id, ${NAME} AS name, a.person_id AS agent_owner
           FROM changes c
           JOIN notes n ON n.id = c.note_id
           ${named("c.author_kind", "c.author_id")}
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "kept")} ORDER BY name COLLATE NOCASE, c.author_id`,
        )
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<Pick<ChangeRow, "author_kind" | "author_id" | "name" | "agent_owner">>();
      return results.map((r) => authorOf(r.author_kind, r.author_id, r.name, r.agent_owner));
    },
  },

  "history.revertAuthor": {
    needs: "edit",
    async run(ctx, op) {
      const theirs = (c: { author: AuthorRef }) => sameAuthor(c.author, op.author);
      // Only this page's notes are named here and read below, however many more the author changed.
      const { results } = await ctx.db
        .prepare(
          `SELECT n.id, n.title FROM notes n
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?7", "kept")}
             AND (?2 IS NULL OR n.id IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR n.id > ?3)
             AND EXISTS (SELECT 1 FROM changes c WHERE c.note_id = n.id AND c.author_kind = ?4 AND c.author_id = ?5)
           ORDER BY n.id LIMIT ?6`,
        )
        .bind(ctx.workspaceId, op.noteIds ? JSON.stringify(op.noteIds) : null, op.after ?? null, op.author.kind, op.author.id, REVERT_AUTHOR_NOTES + 1, ctx.sight.bind)
        .all<{ id: string; title: string }>();
      const page = results.slice(0, REVERT_AUTHOR_NOTES);

      const answer: Results["history.revertAuthor"] = { reverted: [], emptied: [], failed: [], next: results.length > page.length ? page.at(-1)!.id : null };
      for (const { id, title } of page) {
        let reverts: Reverts | null = null;
        try {
          const { text, ...note } = await takeBack(ctx, id, (history) => (reverts = revertOfAuthor(history, theirs)), op.resolve?.[id]);
          if (!reverts) continue;
          answer.reverted.push({ note, revisions: (reverts as Reverts).revisions });
          if (text.trim()) continue;
          // A note someone wrote in since is left where it is: only one still empty goes.
          const trashed = op.trashEmptied && (await trashing(ctx, id, "state <> 'trashed' AND trim(text, char(9, 10, 13, 32)) = ''")) > 0;
          answer.emptied.push({ noteId: id, title, trashed });
        } catch (err) {
          // One note that can't take the change doesn't keep it from the notes after, or lose the answer for the notes before.
          answer.failed.push({ noteId: id, title, message: err instanceof OpError ? err.message : "Common Ink couldn't change this note just now. Try again." });
        }
      }
      return answer;
    },
  },

  "history.diff": {
    needs: "view",
    async run(ctx, op) {
      const asked = new Map(op.changes.map((c) => [c.noteId, c.revisions]));
      const named = JSON.stringify([...asked.keys()]);
      const [read, recorded] = await ctx.db.batch<SummaryRow & ChangeRow & { diff: string }>([
        ctx.db.prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3", "any")}`).bind(ctx.workspaceId, named, ctx.sight.bind),
        ctx.db
          .prepare(`SELECT c.diff, ${CHANGE_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ?1 AND c.note_id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3", "any")} ORDER BY c.note_id, c.revision`)
          .bind(ctx.workspaceId, named, ctx.sight.bind),
      ]);
      const rows = Map.groupBy(recorded!.results, (r) => r.note_id);
      if (read!.results.length < asked.size) throw new OpError("not_found", NO_SUCH_NOTE);
      const notes = read!.results.map((note) => {
        const changes = rows.get(note.id) ?? [];
        const runs = runsOf(asked.get(note.id)!);
        if (runs.at(-1)!.to > changes.length) throw new OpError("not_found", `${note.title || "The note"} has no change ${runs.at(-1)!.to}`);
        const texts = new Map<number, string>([[0, ""]]);
        const wanted = new Set(runs.flatMap((r) => [r.from - 1, r.to]));
        let text = "";
        for (const row of changes.slice(0, runs.at(-1)!.to)) {
          text = applyChanges(ChangeSet.fromJSON(JSON.parse(row.diff)), text);
          if (wanted.has(row.revision)) texts.set(row.revision, text);
        }
        return {
          ...{ noteId: note.id, noteTitle: note.title, revision: note.revision },
          runs: runs.map((run) => {
            const made = changes.slice(run.from - 1, run.to);
            const authors = new Map(made.map((r) => [`${r.author_kind}:${r.author_id}`, authorOf(r.author_kind, r.author_id, r.name, r.agent_owner)]));
            return { ...run, saves: made.length, firstAt: made[0]!.created_at, lastAt: made.at(-1)!.created_at, authors: [...authors.values()], label: made.at(-1)!.label, diff: textDiff(texts.get(run.from - 1)!, texts.get(run.to)!) };
          }),
        };
      });
      notes.sort((a, b) => b.runs.at(-1)!.lastAt - a.runs.at(-1)!.lastAt || (a.noteId < b.noteId ? 1 : -1));
      let room = MAX_ANSWER_LINES;
      return {
        notes: notes.map((note): NoteDiff => {
          // A note comes with all its diffs or with none, so that asking for it alone always gives them.
          const fits = room > 0;
          const runs = note.runs.map(({ diff, ...run }): DiffRun => {
            room -= diff.hunks.reduce((sum, h) => sum + h.lines.length, 0);
            return { ...run, added: diff.added, removed: diff.removed, diff: fits ? diff : null };
          });
          return { ...note, runs, added: runs.reduce((sum, r) => sum + r.added, 0), removed: runs.reduce((sum, r) => sum + r.removed, 0) };
        }),
      };
    },
  },

  "history.previewRevert": {
    needs: "view",
    async run(ctx, op) {
      const read = await loadWithHistory(ctx, op.changes.map((c) => c.noteId));
      return op.changes.map((item): NoteRevertPreview => {
        const note = read.get(item.noteId);
        const none = { revisions: [], already: [], diff: { hunks: [], added: 0, removed: 0, omitted: 0, lines: 0 }, overlaps: [], conflicts: [] };
        if (!note) return { noteId: item.noteId, noteTitle: "", revision: 0, ...none, refused: NO_SUCH_NOTE };
        try {
          const { row, history, reverts, found, changes } = takingBackItem(note.row, note.history, item);
          return {
            ...titled(row),
            revision: row.revision,
            revisions: reverts?.revisions ?? [],
            already: item.revisions ? revertible(history, item.revisions).already : [],
            diff: lineDiff(row.text, changes),
            overlaps: found.overlaps,
            conflicts: toldConflicts(history, found, item.revisions),
          };
        } catch (err) {
          // One note that can't be reverted is no reason to show nothing of the others.
          if (!(err instanceof OpError)) throw err;
          return { ...titled(note.row), revision: note.row.revision, ...none, refused: err.message };
        }
      });
    },
  },

  "history.revert": {
    needs: "edit",
    async run(ctx, op) {
      const ids = op.changes.map((c) => c.noteId);
      const [read, filing] = await Promise.all([loadWithHistory(ctx, ids), filedElsewhere(ctx, ids)]);
      type Told = RevertedNotes["reverted"][number] | RevertedNotes["skipped"][number];
      const told: (Told | (() => Promise<Told>))[] = op.changes.map((item) => {
        const note = read.get(item.noteId);
        if (!note) return { noteId: item.noteId, noteTitle: "", why: "refused", message: NO_SUCH_NOTE };
        const { row, history } = note;
        const name = row.title || "Untitled";
        // Asked of each note, as `loadNote` asks it of one: a role that may edit doesn't say this note may be.
        if (!allows(itemLevel(ctx.sight, row), "edit")) return { ...titled(row), why: "refused", message: CANT_CHANGE };
        if (row.state === "trashed") return { ...titled(row), why: "refused", message: IN_TRASH };
        const moved: Told = { ...titled(row), why: "changed", message: `${name} has changed since this revert was previewed, so it was left as it is. Preview its revert again` };
        if (item.at !== undefined && item.at !== row.revision) return moved;
        try {
          const { reverts, changes, resolution } = takingBackItem(row, history, item);
          if (!reverts || applyChanges(changes, row.text) === row.text) return { ...titled(row), why: "nothing", message: `Nothing in ${name} would change` };
          return async () => {
            try {
              const taken = await recordTakenBack(ctx, row, history, reverts, changes, resolution, filing.has(row.id));
              // By the title it had: a revert can leave a note with another, or with none.
              return taken ? { ...titled(row), revision: taken.next.revision, reverted: reverts.revisions, ...(taken.unfiled && { unfiled: taken.unfiled }) } : moved;
            } catch (err) {
              if (!(err instanceof OpError)) throw err;
              return { ...titled(row), why: "refused", message: err.message };
            }
          };
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          return { ...titled(row), why: "refused", message: err.message };
        }
      });
      // Each note's revert is its own batch, so the notes are written at once and the request waits on
      // the database a few times, not once for each note. A note whose completions were filed on a
      // daily note changes that note too, so those go one at a time, after the rest.
      const writes = told.flatMap((t, i) => (typeof t === "function" ? [i] : []));
      const [alone, together] = [writes.filter((i) => filing.has(op.changes[i]!.noteId)), writes.filter((i) => !filing.has(op.changes[i]!.noteId))];
      await Promise.all(together.map(async (i) => (told[i] = await (told[i] as () => Promise<Told>)())));
      for (const i of alone) told[i] = await (told[i] as () => Promise<Told>)();
      const done: RevertedNotes = { reverted: [], skipped: [] };
      for (const t of told as Told[]) if ("why" in t) done.skipped.push(t);
      else done.reverted.push(t);
      return done;
    },
  },

  "note.move": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "refused");
      const folder = await loadFolder(ctx, op.folderId, "edit");
      if (folder.id !== row.folder_id) await intoFolder(ctx.db.prepare("UPDATE notes SET folder_id = ? WHERE id = ?").bind(folder.id, row.id).run());
      return toNote(ctx, { ...row, folder_id: folder.id });
    },
  },

  "note.archive": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "refused");
      const state = op.archived ? "archived" : "live";
      if (row.state === state) return toNote(ctx, row);
      await archiving(ctx, "notes", row.id, state);
      return toNote(ctx, { ...row, state, state_at: ctx.now });
    },
  },

  "note.trash": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "opens");
      if (row.state === "trashed") return toNote(ctx, row);
      await trashing(ctx, row.id);
      return toNote(ctx, { ...row, state: "trashed", state_at: ctx.now });
    },
  },

  "note.restore": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "opens");
      if (row.state !== "trashed") return { ...toNote(ctx, row), folderGone: false };
      const restored = await restoring(ctx, "notes", row);
      // Removed for good, or restored by someone else, in the moment since it was read.
      if (!restored) return { ...toNote(ctx, await loadNote(ctx, op.id, "edit", "opens")), folderGone: false };
      return { ...toNote(ctx, { ...row, state: restored.state, state_at: ctx.now }), folderGone: restored.folderGone };
    },
  },

  // A note the member made and left with nothing in it is not kept, not even in Trash. Only the member's own app does it, as they leave the note: see NOT_FOR_AGENTS.
  "note.discard": {
    needs: "edit",
    by: "member",
    members: true,
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "refused");
      const made = await ctx.db.prepare("SELECT created_by_kind FROM notes WHERE id = ?").bind(row.id).first<{ created_by_kind: string | null }>();
      if (made?.created_by_kind !== "member" || row.created_by !== ctx.personId) throw new OpError("invalid", NOT_DISCARDED);
      const { results } = await ctx.db.prepare("SELECT diff, author_kind, author_id FROM changes WHERE note_id = ? ORDER BY revision").bind(row.id).all<{ diff: string; author_kind: string; author_id: string }>();
      if (results.length !== row.revision) throw new OpError("invalid", NOT_DISCARDED);
      let text = "";
      for (const change of results) {
        text = applyChanges(ChangeSet.fromJSON(JSON.parse(change.diff)), text);
        if (change.author_kind !== "member" || change.author_id !== ctx.personId || !blank(text)) throw new OpError("invalid", NOT_DISCARDED);
      }
      // Put in Trash at no time at all, which nothing else is, so the removal below takes this note as it is now, or nothing if it was written to since it was read.
      const done = await ctx.db.batch([
        ctx.db.prepare("UPDATE notes SET state = 'trashed', state_at = 0 WHERE id = ? AND revision = ? AND state != 'trashed'").bind(row.id, row.revision),
        ...removing(ctx.db, row.id, 0),
      ]);
      // The first statement is the one that says whether the note was still as it was read; the rest do nothing unless it did.
      if (!done[0]!.meta.changes) throw new OpError("conflict", "The note was written to as it was being discarded, so it is kept");
      await forgetRemoved(ctx.db);
      return { id: row.id };
    },
  },

  // Removing a note for good is the one change nothing takes back. Only the member does it: see NOT_FOR_AGENTS.
  "note.purge": {
    needs: "edit",
    by: "member",
    members: true,
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit", "opens");
      if (ctx.role !== "admin" && row.created_by !== ctx.personId && row.private_owner !== ctx.personId) throw new OpError("forbidden", "Only an admin or the member who made a note can delete it for good");
      if (row.state !== "trashed") throw new OpError("invalid", "Only a note in Trash can be deleted for good. Move it to Trash first.");
      await ctx.db.batch(removing(ctx.db, row.id));
      await forgetRemoved(ctx.db);
      return { id: row.id };
    },
  },

  "trash.list": {
    needs: "view",
    async run(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT n.state_by, n.state_by_kind, COALESCE(tp.name, ta.name, json_extract(tpi.manifest, '$.name')) AS state_by_name, ta.person_id AS state_by_owner, ${SUMMARY_COLUMNS}
           LEFT JOIN people tp ON n.state_by_kind = 'member' AND tp.id = n.state_by
           LEFT JOIN agents ta ON n.state_by_kind = 'agent' AND ta.id = n.state_by
           LEFT JOIN plugin_installs tpi ON n.state_by_kind = 'plugin' AND tpi.id = n.state_by
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "trashed")} ORDER BY n.state_at DESC, n.id`,
        )
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<SummaryRow & { state_by: string; state_by_kind: AuthorRef["kind"]; state_by_name: string | null; state_by_owner: string | null }>();
      return results.map((row): TrashedNote => ({ ...toSummary(ctx, row), trashedAt: row.state_at!, trashedBy: authorOf(row.state_by_kind, row.state_by, row.state_by_name, row.state_by_owner) }));
    },
  },

  "tag.list": {
    needs: "view",
    async run(ctx, op) {
      const indexing = !(await mend(ctx));
      const { results } = await ctx.db
        .prepare(
          `SELECT MIN(g.name) AS name, COUNT(*) AS notes FROM note_tags g JOIN notes n ON n.id = g.note_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", listing(op.includeArchived))} GROUP BY g.tag ORDER BY g.tag`,
        )
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<{ name: string; notes: number }>();
      return { tags: results, indexing };
    },
  },

  search: {
    needs: "view",
    async run(ctx, op) {
      if (op.folderId !== undefined) await loadFolder(ctx, op.folderId, "view");
      const { query, covering, condition, bind, prepare } = await finding(ctx, "notes", op, [
        // The folder's own notes, not those of the folders inside it, which `folder:` in the query covers.
        ...(op.folderId === undefined ? [] : [{ kind: "filter", key: "folder", cmp: "=", value: op.folderId, ids: [op.folderId] } as const]),
        ...(op.hasTodos ? [{ kind: "filter", key: "has", cmp: "=", value: "open-todo" } as const] : []),
        ...OLD.archived(op.includeArchived),
      ]);
      if (!query.where) return { results: [], next: null, indexing: false };
      const indexing = !(await mend(ctx));
      const inTitle = !query.sort && op.sort === "match" ? topTerms(query.where) : [];
      const order = query.sort ? orderOf(query.sort) : orderOf(({ match: "updated-desc", recent: "updated-desc", created: "created-desc", title: "title-asc" } as const)[op.sort]);
      // What a note the asker isn't shown matches is left out before anything is counted, ordered or read. The
      // order asked for is of the note itself, as the title's match and then the time of the last change are: a rank worked
      // out across every note would move with the notes that are hidden. Each match names the workspace, so the
      // index is walked for this workspace's notes and no other's.
      const titleFirst = inTitle.length ? `n.id IN (SELECT r.note_id FROM note_search s JOIN note_search_rows r ON r.id = s.rowid WHERE s.note_search MATCH ${bind(matchOf(ctx.workspaceId, inTitle, ["title"]))}) DESC,` : "";
      const { results: found } = await prepare(
        `SELECT n.id FROM notes n
         WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", covering)} AND ${condition}
         ORDER BY ${titleFirst} ${order}, n.id
         LIMIT ${bind(op.limit + 1)} OFFSET ${bind(op.offset)}`,
      ).all<{ id: string }>();
      const page = found.slice(0, op.limit).map((r) => r.id);
      const { results: rows } = await ctx.db
        .prepare(`SELECT n.text, ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (SELECT value FROM json_each(?3)) AND ${SEEN("n", "?2", covering)}`)
        .bind(ctx.workspaceId, ctx.sight.bind, JSON.stringify(page))
        .all<SummaryRow & { text: string }>();
      const byId = new Map(rows.map((row) => [row.id, row]));
      const sought = soughtIn(query);
      return {
        results: page.flatMap((id) => {
          const row = byId.get(id);
          return row ? [{ note: toSummary(ctx, row), matches: matchesIn(row.text, sought) }] : [];
        }),
        next: found.length > op.limit ? op.offset + op.limit : null,
        indexing,
      };
    },
  },

  "folder.list": {
    needs: "view",
    run: listFolders,
  },

  "folder.find": {
    needs: "view",
    async run(ctx, op) {
      const found = atPath((await listFolders(ctx)).folders, op.path);
      if (found.length > 1) throw new OpError("invalid", `${found.length} folders are at ${quoted(op.path)}: ${found.map((f) => `${f.id} (${f.path})`).join(", ")}`);
      if (!found.length) throw new OpError("not_found", NO_SUCH_FOLDER);
      return found[0]!;
    },
  },

  "folder.create": {
    needs: "edit",
    async run(ctx, op) {
      if (op.parentId) await loadFolder(ctx, op.parentId, "edit");
      else if (!seesEveryFolder(ctx.sight)) throw new OpError("forbidden", ctx.sight.within ? "An agent limited to folders can make a folder only inside one of them" : "A guest can make a folder only inside one shared with them");
      const folder: Folder = { id: newId(), name: op.name, parentId: op.parentId ?? null };
      // Every folder beside it is one the asker can see: they see all of the top, or the parent and everything in it.
      const existing = async () => (await siblings(ctx, folder.parentId)).find((f) => folderKey(f.name) === folderKey(op.name));
      const there = await existing();
      if (!there) {
        try {
          await intoFolder(ctx.db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name, name_key) VALUES (?, ?, ?, ?, ?)").bind(folder.id, ctx.workspaceId, folder.parentId, folder.name, folderKey(folder.name)).run(), folder.name);
          return { ...folder, created: true };
        } catch (err) {
          // Made by someone else since it was looked for.
          if (!(err instanceof OpError) || err.code !== "invalid" || op.ifExists !== "return") throw err;
        }
      }
      const found = there ?? (await existing());
      if (!found) throw new OpError("conflict", "The folder was being made and changed too fast to tell what is there. Nothing was made: send it again");
      if (op.ifExists === "error") throw new OpError("invalid", `There's already a folder named "${found.name}" here${ctx.actor.kind === "agent" ? ` (${found.id}). Pass ifExists "return" to be answered with it` : ""}`);
      return { id: found.id, name: found.name, parentId: folder.parentId, created: false };
    },
  },

  "folder.rename": {
    needs: "edit",
    async run(ctx, op) {
      const folder = await loadFolder(ctx, op.id, "edit");
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be renamed");
      // Beside a folder shared with a guest, or one an agent is limited to, are folders they can't see, and a name refused for being taken would name one.
      if (!seesEveryFolder(ctx.sight) && !(folder.parent_id && allows(folderLevel(ctx.sight, folder.parent_id), "view")))
        throw new OpError("forbidden", ctx.sight.within ? "An agent limited to folders can rename only the folders inside one of them" : "A guest can rename only the folders inside one shared with them");
      const taken = (await siblings(ctx, folder.parent_id)).find((f) => f.id !== folder.id && folderKey(f.name) === folderKey(op.name));
      if (taken) throw new OpError("invalid", `There's already a folder named "${taken.name}" here`);
      await intoFolder(ctx.db.prepare("UPDATE folders SET name = ?, name_key = ? WHERE id = ?").bind(op.name, folderKey(op.name), folder.id).run(), op.name);
      return toFolder(ctx, { ...folder, name: op.name });
    },
  },

  "folder.move": {
    needs: "edit",
    async run(ctx, op) {
      const folder = await loadFolder(ctx, op.id, "edit");
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be moved");
      const guest = !ctx.sight.within;
      // As with a rename: beside a folder shared with a guest, or one an agent is limited to, are folders they can't see.
      if (!seesEveryFolder(ctx.sight) && !(folder.parent_id && allows(folderLevel(ctx.sight, folder.parent_id), "view")))
        throw new OpError("forbidden", guest ? "A guest can move only the folders inside one shared with them" : "An agent limited to folders can move only the folders inside one of them");
      // Taking a folder out changes the one it leaves, and Undo has to be able to put it back.
      if (folder.parent_id && !allows(folderLevel(ctx.sight, folder.parent_id), "edit")) throw new OpError("forbidden", "You can read the folder it is in, and not change it");
      if (op.parentId) await loadFolder(ctx, op.parentId, "edit");
      else if (!seesEveryFolder(ctx.sight)) throw new OpError("forbidden", guest ? "A guest can move a folder only into one shared with them" : "An agent limited to folders can move a folder only into one of them");
      // One statement, so two folders moved into each other at once can't both go: the second finds itself above where it would go.
      const moved = await intoFolder(
        ctx.db
          .prepare(
            `UPDATE folders SET parent_id = ?1 WHERE id = ?2 AND workspace_id = ?3 AND NOT EXISTS (
               WITH RECURSIVE above(id) AS (SELECT ?1 UNION SELECT f.parent_id FROM folders f JOIN above ON f.id = above.id WHERE f.parent_id IS NOT NULL)
               SELECT 1 FROM above WHERE id = ?2)`,
          )
          .bind(op.parentId, folder.id, ctx.workspaceId)
          .run(),
        folder.name,
      );
      if (!moved.meta.changes) {
        await loadFolder(ctx, op.id, "edit");
        throw new OpError("invalid", "A folder can't go inside itself, or inside a folder in it");
      }
      return toFolder(ctx, { ...folder, parent_id: op.parentId });
    },
  },

  "folder.delete": {
    needs: "manage",
    async run(ctx, op) {
      // One statement, so a note or child folder added concurrently can't be left in a deleted folder.
      const UNSORTED = "(SELECT unsorted_folder_id FROM workspaces WHERE id = ?2)";
      // A folder that holds only notes and uploads the admin can't see is empty to them, and refusing to delete it would say otherwise. Those go to Unsorted, where their owners find them.
      // A note or an upload in Trash doesn't keep its folder either. It goes to Unsorted too, and is restored there.
      // Neither statement moves anything the admin can see, so the second finds the folder as the first did.
      const emptying = (table: Kept) =>
        ctx.db
          .prepare(
            `UPDATE ${table} SET folder_id = ${UNSORTED}
             WHERE folder_id = ?1 AND workspace_id = ?2 AND ?1 <> ${UNSORTED} AND NOT ${SEEN(table, "?3", "kept")}
               AND EXISTS (SELECT 1 FROM folders f WHERE f.id = ?1 AND ${SEEN_FOLDER("f", "?3")})
               AND NOT EXISTS (SELECT 1 FROM notes v WHERE v.folder_id = ?1 AND ${SEEN("v", "?3", "kept")})
               AND NOT EXISTS (SELECT 1 FROM uploads v WHERE v.folder_id = ?1 AND ${SEEN("v", "?3", "kept")})
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = ?1)`,
          )
          .bind(op.id, ctx.workspaceId, ctx.sight.bind);
      const [, , deleted] = await ctx.db.batch([
        emptying("notes"),
        emptying("uploads"),
        ctx.db
          .prepare(
            `DELETE FROM folders WHERE id = ?1 AND workspace_id = ?2 AND id <> ${UNSORTED} AND ${SEEN_FOLDER("folders", "?3")}
               AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
               AND NOT EXISTS (SELECT 1 FROM uploads WHERE folder_id = folders.id)
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
          )
          .bind(op.id, ctx.workspaceId, ctx.sight.bind),
      ]);
      if (deleted!.meta.changes) return { id: op.id };
      const folder = await loadFolder(ctx, op.id, "edit");
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be deleted");
      const archived = await ctx.db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM notes n WHERE n.folder_id = ?1 AND ${SEEN("n", "?2", "kept")} AND n.state = 'archived') AS notes,
             EXISTS (SELECT 1 FROM uploads u WHERE u.folder_id = ?1 AND ${SEEN("u", "?2", "kept")} AND u.state = 'archived') AS uploads,
             EXISTS (SELECT 1 FROM uploads u WHERE u.folder_id = ?1 AND ${SEEN("u", "?2", "kept")}) AS files`,
        )
        .bind(folder.id, ctx.sight.bind)
        .first<{ notes: number; uploads: number; files: number }>();
      const too = [archived?.notes ? "notes" : "", archived?.uploads ? "uploads" : ""].filter(Boolean).join(" and ");
      throw new OpError("invalid", `"${folder.name}" isn't empty. Move or delete what's in it first${too ? `, archived ${too} too` : ""}.${archived?.files ? " It holds uploads, which the Uploads view lists." : ""}`);
    },
  },

  "settings.read": {
    needs: "view",
    by: "member",
    async run(ctx) {
      const row = await ctx.db
        .prepare("SELECT text, revision, updated_at FROM settings WHERE workspace_id = ? AND person_id = ?")
        .bind(ctx.workspaceId, ctx.personId)
        .first<{ text: string; revision: number; updated_at: number }>();
      return row ? { text: row.text, revision: row.revision, updatedAt: row.updated_at } : { text: "{}", revision: 0, updatedAt: null };
    },
  },

  // A viewer has settings too, so this needs no more than belonging to the workspace.
  "settings.write": {
    needs: "view",
    by: "member",
    async run(ctx, op) {
      if (op.text.length > MAX_SETTINGS_LENGTH) throw new OpError("invalid", `Settings can be at most ${MAX_SETTINGS_LENGTH} characters`);
      if (!isJsonObject(op.text)) throw new OpError("invalid", "Settings are a JSON object, such as {}");
      // One statement, so of two writes on the same revision exactly one is taken.
      const taken = "settings.revision = ?6 OR (settings.revision = ?6 + 1 AND settings.write_id = ?7)";
      const statement =
        op.baseRevision === 0
          ? `INSERT INTO settings (workspace_id, person_id, text, updated_at, write_id, revision) VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT (workspace_id, person_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, write_id = excluded.write_id, revision = settings.revision + 1 WHERE ${taken}
             RETURNING revision`
          : `UPDATE settings SET text = ?3, updated_at = ?4, write_id = ?5, revision = revision + 1 WHERE workspace_id = ?1 AND person_id = ?2 AND (${taken}) RETURNING revision`;
      const row = await ctx.db
        .prepare(statement)
        .bind(ctx.workspaceId, ctx.personId, op.text, ctx.now, op.writeId ?? null, op.baseRevision, op.supersedes ?? null)
        .first<{ revision: number }>();
      if (!row) throw new OpError("conflict", "Your settings changed somewhere else since they were read here");
      return { text: op.text, revision: row.revision, updatedAt: ctx.now };
    },
  },

  "member.list": { needs: "view", members: true, run: (ctx) => listMembers(ctx.db, ctx.workspaceId, { emails: ctx.author.kind === "member" && ctx.role === "admin" }) },

  // Who is in a workspace is not in history, so it can't be reverted the way a note can. Only the member changes it: see NOT_FOR_AGENTS.
  "member.invite": { needs: "manage", by: "member", run: (ctx, op) => invite(asking(ctx), op.email, op.as) },
  "member.setRole": { needs: "manage", by: "member", run: (ctx, op) => setRole(asking(ctx), op.memberId, op.as) },
  "member.remove": { needs: "manage", by: "member", run: (ctx, op) => removeMember(asking(ctx), op.memberId) },
  // A viewer can leave too, so this needs no more than belonging to the workspace.
  "member.leave": { needs: "view", by: "member", members: true, run: (ctx) => leave(asking(ctx)) },
  // Anyone signs themself out everywhere, a guest too. Only an admin signs out someone else, and only a member.
  "member.signOut": {
    needs: "view",
    by: "member",
    run(ctx, op) {
      if (op.memberId !== ctx.personId && ctx.role !== "admin") throw new OpError("forbidden", "Only an admin signs out someone else");
      return signOut(asking(ctx), op.memberId, op.agents);
    },
  },
  "invite.list": { needs: "manage", by: "member", run: (ctx) => listInvites(ctx.db, ctx.workspaceId) },
  "invite.revoke": { needs: "manage", by: "member", run: (ctx, op) => revokeInvite(asking(ctx), op.id) },

  // Who a note is shared with is not in history either, and a link can put a note before the whole internet. Only the member decides it: see NOT_FOR_AGENTS.
  "grant.list": { needs: "view", by: "member", run: (ctx, op) => listGrants(ctx, op) },
  // What each needs of its item is `canShare`'s to say: a viewer who owns a private note shares it, and can change nothing else.
  "grant.set": { needs: "view", by: "member", members: true, run: (ctx, op) => setGrant(ctx, op, op, op.access) },
  "grant.link": { needs: "view", by: "member", members: true, run: (ctx, op) => linkTo(ctx, op, op.link) },
  "grant.revoke": { needs: "view", by: "member", members: true, run: (ctx, op) => revokeGrant(ctx, op.id) },
  // A viewer who made a note while they were an editor is still the one who made it.
  "note.setPrivate": { needs: "view", by: "member", members: true, run: (ctx, op) => setPrivate(ctx, op.id, op.private) },

  "shared.open": {
    needs: "view",
    by: "visitor",
    async run(ctx) {
      const token = ctx.actor.kind === "visitor" ? ctx.actor.token : "";
      const [link, folders, notes] = await ctx.db.batch<{ kind: "public" | "signed_in"; note_id: string | null; folder_id: string | null; name: string | null } & FolderRow & SummaryRow>([
        ctx.db.prepare("SELECT g.kind, g.note_id, g.folder_id, f.name FROM grants g LEFT JOIN folders f ON f.id = g.folder_id WHERE g.token = ?").bind(token),
        ctx.db.prepare(`SELECT ${FOLDER_COLUMNS} WHERE f.workspace_id = ?1 AND ${SEEN_FOLDER("f", "?2")} ORDER BY f.name COLLATE NOCASE, f.id`).bind(ctx.workspaceId, ctx.sight.bind),
        ctx.db.prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "kept")} ORDER BY n.title COLLATE NOCASE, n.id`).bind(ctx.workspaceId, ctx.sight.bind),
      ]);
      const on = link!.results[0];
      if (!on) throw new OpError("not_found", NO_SUCH_LINK);
      // What is right inside the shared folder is at the top for the visitor, and the shared folder itself is named once, as `on`.
      const within = (folderId: string | null) => (folderId === on.folder_id ? null : folderId);
      return {
        link: on.kind,
        on: on.note_id !== null ? { kind: "note", id: on.note_id } : { kind: "folder", id: on.folder_id!, name: on.name! },
        folders: folders!.results.filter((f) => f.id !== on.folder_id).map((f) => ({ ...toFolder(ctx, f), parentId: within(f.parent_id) })),
        // A link on an archived note still opens it. A folder's link lists what the folder does: its live notes.
        notes: notes!.results.filter((row) => on.note_id !== null || row.state === "live").map((row) => toShared(ctx, row, within)),
      };
    },
  },

  "shared.read": {
    needs: "view",
    by: "visitor",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view", "hidden");
      return { ...toShared(ctx, row, (folderId) => folderId), text: row.text, revision: row.revision, links: await linksOf(ctx, row.text, "kept"), uploads: await referred(ctx, row.text, "kept") };
    },
  },
  // Whoever holds a link reads an upload's bytes as they read a note: through what the link covers, and nothing in Trash.
  "shared.upload": { needs: "view", by: "visitor", run: (ctx, op) => openUpload(ctx, op.id, "hidden") },

  "upload.create": { needs: "edit", run: (ctx, op) => createUpload(ctx, op) },
  // An upload sent in parts is whoever started it's alone until it is live: each step asks again whether they may still put it in its folder.
  "upload.start": { needs: "edit", run: (ctx, op) => startUpload(ctx, op) },
  "upload.resume": { needs: "edit", run: (ctx, op) => resumeUpload(ctx, op.id) },
  "upload.part": { needs: "edit", run: (ctx, op) => putPart(ctx, op) },
  "upload.finish": { needs: "edit", run: (ctx, op) => finishUpload(ctx, op.id) },
  "upload.abort": { needs: "edit", run: (ctx, op) => abortUpload(ctx, op.id) },
  // A total of every member's files, private ones among them, and of nothing else: for the members, and for no agent, which may see only some folders.
  "upload.storage": { needs: "view", by: "member", members: true, run: (ctx) => uploadStorage(ctx) },
  "upload.list": { needs: "view", run: (ctx, op) => listUploads(ctx, op) },
  "upload.read": { needs: "view", run: (ctx, op) => readUpload(ctx, op.id) },
  "upload.open": { needs: "view", run: (ctx, op) => openUpload(ctx, op.id, "opens") },
  "upload.move": { needs: "edit", run: (ctx, op) => moveUpload(ctx, op.id, op.folderId) },
  "upload.place": { needs: "edit", run: (ctx, op) => placeUpload(ctx, op.id, op.noteId) },
  "upload.archive": { needs: "edit", run: (ctx, op) => archiveUpload(ctx, op.id, op.archived) },
  "upload.trash": { needs: "edit", run: (ctx, op) => trashUpload(ctx, op.id) },
  "upload.restore": { needs: "edit", run: (ctx, op) => restoreUpload(ctx, op.id) },
  // As for a note: the one change nothing takes back, so only the member does it.
  "upload.purge": { needs: "edit", by: "member", members: true, run: (ctx, op) => purgeUpload(ctx, op.id) },
  "upload.trashed": { needs: "view", run: (ctx) => trashedUploads(ctx) },
  "upload.setPrivate": { needs: "view", by: "member", members: true, run: (ctx, op) => setUploadPrivate(ctx, op.id, op.private) },

  // A data source is the asker's own, so each of these needs no more than being in the workspace it is asked in, and answers nothing of anyone else.
  // It is in no folder either: an agent limited to folders reads the labels its notes hold, as any other reader does, and nothing of the records.
  "source.list": { needs: "view", own: true, run: async (ctx) => ({ sources: await listSources(asker(ctx)) }) },
  // Agreeing to a data source happens in the member's own browser, and ending it is theirs too: see NOT_FOR_AGENTS.
  "source.connect": {
    needs: "view",
    by: "member",
    async run(ctx, op) {
      if (!(await listSources(asker(ctx))).some((s) => s.id === op.id)) throw new OpError("not_found", "No such data source");
      const { redirect } = await ctx.sources.connect(ctx.personId!, op.id, op.back, op.edit);
      return { redirect, sources: await listSources(asker(ctx)) };
    },
  },
  "source.disconnect": {
    needs: "view",
    by: "member",
    async run(ctx, op) {
      if (!(await listSources(asker(ctx))).some((s) => s.id === op.id)) throw new OpError("not_found", "No such data source");
      await ctx.sources.disconnect(ctx.personId!, op.id);
      return { sources: await listSources(asker(ctx)) };
    },
  },
  "event.list": { needs: "view", own: true, run: (ctx, op) => listEvents(asker(ctx), op) },
  "event.update": { needs: "view", own: true, changes: true, run: (ctx, { sourceId, id, etag, type: _, ...change }) => updateEvent(asker(ctx), sourceId, id, etag, change) },
  "event.create": {
    needs: "view",
    own: true,
    changes: true,
    // An agent has no browser to say which calendar is the member's default, so the server reads it from their settings, as it does their daily notes'.
    run: async (ctx, { sourceId, calendarId, type: _, ...fields }) => {
      const settings = async () => calendarSettings((await ctx.db.prepare("SELECT text FROM settings WHERE workspace_id = ? AND person_id = ?").bind(ctx.workspaceId, ctx.personId).first<{ text: string }>())?.text);
      const target = await calendarFor(asker(ctx), { sourceId, calendarId }, settings);
      return createEvent(asker(ctx), target.sourceId, target.calendarId, fields);
    },
  },
  "contact.list": { needs: "view", own: true, run: (ctx, op) => listContacts(asker(ctx), op.query) },
  // A contact is how the member reaches someone, outside Common Ink and its history: only the member changes one. See NOT_FOR_AGENTS.
  "contact.update": { needs: "view", by: "member", own: true, changes: true, run: (ctx, { sourceId, id, etag, type: _, ...change }) => updateContact(asker(ctx), sourceId, id, etag, change) },
  "contact.photo": { needs: "view", by: "member", own: true, changes: true, run: (ctx, op) => photoContact(asker(ctx), op.sourceId, op.id, op.photo) },
  "contact.create": { needs: "view", by: "member", own: true, changes: true, run: (ctx, { sourceId, type: _, ...fields }) => createContact(asker(ctx), sourceId, fields) },
  "person.read": { needs: "view", run: readPerson },
  "record.refer": { needs: "view", own: true, changes: true, run: (ctx, op) => refer(asker(ctx), op.sourceId, op.id) },
  "record.read": { needs: "view", own: true, run: (ctx, op) => readRecord(asker(ctx), op.ref) },
  "record.notes": {
    needs: "view",
    own: true,
    async run(ctx, op) {
      const refs = await referencesTo(asker(ctx), ctx.workspaceId, op.sourceId, op.id);
      if (!refs.length) return { notes: [] };
      await mend(ctx);
      // Search finds the notes with a ref among their words; the note's text says which hold it as a reference, and not in code.
      const { results } = await ctx.db
        .prepare(
          `SELECT n.id, n.title, n.text, n.updated_at, CASE WHEN n.private_owner IS NULL THEN 'workspace' WHEN EXISTS (SELECT 1 FROM grants g WHERE g.note_id = n.id) THEN 'shared' ELSE 'private' END AS audience
           FROM notes n WHERE n.workspace_id = ?1 AND n.id IN (SELECT r.note_id FROM note_search s JOIN note_search_rows r ON r.id = s.rowid WHERE s.note_search MATCH ?2) AND ${SEEN("n", "?3", "kept")}
           ORDER BY n.updated_at DESC, n.id`,
        )
        .bind(ctx.workspaceId, `workspace : "${ctx.workspaceId.replace(/[^a-z0-9]/g, "")}" AND text : (${refs.map((ref) => `"${ref}"`).join(" OR ")})`, ctx.sight.bind)
        .all<{ id: string; title: string; text: string; updated_at: number; audience: NoteAbout["audience"] }>();
      const notes = results.filter((n) => referencesIn(n.text).some((found) => refs.includes(found.ref)));
      return { notes: notes.map((n): NoteAbout => ({ id: n.id, title: n.title, updatedAt: n.updated_at, audience: n.audience })) };
    },
  },

  "plugin.list": { needs: "view", members: true, run: (ctx) => listPlugins(ctx) },
  // Making, installing and permitting plugins is the member's, and their agent's as it acts in their role: an admin's agent does what an admin does, and a member's what the member may. No plugin does any of it, and an agent limited to folders or to reading does none of what changes it.
  "plugin.read": { needs: "view", by: "owner", members: true, run: (ctx, op) => readPlugin(ctx, op.id) },
  "plugin.install": { needs: "manage", by: "owner", members: true, run: (ctx, op) => installPlugin(ctx, op) },
  "plugin.uninstall": { needs: "manage", by: "owner", members: true, run: (ctx, op) => uninstallPlugin(ctx, op.id) },
  "plugin.permit": { needs: "manage", by: "owner", members: true, run: (ctx, op) => permitPlugin(ctx, op) },
  // A viewer asks too, so this needs no more than belonging to the workspace.
  "plugin.request": { needs: "view", by: "owner", members: true, changes: true, run: (ctx, op) => requestPlugin(ctx, op) },
  "plugin.scaffold": {
    needs: "view",
    by: "owner",
    members: true,
    run: async (_, op) => {
      const made = scaffold(op.name);
      if ("reason" in made) throw new OpError("invalid", made.reason);
      return made;
    },
  },
  "plugin.validate": { needs: "view", by: "owner", members: true, run: (_, op) => validate(op.manifest, op.code) },
  "plugin.frame": { needs: "view", by: "member", members: true, run: (ctx, op) => framePlugin(ctx, op.id) },
  // Running a plugin inside the app is each member's own decision, for their own session. Nobody makes it for them: not an admin, an agent, or a plugin.
  "plugin.trust": { needs: "view", by: "member", members: true, run: (ctx, op) => trustPlugin(ctx, op) },
  // A draft is its author's alone, beside their settings, and what it holds is code that runs in their browser, for them alone. The member and their agent read and write it; no plugin does.
  "draft.list": { needs: "view", by: "owner", members: true, run: (ctx) => listDrafts(ctx) },
  "draft.read": { needs: "view", by: "owner", members: true, run: (ctx, op) => readDraft(ctx, op.id) },
  "draft.save": { needs: "view", by: "owner", members: true, changes: true, run: (ctx, op) => saveDraft(ctx, op) },
  "draft.discard": { needs: "view", by: "owner", members: true, changes: true, run: (ctx, op) => discardDraft(ctx, op.id) },
};
