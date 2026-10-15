import { ChangeSet, MapMode } from "@codemirror/state";
import { z } from "zod";
import { SEEN, SEEN_FOLDER, allows, folderLevel, noteLevel, seesEveryFolder, type GrantLevel, type Sight } from "./access.ts";
import { dailySettings, dailyText, dayFor, filedOn, type DailySettings } from "./daily.ts";
import { lineDiff, textDiff } from "./diff.ts";
import { following as lineFollowing } from "./follow.ts";
import { dayIn, linesAsOf, rebased, redoTarget, revertOfAuthor, revertedBy, revertible, reverting, runsOf, settledRevert, undoTarget, type Choice, type Resolution, type Reverting, type Step } from "./history.ts";
import { newId } from "./ids.ts";
import { isNoteId, linkedIds, linksIn, retargeted } from "./links.ts";
import { summarize } from "./markdown.ts";
import { invite, leave, listInvites, listMembers, removeMember, revokeInvite, setRole, type Asking } from "./membership.ts";
import {
  NO_SUCH_WORKSPACE,
  MAX_NOTE_LENGTH,
  MAX_SETTINGS_LENGTH,
  Op,
  OpError,
  type Author,
  type AuthorRef,
  type ChangeEntry,
  type DiffRun,
  type Folder,
  type HistoryEntry,
  type ListedTodo,
  type Note,
  type NoteDiff,
  type NoteRevertPreview,
  type RevertConflict,
  type NoteSummary,
  type OpInput,
  type OpType,
  type Results,
  type Resolve,
  type RevertedNotes,
  type Reverts,
  type Role,
  type SharedNote,
  type TodoSort,
  type Written,
} from "./protocol.ts";
import { linkTo, listGrants, revokeGrant, setGrant, setPrivate } from "./sharing.ts";
import { noteSlug } from "./slug.ts";
import { NO_SUCH_LINK, standingByLink, standingIn, type Standing as ActorStanding } from "./standing.ts";
import { applyChanges, changesBetween } from "./text.ts";
import { ruleLabel } from "./recurrence.ts";
import { changeTodo, checkedOff, completeTodo, nameKey, parseTodo, rolledForward, todoIndex, todosIn, type Completed } from "./todos.ts";

/** Who is performing an operation, and where. */
export type Actor =
  /** A signed-in person, in a workspace they are a member of or a guest in. */
  | { kind: "member"; personId: string; workspaceId: string }
  /** An agent acts as `personId`: their role and grants in the workspace, so their access, and no more. */
  | { kind: "agent"; agentId: string; personId: string; workspaceId: string; scope?: AgentScope };

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

const authorId = (ctx: Context) => (ctx.author.kind === "agent" ? ctx.author.agentId : ctx.author.personId);

export interface Context {
  db: D1Database;
  actor: Actor | Visitor;
  author: Author;
  workspaceId: string;
  /** The person acting, or the person an agent acts for. Null for whoever opened a link. */
  personId: string | null;
  /** Their role, or null for a guest and for whoever opened a link. */
  role: Role | null;
  /** What they can see and do. Every read of a note or a folder is checked against it. */
  sight: Sight;
  now: number;
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
   * `visitor`: whoever holds a link, who may ask nothing else.
   */
  by?: "member" | "visitor";
  /** Set when only a member of the workspace may ask, and one who sees all of it: not a guest, and not an agent limited to folders. */
  members?: true;
  run: (ctx: Context, op: Extract<Op, { type: K }>) => Promise<Results[K]>;
};

/** Every operation on a workspace. The web app, CLI, and MCP server all come through here. */
export async function perform<T extends OpInput>(db: D1Database, actor: Actor | Visitor, input: T, now = Date.now()): Promise<Results[T["type"]]> {
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
  if (actor.kind === "agent" && actor.scope?.readOnly && handler.needs !== "view") throw new OpError("forbidden", `A read-only token can't ${op.type}`);
  if (handler.members && standing.sight.within) throw new OpError("forbidden", `An agent limited to folders can't ${op.type}`);
  if ((handler.members && !standing.role) || !ALLOWS[standing.most].has(handler.needs)) throw new OpError("forbidden", `A ${standing.as} can't ${op.type}`);

  let author: Author = { kind: "member", personId: standing.personId ?? "", name: standing.name };
  if (actor.kind === "agent") {
    const agent = await db.prepare("SELECT name FROM agents WHERE id = ?").bind(actor.agentId).first<{ name: string }>();
    author = { kind: "agent", agentId: actor.agentId, name: agent?.name ?? "An agent", onBehalfOf: actor.personId };
  }
  const ctx: Context = { db, actor, author, workspaceId: standing.workspaceId, personId: standing.personId, role: standing.role, sight: standing.sight, now };
  return handler.run(ctx, op as never) as Promise<Results[T["type"]]>;
}

interface SummaryRow {
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
}

export interface NoteRow extends SummaryRow {
  text: string;
  /** The person who made it, or whose agent did. Null for a note made before that was kept. */
  created_by: string | null;
  /** Below {@link MADE} for a note whose links and todos haven't been made from its text since there were tables for them. */
  indexed: number;
}

/** What a note's `indexed` is once its links, todos and tags have been made from its text. */
const MADE = 1;

const SUMMARY_COLUMNS = `n.id, n.folder_id, n.revision, n.title, n.snippet, n.open_todos, n.created_at, n.updated_at, n.updated_by, n.updated_by_kind, n.private_owner,
    COALESCE(p.name, a.name) AS updated_by_name, a.person_id AS updated_by_owner
  FROM notes n
  LEFT JOIN people p ON n.updated_by_kind = 'member' AND p.id = n.updated_by
  LEFT JOIN agents a ON n.updated_by_kind = 'agent' AND a.id = n.updated_by`;

/** The member or agent a change or a note names by the kind and id stored with it. */
const authorOf = (kind: string, id: string, name: string | null, owner: string | null): Author =>
  kind === "agent" ? { kind: "agent", agentId: id, name: name ?? "An agent", onBehalfOf: owner ?? "" } : { kind: "member", personId: id, name: name ?? "Someone" };

/** A note as the one asking is told of it. Only a row they can see is ever handed here. */
const toSummary = (ctx: Context, row: SummaryRow): NoteSummary => ({
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
  access: noteLevel(ctx.sight, row) === "edit" ? "edit" : "view",
  private: row.private_owner !== null,
});

/** A note as whoever holds a link is told of it: nothing of who wrote it, or of how it is shared. */
function toShared(ctx: Context, row: SummaryRow, within: (folderId: string | null) => string | null): SharedNote {
  const { id, title, slug, folderId, updatedAt, snippet } = toSummary(ctx, row);
  return { id, title, slug, folderId: within(folderId), updatedAt, snippet };
}

function toNote(ctx: Context, row: NoteRow, text = row.text, revision = row.revision): Note {
  if (text !== row.text) {
    const { title, snippet, openTodos } = summarize(text);
    row = { ...row, title, snippet, open_todos: openTodos };
  }
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
    updated_by_owner: author.kind === "agent" ? author.onBehalfOf : null,
  };
}

const kindOf = (by: "people" | "agents" | undefined) => (by === "people" ? "member" : by === "agents" ? "agent" : null);

const sameAuthor = (a: AuthorRef, b: AuthorRef) => a.kind === b.kind && a.id === b.id;
const isBy = (ctx: Context, author: AuthorRef) => sameAuthor(author, { kind: ctx.author.kind, id: authorId(ctx) });

const NO_SUCH_NOTE = "No such note";
const NO_SUCH_FOLDER = "No such folder";

/** The folder bound as ?4 and every folder under it, for a listing narrowed to a folder. */
const UNDER = "WITH RECURSIVE under (id) AS (SELECT ?4 UNION SELECT f.id FROM folders f JOIN under u ON f.parent_id = u.id)";

const CANT_CHANGE = "You can read this note, and not change it";

/**
 * The note, for someone who may do `need` with it. This is the one place a single note is read, so
 * it is where a note the actor can't see is the same as no note at all.
 */
export async function loadNote(ctx: Context, id: string, need: GrantLevel): Promise<NoteRow> {
  const row = await ctx.db
    .prepare(`SELECT n.text, n.created_by, n.indexed, ${SUMMARY_COLUMNS} WHERE n.id = ? AND n.workspace_id = ?`)
    .bind(id, ctx.workspaceId)
    .first<NoteRow>();
  const level = row ? noteLevel(ctx.sight, row) : "none";
  if (!row || level === "none") throw new OpError("not_found", NO_SUCH_NOTE);
  if (!allows(level, need)) throw new OpError("forbidden", CANT_CHANGE);
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

/** A write naming a folder or putting something in one, whose folder may have been deleted since it was loaded. */
async function intoFolder(write: Promise<unknown>, name?: string): Promise<void> {
  try {
    await write;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/FOREIGN KEY constraint failed/.test(message)) throw new OpError("not_found", NO_SUCH_FOLDER);
    if (/UNIQUE constraint failed: index 'folders_by_name'/.test(message)) throw new OpError("invalid", `There's already a folder named "${name}" here`);
    throw err;
  }
}

/**
 * The notes the actor can see among those `among` selects by id, latest change first. The other end
 * of a link is only ever read through here: a backlink, a linked note's title, a title to link by.
 * So a note the actor can't see is left out of all three by narrowing this one query.
 */
async function seenAmong(ctx: Context, among: string, ...binds: unknown[]): Promise<SummaryRow[]> {
  const { results } = await ctx.db
    .prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (${among}) AND ${SEEN("n", `?${binds.length + 2}`)} ORDER BY n.updated_at DESC, n.id`)
    .bind(ctx.workspaceId, ...binds, ctx.sight.bind)
    .all<SummaryRow>();
  return results;
}

const IDS_IN = "SELECT value FROM json_each(?2)";

const quoted = (title: string) => JSON.stringify(title);

/**
 * The text with each link the write introduces stored by its note's id. A write introduces a link
 * when no link in `base`, the text it was based on, has the same target as written. So a link the
 * note already had is left exactly as it is, wherever in the note it now stands and however often,
 * and a writer is only ever refused for a link they wrote themselves. A new target is looked up as
 * an id and as a title: a note with that id is the one meant, and otherwise the one note so titled.
 */
async function linkedById(ctx: Context, text: string, base: string, how: "resolve" | "keep"): Promise<string> {
  if (how === "keep") return text;
  const had = new Set(linksIn(base).map((link) => link.target));
  const introduced = [...new Set(linksIn(text).map((link) => link.target))].filter((target) => !had.has(target));
  if (!introduced.length) return text;
  // Each title as written and in lower case: the database folds case for unaccented letters only.
  const found = await seenAmong(
    ctx,
    "SELECT t.id FROM notes t WHERE t.workspace_id = ?1 AND (t.id IN (SELECT value FROM json_each(?2)) OR t.title COLLATE NOCASE IN (SELECT value FROM json_each(?3)))",
    JSON.stringify(introduced.filter(isNoteId)),
    JSON.stringify(introduced.flatMap((target) => [target, target.toLowerCase()])),
  );
  const ids = new Set(found.map((row) => row.id));
  const byTitle = Map.groupBy(found, (row) => row.title.toLowerCase());
  const stored = retargeted(text, (target) => {
    if (had.has(target) || ids.has(target)) return undefined;
    const notes = byTitle.get(target.toLowerCase()) ?? [];
    if (notes.length > 1) throw new OpError("invalid", `${notes.length} notes are titled ${quoted(target)}: ${notes.map((n) => n.id).join(", ")}. Link the one you mean as [[id]].`);
    if (!notes.length) throw new OpError("invalid", `No note ${isNoteId(target) ? "has the id or the title" : "is titled"} ${quoted(target)}. Link a note by its title or as [[id]], with ids from note.list, or pass linkTitles "keep" to leave [[${target}]] as text.`);
    return notes[0]!.id;
  });
  if (stored.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With its links stored by id, the note would be over ${MAX_NOTE_LENGTH} characters`);
  return stored;
}

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

/** Each order of todo.list, before its ties by note and line. A todo's words are its line after its checkbox and priority marks. */
const TODO_ORDER: Record<TodoSort, string> = {
  due: "t.due IS NULL, t.due, t.importance DESC, n.title COLLATE NOCASE",
  priority: "t.importance DESC, t.due IS NULL, t.due, n.title COLLATE NOCASE",
  changed: "n.updated_at DESC",
  note: "n.title COLLATE NOCASE",
  text: "ltrim(substr(t.text, instr(t.text, ']') + 1), ' !') COLLATE NOCASE",
};

const INDEXED = {
  todos: "INSERT INTO todos (note_id, line, done, importance, due, text) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')",
  tags: "INSERT INTO note_tags (note_id, tag, name) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]')",
} as const;
const INDEX_TABLE = { todos: "todos", tags: "note_tags" } as const;

/**
 * The statements that make the index of a note's todos and its tags what `text`
 * says, or none for a part that `was` says the same of. Like `linking`, they go in the batch that
 * changes the text, and with `atRevision` do nothing unless the note is still at that revision.
 */
function indexing(ctx: Context, noteId: string, text: string, { was, atRevision }: { was?: string; atRevision?: number } = {}): D1PreparedStatement[] {
  const now = todoIndex(text);
  const before = was === undefined ? null : todoIndex(was);
  const current = "(?2 IS NULL OR EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND revision = ?2))";
  const at = atRevision ?? null;
  return (Object.keys(INDEXED) as (keyof typeof INDEXED)[]).flatMap((part) => {
    if (before && JSON.stringify(before[part]) === JSON.stringify(now[part])) return [];
    return [
      ctx.db.prepare(`DELETE FROM ${INDEX_TABLE[part]} WHERE note_id = ?1 AND ${current}`).bind(noteId, at),
      ...inParts(now[part]).map((rows) => ctx.db.prepare(`${INDEXED[part]} FROM json_each(?3) WHERE ${current}`).bind(noteId, at, rows)),
    ];
  });
}

/**
 * Makes the links, todos and tags of the notes that have never had them made, from their
 * text: notes written before there were tables for them, and every note after a rebuild asks. It
 * covers every note in the workspace, whoever asks, since it tells the asker nothing: what it writes
 * is only ever read back through `SEEN`. It does so many a call. False when there are more.
 */
async function mend(ctx: Context): Promise<boolean> {
  for (let batch = 0; batch < MEND_BATCHES; batch++) {
    const { results } = await ctx.db
      .prepare(`SELECT id, revision, text FROM notes WHERE workspace_id = ? AND indexed < ${MADE} LIMIT ?`)
      .bind(ctx.workspaceId, MEND_NOTES + 1)
      .all<{ id: string; revision: number; text: string }>();
    const notes = results.slice(0, MEND_NOTES);
    // A note written since it was read here is left to that write, which made all of it.
    if (notes.length) {
      await ctx.db.batch(
        notes.flatMap((n) => [
          ...linking(ctx, n.id, n.text, { atRevision: n.revision }),
          ...indexing(ctx, n.id, n.text, { atRevision: n.revision }),
          ctx.db.prepare("UPDATE notes SET indexed = ? WHERE id = ? AND revision = ?").bind(MADE, n.id, n.revision),
        ]),
      );
    }
    if (results.length <= MEND_NOTES) return true;
  }
  return false;
}

/**
 * Has every note's links and index made again. A call that finds notes still waiting from the call
 * before carries on with them, and one that finds none starts over.
 */
const rebuild = {
  needs: "manage",
  async run(ctx: Context) {
    const waiting = await ctx.db.prepare(`SELECT 1 FROM notes WHERE workspace_id = ? AND indexed < ${MADE} LIMIT 1`).bind(ctx.workspaceId).first();
    if (!waiting) await ctx.db.prepare("UPDATE notes SET indexed = 0 WHERE workspace_id = ?").bind(ctx.workspaceId).run();
    return { done: await mend(ctx) };
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
const MEND_NOTES = 20;
/** As many batches as one request makes, so a workspace of any size is mended over a few. */
const MEND_BATCHES = 20;
/** A write that lost to another: its revision of a note, a member's daily note for a day, or a folder's name was taken first. */
const isTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: (?:changes\.|daily_notes\.|index 'folders_by_name')/.test(err.message);

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
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at, write_id, reverts, resolution, added, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      noteId,
      revision,
      baseRevision,
      ctx.author.kind,
      authorId(ctx),
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
        .prepare("UPDATE notes SET revision = ?, text = ?, title = ?, snippet = ?, open_todos = ?, updated_at = ?, updated_by = ?, updated_by_kind = ?, indexed = ? WHERE id = ? AND revision = ?")
        .bind(revision, next.text, next.title, next.snippet, next.open_todos, next.updated_at, next.updated_by, next.updated_by_kind, MADE, row.id, row.revision),
      ...linking(ctx, row.id, text, was),
      ...indexing(ctx, row.id, text, was),
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

/** `on` is the day as the one asking said it. With none, it is today where their settings say they are. */
async function completing(ctx: Context, on: string | undefined): Promise<Completing> {
  const row = await ctx.db.prepare("SELECT text FROM settings WHERE workspace_id = ? AND person_id = ?").bind(ctx.workspaceId, ctx.personId).first<{ text: string }>();
  const settings = dailySettings(row?.text);
  return { settings, day: on ?? dayFor(settings, ctx.now) };
}

const NOTE_BY_ID = `SELECT n.text, n.created_by, n.indexed, ${SUMMARY_COLUMNS} WHERE n.id = ?`;

/**
 * The daily note for `day` of the member acting, or of the member an agent acts for, that can still
 * be used: the one place that says which note that is. `stale` is the note the day is kept for when
 * that note can no longer be used, which a new daily note then takes the place of. Every note can
 * be used today. A lifecycle that takes one out of use, such as Trash, says so here and nowhere else.
 */
async function usableDaily(ctx: Context, day: string): Promise<{ note: NoteRow | null; stale: string | null }> {
  const kept = await ctx.db.prepare("SELECT note_id FROM daily_notes WHERE workspace_id = ? AND person_id = ? AND day = ?").bind(ctx.workspaceId, ctx.personId, day).first<{ note_id: string }>();
  if (!kept) return { note: null, stale: null };
  const note = await ctx.db.prepare(NOTE_BY_ID).bind(kept.note_id).first<NoteRow>();
  return note ? { note, stale: null } : { note: null, stale: kept.note_id };
}

/** The folder at the top of the workspace that the member's settings name for daily notes, ignoring case, when there is one. */
const dailyFolder = (ctx: Context, settings: DailySettings) =>
  ctx.db.prepare("SELECT id FROM folders WHERE workspace_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE").bind(ctx.workspaceId, settings.folder).first<{ id: string }>();

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
  const row: NoteRow = { id, folder_id: folderId, revision: 1, created_at: ctx.now, created_by: ctx.personId, private_owner: settings.private ? ctx.personId : null, indexed: MADE, ...written(ctx, text) };
  return {
    row,
    statements: [
      ...(folder ? [] : [ctx.db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name) VALUES (?, ?, NULL, ?)").bind(folderId, ctx.workspaceId, settings.folder)]),
      ctx.db
        .prepare(
          `INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, snippet, open_todos, created_at, updated_at, updated_by, updated_by_kind, created_by, private_owner, indexed)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.workspaceId, folderId, row.text, row.title, row.snippet, row.open_todos, row.created_at, row.updated_at, row.updated_by, row.updated_by_kind, row.created_by, row.private_owner, row.indexed),
      insertChange(ctx, id, 1, 0, "", changesBetween("", text)),
      ...(stale ? [ctx.db.prepare("DELETE FROM daily_notes WHERE workspace_id = ? AND person_id = ? AND day = ? AND note_id = ?").bind(ctx.workspaceId, ctx.personId, day, stale)] : []),
      ctx.db.prepare("INSERT INTO daily_notes (workspace_id, person_id, day, note_id) VALUES (?, ?, ?, ?)").bind(ctx.workspaceId, ctx.personId, day, id),
      ...linking(ctx, id, text, { was: "" }),
      ...indexing(ctx, id, text, { was: "" }),
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
    if (noteLevel(ctx.sight, daily.note) === "edit") {
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
        `SELECT c.revision, c.at, c.done_on, c.daily_note_id, c.created_at, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner
         FROM completions c
         LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
         LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
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
 * member has it. The statements go in the batch that records the change itself. The daily note is
 * the completer's, and is changed whether or not the one taking the change back can see it: they are
 * told of it only when they can.
 */
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
    if (touched && noteLevel(ctx.sight, daily) !== "none") refiled.unfiled!.dailyNoteIds.push(daily.id);
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
    if (!touched && noteLevel(ctx.sight, daily) !== "none") refiled.unfiled!.dailyNoteIds.push(daily.id);
  }
  return refiled.statements.length || refiled.unfiled!.left || refiled.unfiled!.removed ? refiled : { statements: [] };
}

/**
 * Records the change that takes `reverts` back out of `row`, and what that does to the daily notes
 * its completions were filed on, as one batch. Every revert goes through here, of one note or of
 * many. Null when another write got in first.
 */
async function recordTakenBack(ctx: Context, row: NoteRow, history: readonly Recorded[], reverts: Reverts, changes: ChangeSet, resolution: Resolution | null): Promise<{ next: NoteRow; unfiled?: NonNullable<Written["unfiled"]> } | null> {
  const { next, statements } = recording(ctx, row, changes, row.revision, { reverts, resolution });
  const refiled = await refiling(ctx, row, history, reverts);
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

const CHANGE_COLUMNS = `c.note_id, c.revision, c.base_revision, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner, c.created_at, c.reverts, c.added, c.removed, l.name AS label
  FROM changes c
  LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
  LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
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

const RECORDED_COLUMNS = `c.note_id, c.revision, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner, c.diff, c.reverts, c.resolution
       FROM changes c
       LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
       LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id`;

async function takingBack(ctx: Context, id: string, need: GrantLevel, choose: Choose, resolve?: Resolve): Promise<TakingBack> {
  const row = await loadNote(ctx, id, need);
  const { results } = await ctx.db.prepare(`SELECT ${RECORDED_COLUMNS} WHERE c.note_id = ? AND c.revision <= ? ORDER BY c.revision`).bind(row.id, row.revision).all<RecordedRow>();
  return takingBackOf(row, results.map(toRecorded), choose, resolve);
}

/**
 * The notes named, each with its changes up to the revision it was read at, in two reads however
 * many they are. A note that isn't in the workspace, or that the actor can't see, is left out: the
 * two are the same to whoever asks. What they may do with each note that is here is still to ask.
 */
async function loadWithHistory(ctx: Context, ids: readonly string[]): Promise<Map<string, { row: NoteRow; history: Recorded[] }>> {
  const named = JSON.stringify(ids);
  const [notes, changes] = await ctx.db.batch<NoteRow & RecordedRow & { note_id: string }>([
    ctx.db.prepare(`SELECT n.text, n.created_by, ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3")}`).bind(ctx.workspaceId, named, ctx.sight.bind),
    ctx.db
      .prepare(`SELECT ${RECORDED_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ?1 AND c.note_id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3")} ORDER BY c.note_id, c.revision`)
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

/** Only for an operation that is `by: "member"`, which is always asked by a person. */
const asking = (ctx: Context): Asking => ({ db: ctx.db, workspaceId: ctx.workspaceId, personId: ctx.personId!, now: ctx.now });

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
export const MAX_ANSWER_LINES = 2000;

const HANDLERS: { [K in OpType]: Handler<K> } = {
  "note.list": {
    needs: "view",
    async run(ctx, op) {
      const { results } = await ctx.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND (?2 IS NULL OR n.folder_id = ?2) AND (?3 IS NULL OR n.updated_at >= ?3) AND ${SEEN("n", "?4")} ORDER BY n.updated_at DESC`)
        .bind(ctx.workspaceId, op.folderId ?? null, op.updatedSince ?? null, ctx.sight.bind)
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
      const text = await linkedById(ctx, op.text, "", op.linkTitles);
      const row: NoteRow = { id, folder_id: folder.id, revision, created_at: ctx.now, created_by: ctx.personId, private_owner: null, indexed: MADE, ...written(ctx, text) };
      const insertNote = ctx.db
        .prepare(
          `INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, snippet, open_todos, created_at, updated_at, updated_by, updated_by_kind, created_by, indexed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.workspaceId, row.folder_id, revision, row.text, row.title, row.snippet, row.open_todos, row.created_at, row.updated_at, row.updated_by, row.updated_by_kind, row.created_by, row.indexed);
      await intoFolder(ctx.db.batch(text ? [insertNote, insertChange(ctx, id, 1, 0, "", changesBetween("", text)), ...linking(ctx, id, text, { was: "" }), ...indexing(ctx, id, text, { was: "" })] : [insertNote]));
      return toNote(ctx, row);
    },
  },

  "note.read": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view");
      if (op.revision !== undefined && op.revision > row.revision) throw new OpError("not_found", `The note has no revision ${op.revision}`);
      const note = op.revision === undefined || op.revision === row.revision ? toNote(ctx, row) : toNote(ctx, row, (await replay(ctx, op.id, op.revision, row.revision)).text, op.revision);
      const ids = linkedIds(note.text);
      const titles = new Map(ids.length ? (await seenAmong(ctx, IDS_IN, JSON.stringify(ids))).map((r) => [r.id, r.title]) : []);
      return { ...note, links: ids.map((id) => ({ id, title: titles.get(id) ?? null })) };
    },
  },

  "note.backlinks": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view");
      return (await seenAmong(ctx, "SELECT source_id FROM links WHERE target_id = ?2", row.id)).map((from) => toSummary(ctx, from));
    },
  },

  "links.rebuild": rebuild,

  "todo.list": {
    needs: "view",
    async run(ctx, op) {
      await mend(ctx);
      // The folder narrows inside what the asker sees and never widens it: one they can't see is no folder.
      const folder = op.folderId === undefined ? null : (await loadFolder(ctx, op.folderId, "view")).id;
      const { results } = await ctx.db
        .prepare(
          `${UNDER} SELECT t.note_id, t.line, t.done, t.importance, t.due, t.text, n.title, n.revision, n.folder_id, n.private_owner,
             (SELECT json_group_array(name) FROM (SELECT g.name FROM note_tags g WHERE g.note_id = t.note_id ORDER BY g.rowid)) AS tags
           FROM todos t JOIN notes n ON n.id = t.note_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")}
             AND (?3 = 1 OR t.done = 0)
             AND (?4 IS NULL OR n.folder_id IN (SELECT id FROM under))
             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM note_tags g WHERE g.note_id = t.note_id AND g.tag = ?5))
             AND (?6 IS NULL OR t.due >= ?6)
             AND (?7 IS NULL OR t.due <= ?7)
             AND (?8 = 0 OR t.due IS NULL)
             AND (?9 IS NULL OR t.importance IN (SELECT value FROM json_each(?9)))
             AND (?10 IS NULL OR t.note_id = ?10)
           ORDER BY t.done, ${TODO_ORDER[op.sort]}, t.note_id, t.line
           LIMIT ?11 OFFSET ?12`,
        )
        .bind(
          ctx.workspaceId,
          ctx.sight.bind,
          op.includeCompleted ? 1 : 0,
          folder,
          op.tag === undefined ? null : nameKey(op.tag),
          op.dueFrom ?? null,
          op.dueTo ?? null,
          op.noDue ? 1 : 0,
          op.importance ? JSON.stringify(op.importance) : null,
          op.noteId ?? null,
          op.limit + 1,
          op.offset,
        )
        .all<{ note_id: string; line: number; done: number; importance: ListedTodo["importance"]; due: string | null; text: string; title: string; revision: number; folder_id: string; private_owner: string | null; tags: string }>();
      const page = results.slice(0, op.limit);
      return {
        todos: page.map((r) => {
          const todo = parseTodo(r.text);
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
            words: todo?.words ?? r.text,
            access: noteLevel(ctx.sight, { id: r.note_id, folder_id: r.folder_id, private_owner: r.private_owner }) === "edit" ? "edit" : "view",
          };
        }),
        next: results.length > op.limit ? op.offset + op.limit : null,
      };
    },
  },

  "todo.filters": {
    needs: "view",
    async run(ctx) {
      await mend(ctx);
      const { results } = await ctx.db
        .prepare(
          `SELECT MIN(g.name) AS name FROM note_tags g JOIN notes n ON n.id = g.note_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")} AND EXISTS (SELECT 1 FROM todos t WHERE t.note_id = g.note_id) GROUP BY g.tag ORDER BY g.tag`,
        )
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<{ name: string }>();
      return { tags: results.map((r) => r.name) };
    },
  },

  "todo.set": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async (): Promise<Written | null> => {
        const row = await loadNote(ctx, op.id, "edit");
        const { id: _, type: __, revision: ___, line: ____, text: listedAs, on, ...change } = op;
        const mine = change.done || change.skip ? await completing(ctx, on) : null;
        let wanted: Completed;
        try {
          wanted = changeTodo(listedAs, change, mine?.day ?? "");
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
      const row = await loadNote(ctx, op.id, "view");
      const todo = await listedTodo(ctx, row, op);
      if (!todo) throw new OpError("conflict", "This todo was changed since it was listed. List the todos again.");
      const mine = (await completionsNow(ctx, row.id)).filter(({ at }) => at === todo.from).map((f) => f.completion);
      const dailies = [...new Set(mine.flatMap((c) => (c.daily_note_id ? [c.daily_note_id] : [])))];
      const seen = new Set(dailies.length ? (await seenAmong(ctx, IDS_IN, JSON.stringify(dailies))).map((r) => r.id) : []);
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
          if (noteLevel(ctx.sight, daily.note) === "none") throw new OpError("not_found", NO_SUCH_NOTE);
          return toNote(ctx, daily.note);
        }
        const made = newDaily(ctx, mine, dailyText(mine.day), await dailyFolder(ctx, mine.settings), daily.stale);
        if (!made) throw new OpError("forbidden", `You can't make notes in "${mine.settings.folder}", the folder your settings name for daily notes`);
        return (await landed(ctx, made.statements)) ? toNote(ctx, made.row) : null;
      }),
  },

  "todos.rebuild": rebuild,

  "note.write": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async (): Promise<Written | null> => {
        const row = await loadNote(ctx, op.id, "edit");
        if (op.writeId) {
          const recorded = await ctx.db.prepare("SELECT 1 FROM changes WHERE note_id = ? AND write_id = ?").bind(row.id, op.writeId).first();
          if (recorded) return toNote(ctx, row);
        }
        if (op.baseRevision > row.revision) throw new OpError("invalid", `The note has no revision ${op.baseRevision}`);
        const base = op.baseRevision === row.revision ? { text: row.text, since: null } : await replay(ctx, row.id, op.baseRevision, row.revision);
        const stored = await linkedById(ctx, op.text, base.text, op.linkTitles);
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
      }),
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id, "view");
      await countLines(ctx, [op.id]);
      const { results } = await ctx.db.prepare(`SELECT ${CHANGE_COLUMNS} WHERE c.note_id = ? ORDER BY c.revision`).bind(op.id).all<ChangeRow>();
      const standing = standingOf(results.map(stepOf));
      return results.map((r) => toEntry(r, standing));
    },
  },

  "note.diff": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view");
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no change ${op.revision}`);
      const { text, since } = await replay(ctx, row.id, op.revision - 1, op.revision);
      return lineDiff(text, since[0]!);
    },
  },

  "note.label": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit");
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
      const narrowed = `n.workspace_id = ?1 AND ${SEEN("n", "?6")}
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
          `SELECT c.note_id, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner
           FROM changes c
           JOIN notes n ON n.id = c.note_id
           LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
           LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
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
             WHERE n.workspace_id = ?1 AND ${SEEN("n", "?10")}
               AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
               AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
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
          `SELECT DISTINCT c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner
           FROM changes c
           JOIN notes n ON n.id = c.note_id
           LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
           LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")} ORDER BY name COLLATE NOCASE, c.author_id`,
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
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?7")}
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
          if (!text.trim()) answer.emptied.push({ noteId: id, title });
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
        ctx.db.prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND n.id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3")}`).bind(ctx.workspaceId, named, ctx.sight.bind),
        ctx.db
          .prepare(`SELECT c.diff, ${CHANGE_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ?1 AND c.note_id IN (SELECT value FROM json_each(?2)) AND ${SEEN("n", "?3")} ORDER BY c.note_id, c.revision`)
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
      const read = await loadWithHistory(ctx, op.changes.map((c) => c.noteId));
      const done: RevertedNotes = { reverted: [], skipped: [] };
      for (const item of op.changes) {
        const note = read.get(item.noteId);
        if (!note) {
          done.skipped.push({ noteId: item.noteId, noteTitle: "", why: "refused", message: NO_SUCH_NOTE });
          continue;
        }
        const { row, history } = note;
        const name = row.title || "Untitled";
        // Asked of each note, as `loadNote` asks it of one: a role that may edit doesn't say this note may be.
        if (!allows(noteLevel(ctx.sight, row), "edit")) {
          done.skipped.push({ ...titled(row), why: "refused", message: CANT_CHANGE });
          continue;
        }
        const moved = () => done.skipped.push({ ...titled(row), why: "changed", message: `${name} has changed since this revert was previewed, so it was left as it is. Preview its revert again` });
        if (item.at !== undefined && item.at !== row.revision) {
          moved();
          continue;
        }
        try {
          const { reverts, changes, resolution } = takingBackItem(row, history, item);
          if (!reverts || applyChanges(changes, row.text) === row.text) {
            done.skipped.push({ ...titled(row), why: "nothing", message: `Nothing in ${name} would change` });
            continue;
          }
          const taken = await recordTakenBack(ctx, row, history, reverts, changes, resolution);
          // By the title it had: a revert can leave a note with another, or with none.
          if (taken) done.reverted.push({ ...titled(row), revision: taken.next.revision, reverted: reverts.revisions, ...(taken.unfiled && { unfiled: taken.unfiled }) });
          else moved();
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          done.skipped.push({ ...titled(row), why: "refused", message: err.message });
        }
      }
      return done;
    },
  },

  "note.move": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "edit");
      const folder = await loadFolder(ctx, op.folderId, "edit");
      if (folder.id !== row.folder_id) await intoFolder(ctx.db.prepare("UPDATE notes SET folder_id = ? WHERE id = ?").bind(folder.id, row.id).run());
      return toNote(ctx, { ...row, folder_id: folder.id });
    },
  },

  "folder.list": {
    needs: "view",
    async run(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id AND ${SEEN("n", "?2")}) AS note_count, ${FOLDER_COLUMNS}
           WHERE f.workspace_id = ?1 AND ${SEEN_FOLDER("f", "?2")} ORDER BY f.name COLLATE NOCASE, f.id`,
        )
        .bind(ctx.workspaceId, ctx.sight.bind)
        .all<FolderRow & { note_count: number }>();
      return { unsortedId: results.find((row) => row.unsorted)?.id ?? null, folders: results.map((row) => ({ ...toFolder(ctx, row), noteCount: row.note_count, access: folderLevel(ctx.sight, row.id) === "edit" ? "edit" : "view" })) };
    },
  },

  "folder.create": {
    needs: "edit",
    async run(ctx, op) {
      if (op.parentId) await loadFolder(ctx, op.parentId, "edit");
      else if (!seesEveryFolder(ctx.sight)) throw new OpError("forbidden", ctx.sight.within ? "An agent limited to folders can make a folder only inside one of them" : "A guest can make a folder only inside one shared with them");
      const folder: Folder = { id: newId(), name: op.name, parentId: op.parentId ?? null };
      await intoFolder(ctx.db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name) VALUES (?, ?, ?, ?)").bind(folder.id, ctx.workspaceId, folder.parentId, folder.name).run(), folder.name);
      return folder;
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
      await intoFolder(ctx.db.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(op.name, folder.id).run(), op.name);
      return toFolder(ctx, { ...folder, name: op.name });
    },
  },

  "folder.delete": {
    needs: "manage",
    async run(ctx, op) {
      // One statement, so a note or child folder added concurrently can't be left in a deleted folder.
      const UNSORTED = "(SELECT unsorted_folder_id FROM workspaces WHERE id = ?2)";
      const [, deleted] = await ctx.db.batch([
        // A folder that holds only notes the admin can't see is empty to them, and refusing to delete it would say otherwise. Those notes go to Unsorted, where their owners find them.
        ctx.db
          .prepare(
            `UPDATE notes SET folder_id = ${UNSORTED}
             WHERE folder_id = ?1 AND workspace_id = ?2 AND ?1 <> ${UNSORTED} AND NOT ${SEEN("notes", "?3")}
               AND EXISTS (SELECT 1 FROM folders f WHERE f.id = ?1 AND ${SEEN_FOLDER("f", "?3")})
               AND NOT EXISTS (SELECT 1 FROM notes v WHERE v.folder_id = ?1 AND ${SEEN("v", "?3")})
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = ?1)`,
          )
          .bind(op.id, ctx.workspaceId, ctx.sight.bind),
        ctx.db
          .prepare(
            `DELETE FROM folders WHERE id = ?1 AND workspace_id = ?2 AND id <> ${UNSORTED} AND ${SEEN_FOLDER("folders", "?3")}
               AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
          )
          .bind(op.id, ctx.workspaceId, ctx.sight.bind),
      ]);
      if (deleted!.meta.changes) return { id: op.id };
      const folder = await loadFolder(ctx, op.id, "edit");
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be deleted");
      throw new OpError("invalid", `"${folder.name}" isn't empty. Move or delete what's in it first.`);
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
  "invite.list": { needs: "manage", by: "member", run: (ctx) => listInvites(ctx.db, ctx.workspaceId) },
  "invite.revoke": { needs: "manage", by: "member", run: (ctx, op) => revokeInvite(asking(ctx), op.id) },

  // Who a note is shared with is not in history either, and a link can put a note before the whole internet. Only the member decides it: see NOT_FOR_AGENTS.
  "grant.list": { needs: "view", by: "member", run: (ctx, op) => listGrants(ctx, op) },
  // What each needs of its item is `canShare`'s to say: a viewer who owns a private note shares it, and can change nothing else.
  "grant.set": { needs: "view", by: "member", members: true, run: (ctx, op) => setGrant(ctx, op, op.email, op.access) },
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
        ctx.db.prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")} ORDER BY n.title COLLATE NOCASE, n.id`).bind(ctx.workspaceId, ctx.sight.bind),
      ]);
      const on = link!.results[0];
      if (!on) throw new OpError("not_found", NO_SUCH_LINK);
      // What is right inside the shared folder is at the top for the visitor, and the shared folder itself is named once, as `on`.
      const within = (folderId: string | null) => (folderId === on.folder_id ? null : folderId);
      return {
        link: on.kind,
        on: on.note_id !== null ? { kind: "note", id: on.note_id } : { kind: "folder", id: on.folder_id!, name: on.name! },
        folders: folders!.results.filter((f) => f.id !== on.folder_id).map((f) => ({ ...toFolder(ctx, f), parentId: within(f.parent_id) })),
        notes: notes!.results.map((row) => toShared(ctx, row, within)),
      };
    },
  },

  "shared.read": {
    needs: "view",
    by: "visitor",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id, "view");
      const ids = linkedIds(row.text);
      const titles = new Map(ids.length ? (await seenAmong(ctx, IDS_IN, JSON.stringify(ids))).map((r) => [r.id, r.title]) : []);
      return { ...toShared(ctx, row, (folderId) => folderId), text: row.text, revision: row.revision, links: ids.map((id) => ({ id, title: titles.get(id) ?? null })) };
    },
  },
};
