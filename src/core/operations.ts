import { ChangeSet, MapMode } from "@codemirror/state";
import { z } from "zod";
import { SEEN, SEEN_FOLDER, allows, folderLevel, noteLevel, type GrantLevel, type Sight } from "./access.ts";
import { lineDiff } from "./diff.ts";
import { dayIn, redoTarget, revertOfAuthor, revertedBy, takeBackOut, undoTarget } from "./history.ts";
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
  type Folder,
  type HistoryEntry,
  type ListedTodo,
  type Note,
  type NoteSummary,
  type OpInput,
  type OpType,
  type Results,
  type Reverts,
  type Role,
  type SharedNote,
} from "./protocol.ts";
import { linkTo, listGrants, revokeGrant, setGrant, setPrivate } from "./sharing.ts";
import { noteSlug } from "./slug.ts";
import { NO_SUCH_LINK, standingByLink, standingIn, type Standing } from "./standing.ts";
import { applyChanges, changesBetween } from "./text.ts";
import { changeTodo, nameKey, parseTodo, todoIndex, todosIn } from "./todos.ts";

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

/** What narrows an agent's token below its member: one workspace, and no changes. */
export interface AgentScope {
  pinnedWorkspaceId?: string | null;
  readOnly?: boolean;
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
const ALLOWS: Record<Standing["most"], ReadonlySet<Access>> = {
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
  /** Set when a guest may not ask, only a member of the workspace. */
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
  const standing = actor.kind === "visitor" ? await standingByLink(db, actor.token, actor.personId) : await standingIn(db, actor.personId, actor.workspaceId);
  if (!standing) throw new OpError("not_found", NO_SUCH_WORKSPACE);
  // Whoever holds a link is let into the operations made for them and no other, whatever is added later.
  if ((actor.kind === "visitor") !== (handler.by === "visitor")) throw new OpError("forbidden", actor.kind === "visitor" ? `A link can't ${op.type}` : `Only a link can ${op.type}`);
  if (actor.kind === "agent" && handler.by === "member") throw new OpError("forbidden", `An agent can't ${op.type}`);
  if (actor.kind === "agent" && actor.scope?.readOnly && handler.needs !== "view") throw new OpError("forbidden", `A read-only token can't ${op.type}`);
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

/** What a note's `indexed` is once its links, todos, projects and tags have been made from its text. */
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

const sameAuthor = (a: AuthorRef, b: AuthorRef) => a.kind === b.kind && a.id === b.id;
const isBy = (ctx: Context, author: AuthorRef) => sameAuthor(author, { kind: ctx.author.kind, id: authorId(ctx) });

const NO_SUCH_NOTE = "No such note";
const NO_SUCH_FOLDER = "No such folder";

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
  if (!allows(level, need)) throw new OpError("forbidden", "You can read this note, and not change it");
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

const INDEXED = {
  todos: "INSERT INTO todos (note_id, line, done, importance, due, text) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')",
  projects: "INSERT INTO todo_projects (note_id, line, project, name) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')",
  tags: "INSERT INTO note_tags (note_id, tag, name) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]')",
} as const;
const INDEX_TABLE = { todos: "todos", projects: "todo_projects", tags: "note_tags" } as const;

/**
 * The statements that make the index of a note's todos, their projects, and its tags what `text`
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
 * Makes the links, todos, projects and tags of the notes that have never had them made, from their
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

/** The note's text at `revision`, and the changes after it up to `current` composed into one. */
async function replay(ctx: Context, id: string, revision: number, current: number): Promise<{ text: string; since: ChangeSet }> {
  const { results } = await ctx.db
    .prepare("SELECT revision, diff FROM changes WHERE note_id = ? AND revision <= ? ORDER BY revision")
    .bind(id, current)
    .all<{ revision: number; diff: string }>();
  let text = "";
  let since: ChangeSet | null = null;
  for (const row of results) {
    const changes = ChangeSet.fromJSON(JSON.parse(row.diff));
    if (row.revision <= revision) text = applyChanges(changes, text);
    else since = since ? since.compose(changes) : changes;
  }
  return { text, since: since ?? ChangeSet.empty(text.length) };
}

const MAX_WRITE_ATTEMPTS = 5;
/** Reverting an author reads each note's whole record and costs a few queries a note, and a request is allowed only so many. */
const REVERT_AUTHOR_NOTES = 10;
/** A handful of statements a note, in one batch. */
const MEND_NOTES = 20;
/** As many batches as one request makes, so a workspace of any size is mended over a few. */
const MEND_BATCHES = 20;
const isChangeTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: changes\./.test(err.message);

/** What a change records beyond its diff. */
interface Recording {
  writeId?: string;
  reverts?: Reverts;
}

const insertChange = (ctx: Context, noteId: string, revision: number, baseRevision: number, changes: ChangeSet, { writeId, reverts }: Recording = {}) =>
  ctx.db
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at, write_id, reverts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(noteId, revision, baseRevision, ctx.author.kind, authorId(ctx), JSON.stringify(changes.toJSON()), ctx.now, writeId ?? null, reverts ? JSON.stringify(reverts) : null);

/** Records `changes` as the next revision of `row`. Null when another write took that revision first. */
async function record(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, recording?: Recording): Promise<NoteRow | null> {
  const revision = row.revision + 1;
  const text = applyChanges(changes, row.text);
  if (text.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With the other changes merged in, the note would be over ${MAX_NOTE_LENGTH} characters`);
  const next: NoteRow = { ...row, revision, indexed: MADE, ...written(ctx, text) };
  // A note never indexed has all of it made now, whatever this change touched.
  const was = row.indexed < MADE ? {} : { was: row.text };
  try {
    await ctx.db.batch([
      insertChange(ctx, row.id, revision, baseRevision, changes, recording),
      ctx.db
        .prepare("UPDATE notes SET revision = ?, text = ?, title = ?, snippet = ?, open_todos = ?, updated_at = ?, updated_by = ?, updated_by_kind = ?, indexed = ? WHERE id = ? AND revision = ?")
        .bind(revision, next.text, next.title, next.snippet, next.open_todos, next.updated_at, next.updated_by, next.updated_by_kind, MADE, row.id, row.revision),
      ...linking(ctx, row.id, text, was),
      ...indexing(ctx, row.id, text, was),
    ]);
  } catch (err) {
    if (isChangeTaken(err)) return null;
    throw err;
  }
  return next;
}

/** Runs a write again from the note as it now stands, each time another write took its revision. */
async function settle<T>(write: () => Promise<T | null>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const done = await write();
    if (done !== null) return done;
  }
  throw new Error("The note changed under every attempt to write it");
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
}

const CHANGE_COLUMNS = `c.note_id, c.revision, c.base_revision, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner, c.created_at, c.reverts, l.name AS label
  FROM changes c
  LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
  LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
  LEFT JOIN labels l ON l.note_id = c.note_id AND l.revision = c.revision`;

const revertsOf = (json: string | null) => (json ? (JSON.parse(json) as Reverts) : null);
const stepOf = (r: { revision: number; reverts: string | null }) => ({ revision: r.revision, reverts: revertsOf(r.reverts) });

const toEntry = (r: ChangeRow, reverted: ReadonlyMap<number, number>): ChangeEntry => ({
  revision: r.revision,
  baseRevision: r.base_revision,
  author: authorOf(r.author_kind, r.author_id, r.name, r.agent_owner),
  createdAt: r.created_at,
  label: r.label,
  reverts: revertsOf(r.reverts),
  revertedBy: reverted.get(r.revision) ?? null,
});

/** A note's change as moving through history reads it. */
interface Recorded {
  revision: number;
  author: AuthorRef;
  changes: ChangeSet;
  reverts: Reverts | null;
}

interface RecordedRow {
  revision: number;
  author_kind: AuthorRef["kind"];
  author_id: string;
  diff: string;
  reverts: string | null;
}

const toRecorded = (r: RecordedRow): Recorded => ({
  ...stepOf(r),
  author: { kind: r.author_kind, id: r.author_id },
  changes: ChangeSet.fromJSON(JSON.parse(r.diff)),
});

const list = (revisions: number[]) => (revisions.length === 1 ? `change ${revisions[0]}` : `changes ${revisions.slice(0, -1).join(", ")} and ${revisions.at(-1)}`);

/**
 * Records one change that takes other changes back out of a note. `choose` names them from the note's
 * changes so far, or returns null to leave the note as it is.
 */
function takeBack(ctx: Context, id: string, choose: (history: Recorded[], reverted: Map<number, number>) => Reverts | null): Promise<Note> {
  return settle(async () => {
    const row = await loadNote(ctx, id, "edit");
    const { results } = await ctx.db
      .prepare("SELECT revision, author_kind, author_id, diff, reverts FROM changes WHERE note_id = ? AND revision <= ? ORDER BY revision")
      .bind(row.id, row.revision)
      .all<RecordedRow>();
    const history = results.map(toRecorded);
    const reverts = choose(history, revertedBy(history));
    if (!reverts) return toNote(ctx, row);
    const changes = takeBackOut(history, reverts);
    const next = await record(ctx, row, changes, row.revision, { reverts });
    return next && toNote(ctx, next);
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
      await intoFolder(ctx.db.batch(text ? [insertNote, insertChange(ctx, id, 1, 0, changesBetween("", text)), ...linking(ctx, id, text, { was: "" }), ...indexing(ctx, id, text, { was: "" })] : [insertNote]));
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
      const { results } = await ctx.db
        .prepare(
          `SELECT t.note_id, t.line, t.done, t.importance, t.due, t.text, n.title, n.revision, n.folder_id, n.private_owner,
             (SELECT json_group_array(name) FROM (SELECT g.name FROM note_tags g WHERE g.note_id = t.note_id ORDER BY g.rowid)) AS tags
           FROM todos t JOIN notes n ON n.id = t.note_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")}
             AND (?3 = 1 OR t.done = 0)
             AND (?4 IS NULL OR EXISTS (SELECT 1 FROM todo_projects p WHERE p.note_id = t.note_id AND p.line = t.line AND p.project = ?4))
             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM note_tags g WHERE g.note_id = t.note_id AND g.tag = ?5))
             AND (?6 IS NULL OR t.due >= ?6)
             AND (?7 IS NULL OR t.due <= ?7)
             AND (?8 = 0 OR t.due IS NULL)
             AND (?9 IS NULL OR t.importance IN (SELECT value FROM json_each(?9)))
             AND (?10 IS NULL OR t.note_id = ?10)
           ORDER BY t.done, t.due IS NULL, t.due, t.importance DESC, n.title COLLATE NOCASE, t.note_id, t.line
           LIMIT ?11 OFFSET ?12`,
        )
        .bind(
          ctx.workspaceId,
          ctx.sight.bind,
          op.includeCompleted ? 1 : 0,
          op.project === undefined ? null : nameKey(op.project),
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
            projects: todo?.projects.map((p) => p.name) ?? [],
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
      const [projects, tags] = await ctx.db.batch<{ name: string }>([
        ctx.db
          .prepare(`SELECT MIN(p.name) AS name FROM todo_projects p JOIN notes n ON n.id = p.note_id WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")} GROUP BY p.project ORDER BY p.project`)
          .bind(ctx.workspaceId, ctx.sight.bind),
        ctx.db
          .prepare(
            `SELECT MIN(g.name) AS name FROM note_tags g JOIN notes n ON n.id = g.note_id
             WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2")} AND EXISTS (SELECT 1 FROM todos t WHERE t.note_id = g.note_id) GROUP BY g.tag ORDER BY g.tag`,
          )
          .bind(ctx.workspaceId, ctx.sight.bind),
      ]);
      return { projects: projects!.results.map((r) => r.name), tags: tags!.results.map((r) => r.name) };
    },
  },

  "todo.set": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async () => {
        const row = await loadNote(ctx, op.id, "edit");
        if (op.revision > row.revision) throw new OpError("invalid", `The note has no revision ${op.revision}`);
        const { id: _, type: __, revision, line, text: listedAs, ...change } = op;
        let wanted: string;
        try {
          wanted = changeTodo(listedAs, change);
        } catch (err) {
          throw err instanceof RangeError ? new OpError("invalid", err.message) : err;
        }
        // The todo is the line the caller was shown, followed through each change recorded since. What a
        // line says never decides which line it is: another todo may say the same.
        const then = revision === row.revision ? { text: row.text, since: null } : await replay(ctx, row.id, revision, row.revision);
        const listed = todosIn(then.text).find((todo) => todo.line === line && todo.text === listedAs);
        const at = !listed ? null : then.since ? then.since.mapPos(listed.from, 1, MapMode.TrackAfter) : listed.from;
        const todo = at === null ? undefined : todosIn(row.text).find((t) => t.from <= at && at <= t.from + t.text.length);
        // Asked again after it was done, as a call that failed on its way back is: the line already says so.
        if (todo && todo.text !== listedAs && todo.text === wanted) return toNote(ctx, row);
        if (!todo || todo.text !== listedAs) throw new OpError("conflict", "This todo was changed since it was listed. List the todos again.");
        if (wanted === listedAs) return toNote(ctx, row);
        const next = await record(ctx, row, changesBetween(row.text, row.text.slice(0, todo.from) + wanted + row.text.slice(todo.from + todo.text.length)), row.revision);
        return next && toNote(ctx, next);
      }),
  },

  "todos.rebuild": rebuild,

  "note.write": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async () => {
        const row = await loadNote(ctx, op.id, "edit");
        if (op.writeId) {
          const recorded = await ctx.db.prepare("SELECT 1 FROM changes WHERE note_id = ? AND write_id = ?").bind(row.id, op.writeId).first();
          if (recorded) return toNote(ctx, row);
        }
        if (op.baseRevision > row.revision) throw new OpError("invalid", `The note has no revision ${op.baseRevision}`);
        const base = op.baseRevision === row.revision ? { text: row.text, since: null } : await replay(ctx, row.id, op.baseRevision, row.revision);
        const changed = changesBetween(base.text, await linkedById(ctx, op.text, base.text, op.linkTitles));
        // At a tie, the stale write's insertion goes first: it stays next to the text it was typed after.
        const changes = base.since ? changed.map(base.since, true) : changed;
        if (changes.empty) return toNote(ctx, row);
        const next = await record(ctx, row, changes, op.baseRevision, { writeId: op.writeId });
        return next && toNote(ctx, next);
      }),
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id, "view");
      const { results } = await ctx.db.prepare(`SELECT ${CHANGE_COLUMNS} WHERE c.note_id = ? ORDER BY c.revision`).bind(op.id).all<ChangeRow>();
      const reverted = revertedBy(results.map(stepOf));
      return results.map((r) => toEntry(r, reverted));
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
    run: (ctx, op) =>
      takeBack(ctx, op.id, (history) => {
        if (op.revision > history.length) throw new OpError("not_found", `The note has no revision ${op.revision}`);
        if (op.revision === history.length) return null;
        return { how: "revert", revisions: history.slice(op.revision).map((c) => c.revision), to: op.revision };
      }),
  },

  "note.revertChanges": {
    needs: "edit",
    run: (ctx, op) =>
      takeBack(ctx, op.id, (history, reverted) => {
        const revisions = chosen(op.revisions, history);
        const gone = revisions.find((r) => reverted.has(r));
        if (gone !== undefined) throw new OpError("invalid", `Change ${gone} was already taken back out, by change ${reverted.get(gone)}`);
        return { how: "revert", revisions };
      }),
  },

  "note.reapplyChanges": {
    needs: "edit",
    run: (ctx, op) =>
      takeBack(ctx, op.id, (history, reverted) => {
        const revisions = chosen(op.revisions, history);
        const standing = revisions.find((r) => !reverted.has(r));
        if (standing !== undefined) throw new OpError("invalid", `Change ${standing} wasn't taken back out, so there's nothing to put back`);
        // A change that took several out together can only be taken back whole.
        const reverters = [...new Set(revisions.map((r) => reverted.get(r)!))].sort((a, b) => a - b);
        for (const reverter of reverters) {
          const together = history[reverter - 1]!.reverts!.revisions.filter((r) => reverted.get(r) === reverter);
          if (together.some((r) => !revisions.includes(r))) throw new OpError("invalid", `Change ${reverter} took ${list(together)} out together, so put them back together`);
        }
        return { how: "revert", revisions: reverters };
      }),
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

  "history.list": {
    needs: "view",
    async run(ctx, op) {
      const { results } = await ctx.db
        .prepare(
          `SELECT n.title, ${CHANGE_COLUMNS}
           JOIN notes n ON n.id = c.note_id
           WHERE n.workspace_id = ?1 AND ${SEEN("n", "?10")}
             AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
             AND (?4 IS NULL OR c.created_at >= ?4)
             AND (?5 IS NULL OR c.created_at < ?5)
             AND (?6 IS NULL OR (c.created_at, c.note_id, c.revision) < (?6, ?7, ?8))
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
        )
        .all<ChangeRow & { title: string }>();
      const page = results.slice(0, op.limit);
      const last = results.length > op.limit ? page.at(-1)! : null;

      // A change's diff needs the text before it, and whether it still stands needs every later change.
      const { results: recorded } = await ctx.db
        .prepare(`SELECT note_id, revision, reverts${op.diffs ? ", diff" : ""} FROM changes WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY note_id, revision`)
        .bind(JSON.stringify([...new Set(page.map((r) => r.note_id))]))
        .all<{ note_id: string; revision: number; reverts: string | null; diff?: string }>();
      const reverted = new Map<string, Map<number, number>>();
      const diffs = new Map<string, HistoryEntry["diff"]>();
      for (const [noteId, rows] of Map.groupBy(recorded, (r) => r.note_id)) {
        reverted.set(noteId, revertedBy(rows.map(stepOf)));
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
        changes: page.map((r) => ({ ...toEntry(r, reverted.get(r.note_id)!), noteId: r.note_id, noteTitle: r.title, diff: diffs.get(`${r.note_id}/${r.revision}`) ?? null })),
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
          const { text, ...note } = await takeBack(ctx, id, (history) => (reverts = revertOfAuthor(history, theirs)));
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

  "history.activity": {
    needs: "view",
    async run(ctx, op) {
      let day: (time: number) => string;
      try {
        day = dayIn(op.timeZone);
      } catch {
        throw new OpError("invalid", `There's no time zone named ${op.timeZone}`);
      }
      const author = op.author ?? { kind: ctx.author.kind, id: authorId(ctx) };
      const { results } = await ctx.db
        .prepare(
          `SELECT c.created_at FROM changes c JOIN notes n ON n.id = c.note_id
           WHERE n.workspace_id = ?1 AND c.author_kind = ?2 AND c.author_id = ?3 AND (?4 IS NULL OR c.created_at >= ?4) AND (?5 IS NULL OR c.created_at < ?5) AND ${SEEN("n", "?6")}
           ORDER BY c.created_at`,
        )
        .bind(ctx.workspaceId, author.kind, author.id, op.from ?? null, op.to ?? null, ctx.sight.bind)
        .all<{ created_at: number }>();
      const counts = new Map<string, number>();
      for (const { created_at } of results) counts.set(day(created_at), (counts.get(day(created_at)) ?? 0) + 1);
      return { timeZone: op.timeZone, days: [...counts].map(([date, count]) => ({ date, count })) };
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
      else if (!ctx.role) throw new OpError("forbidden", "A guest can make a folder only inside one shared with them");
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
      // Beside a folder shared with a guest are folders they can't see, and a name refused for being taken would name one.
      if (!ctx.role && !(folder.parent_id && allows(folderLevel(ctx.sight, folder.parent_id), "view"))) throw new OpError("forbidden", "A guest can rename only the folders inside one shared with them");
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
               AND NOT EXISTS (SELECT 1 FROM notes v WHERE v.folder_id = ?1 AND ${SEEN("v", "?3")})
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = ?1)`,
          )
          .bind(op.id, ctx.workspaceId, ctx.sight.bind),
        ctx.db
          .prepare(
            `DELETE FROM folders WHERE id = ?1 AND workspace_id = ?2 AND id <> ${UNSORTED}
               AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
               AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
          )
          .bind(op.id, ctx.workspaceId),
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
