import { ChangeSet } from "@codemirror/state";
import { z } from "zod";
import { lineDiff } from "./diff.ts";
import { dayIn, overlapping, rebased, redoTarget, revertOfAuthor, revertedBy, takeBackOut, undoTarget } from "./history.ts";
import { newId } from "./ids.ts";
import { summarize } from "./markdown.ts";
import {
  MAX_NOTE_LENGTH,
  Op,
  OpError,
  type Author,
  type AuthorRef,
  type ChangeEntry,
  type Folder,
  type HistoryEntry,
  type Note,
  type NoteSummary,
  type OpInput,
  type OpType,
  type Results,
  type Reverts,
  type Role,
} from "./protocol.ts";
import { noteSlug } from "./slug.ts";
import { applyChanges, changesBetween } from "./text.ts";

/** Who is performing an operation, in which workspace. */
export type Actor =
  | { kind: "member"; personId: string; workspaceId: string }
  /** An agent acts as `personId`: their role in the workspace, so their access, and no more. */
  | { kind: "agent"; agentId: string; personId: string; workspaceId: string; scope?: AgentScope };

/** What narrows an agent's token below its member: one workspace, and no changes. */
export interface AgentScope {
  pinnedWorkspaceId?: string | null;
  readOnly?: boolean;
}

const authorId = (actor: Actor) => (actor.kind === "agent" ? actor.agentId : actor.personId);

interface Context {
  db: D1Database;
  actor: Actor;
  author: Author;
  now: number;
}

type Access = "view" | "edit" | "manage";
const ALLOWS: Record<Role, ReadonlySet<Access>> = {
  admin: new Set(["view", "edit", "manage"]),
  editor: new Set(["view", "edit"]),
  viewer: new Set(["view"]),
};

type Handler<K extends OpType> = {
  needs: Access;
  run: (ctx: Context, op: Extract<Op, { type: K }>) => Promise<Results[K]>;
};

/** Every operation on a workspace. The web app, CLI, and MCP server all come through here. */
export async function perform<T extends OpInput>(db: D1Database, actor: Actor, input: T, now = Date.now()): Promise<Results[T["type"]]> {
  const parsed = Op.safeParse(input);
  if (!parsed.success) throw new OpError("invalid", z.prettifyError(parsed.error));
  const op = parsed.data;
  const handler = HANDLERS[op.type] as Handler<OpType>;

  if (actor.kind === "agent" && actor.scope?.pinnedWorkspaceId && actor.scope.pinnedWorkspaceId !== actor.workspaceId) throw new OpError("not_found", "No such workspace");
  const member = await db
    .prepare("SELECT m.role, p.name, a.name AS agent_name FROM members m JOIN people p ON p.id = m.person_id LEFT JOIN agents a ON a.id = ? WHERE m.workspace_id = ? AND m.person_id = ?")
    .bind(actor.kind === "agent" ? actor.agentId : null, actor.workspaceId, actor.personId)
    .first<{ role: Role; name: string; agent_name: string | null }>();
  if (!member) throw new OpError("not_found", "No such workspace");
  if (actor.kind === "agent" && actor.scope?.readOnly && handler.needs !== "view") throw new OpError("forbidden", `A read-only token can't ${op.type}`);
  if (!ALLOWS[member.role].has(handler.needs)) throw new OpError("forbidden", `A ${member.role} can't ${op.type}`);

  const author: Author =
    actor.kind === "agent"
      ? { kind: "agent", agentId: actor.agentId, name: member.agent_name ?? "An agent", onBehalfOf: actor.personId }
      : { kind: "member", personId: actor.personId, name: member.name };
  return handler.run({ db, actor, author, now }, op as never) as Promise<Results[T["type"]]>;
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
  updated_by_kind: Actor["kind"] | "plugin";
  updated_by_name: string | null;
  updated_by_owner: string | null;
}

interface NoteRow extends SummaryRow {
  text: string;
}

const SUMMARY_COLUMNS = `n.id, n.folder_id, n.revision, n.title, n.snippet, n.open_todos, n.created_at, n.updated_at, n.updated_by, n.updated_by_kind,
    COALESCE(p.name, a.name) AS updated_by_name, a.person_id AS updated_by_owner
  FROM notes n
  LEFT JOIN people p ON n.updated_by_kind = 'member' AND p.id = n.updated_by
  LEFT JOIN agents a ON n.updated_by_kind = 'agent' AND a.id = n.updated_by`;

/** The member or agent a change or a note names by the kind and id stored with it. */
const authorOf = (kind: string, id: string, name: string | null, owner: string | null): Author =>
  kind === "agent" ? { kind: "agent", agentId: id, name: name ?? "An agent", onBehalfOf: owner ?? "" } : { kind: "member", personId: id, name: name ?? "Someone" };

const toSummary = (row: SummaryRow): NoteSummary => ({
  id: row.id,
  title: row.title,
  slug: noteSlug(row.title),
  folderId: row.folder_id,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: authorOf(row.updated_by_kind, row.updated_by, row.updated_by_name, row.updated_by_owner),
  snippet: row.snippet,
  openTodos: row.open_todos,
});

function toNote(row: NoteRow, text = row.text, revision = row.revision): Note {
  if (text !== row.text) {
    const { title, snippet, openTodos } = summarize(text);
    row = { ...row, title, snippet, open_todos: openTodos };
  }
  return { ...toSummary(row), revision, text };
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
    updated_by: authorId(ctx.actor),
    updated_by_kind: ctx.actor.kind,
    updated_by_name: author.name,
    updated_by_owner: author.kind === "agent" ? author.onBehalfOf : null,
  };
}

const sameAuthor = (a: AuthorRef, b: AuthorRef) => a.kind === b.kind && a.id === b.id;
const isBy = (ctx: Context, author: AuthorRef) => sameAuthor(author, { kind: ctx.actor.kind, id: authorId(ctx.actor) });

async function loadNote(ctx: Context, id: string): Promise<NoteRow> {
  const row = await ctx.db
    .prepare(`SELECT n.text, ${SUMMARY_COLUMNS} WHERE n.id = ? AND n.workspace_id = ?`)
    .bind(id, ctx.actor.workspaceId)
    .first<NoteRow>();
  if (!row) throw new OpError("not_found", "No such note");
  return row;
}

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  unsorted: number;
}

const FOLDER_COLUMNS = "f.id, f.parent_id, f.name, f.id = w.unsorted_folder_id AS unsorted FROM folders f JOIN workspaces w ON w.id = f.workspace_id";

const toFolder = (row: FolderRow): Folder => ({ id: row.id, name: row.name, parentId: row.parent_id });

/** The folder `id` in the actor's workspace, or its Unsorted folder when `id` is undefined. */
async function loadFolder(ctx: Context, id: string | undefined): Promise<FolderRow> {
  const row = await ctx.db
    .prepare(`SELECT ${FOLDER_COLUMNS} WHERE f.workspace_id = ? AND f.id = COALESCE(?, w.unsorted_folder_id)`)
    .bind(ctx.actor.workspaceId, id ?? null)
    .first<FolderRow>();
  if (!row) throw new OpError("not_found", "No such folder");
  return row;
}

/** A write naming a folder or putting something in one, whose folder may have been deleted since it was loaded. */
async function intoFolder(write: Promise<unknown>, name?: string): Promise<void> {
  try {
    await write;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/FOREIGN KEY constraint failed/.test(message)) throw new OpError("not_found", "No such folder");
    if (/UNIQUE constraint failed: index 'folders_by_name'/.test(message)) throw new OpError("invalid", `There's already a folder named "${name}" here`);
    throw err;
  }
}

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

const MAX_WRITE_ATTEMPTS = 5;
/** Reverting an author reads each note's whole record and costs a few queries a note, and a request is allowed only so many. */
const REVERT_AUTHOR_NOTES = 10;
const isChangeTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: changes\./.test(err.message);

/** What a change records beyond its diff. */
interface Recording {
  writeId?: string;
  reverts?: Reverts;
}

/** Records `changes` to a note whose text was `before`, with the lines it added and removed counted. */
function insertChange(ctx: Context, noteId: string, revision: number, baseRevision: number, before: string, changes: ChangeSet, { writeId, reverts }: Recording = {}) {
  const { added, removed } = lineDiff(before, changes);
  return ctx.db
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at, write_id, reverts, added, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(noteId, revision, baseRevision, ctx.actor.kind, authorId(ctx.actor), JSON.stringify(changes.toJSON()), ctx.now, writeId ?? null, reverts ? JSON.stringify(reverts) : null, added, removed);
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

/** Records `changes` as the next revision of `row`. Null when another write took that revision first. */
async function record(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, recording?: Recording): Promise<NoteRow | null> {
  const revision = row.revision + 1;
  const text = applyChanges(changes, row.text);
  if (text.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With the other changes merged in, the note would be over ${MAX_NOTE_LENGTH} characters`);
  const next: NoteRow = { ...row, revision, ...written(ctx, text) };
  try {
    await ctx.db.batch([
      insertChange(ctx, row.id, revision, baseRevision, row.text, changes, recording),
      ctx.db
        .prepare("UPDATE notes SET revision = ?, text = ?, title = ?, snippet = ?, open_todos = ?, updated_at = ?, updated_by = ?, updated_by_kind = ? WHERE id = ? AND revision = ?")
        .bind(revision, next.text, next.title, next.snippet, next.open_todos, next.updated_at, next.updated_by, next.updated_by_kind, row.id, row.revision),
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

const toEntry = (r: ChangeRow, reverted: ReadonlyMap<number, number>): ChangeEntry => ({
  revision: r.revision,
  baseRevision: r.base_revision,
  author: authorOf(r.author_kind, r.author_id, r.name, r.agent_owner),
  createdAt: r.created_at,
  label: r.label,
  reverts: revertsOf(r.reverts),
  revertedBy: reverted.get(r.revision) ?? null,
  added: r.added ?? 0,
  removed: r.removed ?? 0,
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

/** Names the changes to take back out from the note's changes so far, or returns null to leave the note as it is. */
type Choose = (history: Recorded[], reverted: Map<number, number>) => Reverts | null;

/** The note as it stands, and the change that would take back out of it what `choose` names. */
async function takingBack(ctx: Context, id: string, choose: Choose): Promise<{ row: NoteRow; history: Recorded[]; reverts: Reverts | null; changes: ChangeSet }> {
  const row = await loadNote(ctx, id);
  const { results } = await ctx.db
    .prepare("SELECT revision, author_kind, author_id, diff, reverts FROM changes WHERE note_id = ? AND revision <= ? ORDER BY revision")
    .bind(row.id, row.revision)
    .all<RecordedRow>();
  const history = results.map(toRecorded);
  const reverts = choose(history, revertedBy(history));
  return { row, history, reverts, changes: reverts ? takeBackOut(history, reverts) : ChangeSet.empty(row.text.length) };
}

/** Records one change that takes other changes back out of a note. */
function takeBack(ctx: Context, id: string, choose: Choose): Promise<Note> {
  return settle(async () => {
    const { row, reverts, changes } = await takingBack(ctx, id, choose);
    if (!reverts) return toNote(row);
    const next = await record(ctx, row, changes, row.revision, { reverts });
    return next && toNote(next);
  });
}

/** The chosen revisions in order, each one a change the note has. */
function chosen(revisions: number[], history: Recorded[]): number[] {
  const missing = revisions.find((r) => r > history.length);
  if (missing !== undefined) throw new OpError("not_found", `The note has no change ${missing}`);
  return [...new Set(revisions)].sort((a, b) => a - b);
}

/** Every change after `revision`: the note goes back to how it was then. */
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

const HANDLERS: { [K in OpType]: Handler<K> } = {
  "note.list": {
    needs: "view",
    async run(ctx, op) {
      const { results } = await ctx.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ?1 AND (?2 IS NULL OR n.folder_id = ?2) AND (?3 IS NULL OR n.updated_at >= ?3) ORDER BY n.updated_at DESC`)
        .bind(ctx.actor.workspaceId, op.folderId ?? null, op.updatedSince ?? null)
        .all<SummaryRow>();
      return results.map(toSummary);
    },
  },

  "note.create": {
    needs: "edit",
    async run(ctx, op) {
      const folder = await loadFolder(ctx, op.folderId);
      const id = newId();
      const revision = op.text ? 1 : 0;
      const row: NoteRow = { id, folder_id: folder.id, revision, created_at: ctx.now, ...written(ctx, op.text) };
      const insertNote = ctx.db
        .prepare(
          `INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, snippet, open_todos, created_at, updated_at, updated_by, updated_by_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.actor.workspaceId, row.folder_id, revision, row.text, row.title, row.snippet, row.open_todos, row.created_at, row.updated_at, row.updated_by, row.updated_by_kind);
      await intoFolder(ctx.db.batch(op.text ? [insertNote, insertChange(ctx, id, 1, 0, "", changesBetween("", op.text))] : [insertNote]));
      return toNote(row);
    },
  },

  "note.read": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id);
      if (op.revision === undefined || op.revision === row.revision) return toNote(row);
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no revision ${op.revision}`);
      return toNote(row, (await replay(ctx, op.id, op.revision, row.revision)).text, op.revision);
    },
  },

  "note.write": {
    needs: "edit",
    run: (ctx, op) =>
      settle(async () => {
        const row = await loadNote(ctx, op.id);
        if (op.writeId) {
          const recorded = await ctx.db.prepare("SELECT 1 FROM changes WHERE note_id = ? AND write_id = ?").bind(row.id, op.writeId).first();
          if (recorded) return toNote(row);
        }
        if (op.baseRevision > row.revision) throw new OpError("invalid", `The note has no revision ${op.baseRevision}`);
        let changes: ChangeSet;
        if (op.baseRevision === row.revision) {
          changes = changesBetween(row.text, op.text);
        } else {
          const base = await replay(ctx, row.id, op.baseRevision, row.revision);
          changes = rebased(base.text, op.text, base.since);
        }
        if (changes.empty) return toNote(row);
        const next = await record(ctx, row, changes, op.baseRevision, { writeId: op.writeId });
        return next && toNote(next);
      }),
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id);
      await countLines(ctx, [op.id]);
      const { results } = await ctx.db.prepare(`SELECT ${CHANGE_COLUMNS} WHERE c.note_id = ? ORDER BY c.revision`).bind(op.id).all<ChangeRow>();
      const reverted = revertedBy(results.map(stepOf));
      return results.map((r) => toEntry(r, reverted));
    },
  },

  "note.diff": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id);
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no change ${op.revision}`);
      const { text, since } = await replay(ctx, row.id, op.revision - 1, op.revision);
      return lineDiff(text, since[0]!);
    },
  },

  "note.label": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id);
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
            .bind(row.id, op.revision, op.name, ctx.actor.kind, authorId(ctx.actor), ctx.now)
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
    run: (ctx, op) => takeBack(ctx, op.id, revertTo(op.revision)),
  },

  "note.revertChanges": {
    needs: "edit",
    run: (ctx, op) => takeBack(ctx, op.id, revertOf(op.revisions)),
  },

  "note.previewRevert": {
    // It shows nothing a viewer can't already read: the note at any revision, and every change's diff.
    needs: "view",
    async run(ctx, op) {
      const author = op.author;
      const choose: Choose = author ? (history) => revertOfAuthor(history, (c) => sameAuthor(c.author, author)) : op.to !== undefined ? revertTo(op.to) : revertOf(op.revisions!);
      const { row, history, reverts, changes } = await takingBack(ctx, op.id, choose);
      return { revision: row.revision, revisions: reverts?.revisions ?? [], diff: lineDiff(row.text, changes), overlaps: reverts ? overlapping(history, reverts) : [] };
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
      const narrowed = `n.workspace_id = ?1
             AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
             AND (?4 IS NULL OR c.created_at >= ?4)
             AND (?5 IS NULL OR c.created_at < ?5)`;
      const binds = [ctx.actor.workspaceId, op.noteIds ? JSON.stringify(op.noteIds) : null, op.authors ? JSON.stringify(op.authors) : null, op.from ?? null, op.to ?? null];
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
             HAVING ?6 IS NULL OR last_at < ?6 OR (last_at = ?6 AND c.note_id < ?7)
             ORDER BY last_at DESC, c.note_id DESC
             LIMIT ?8`,
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
           WHERE ${narrowed} AND c.note_id IN (SELECT value FROM json_each(?6))
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
             WHERE n.workspace_id = ?1
               AND (?2 IS NULL OR c.note_id IN (SELECT value FROM json_each(?2)))
               AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = c.author_kind AND json_extract(j.value, '$.id') = c.author_id))
               AND (?4 IS NULL OR c.created_at >= ?4)
               AND (?5 IS NULL OR c.created_at < ?5)
               AND (?6 IS NULL OR (c.created_at, c.note_id, c.revision) < (?6, ?7, ?8))
             ORDER BY c.created_at DESC, c.note_id DESC, c.revision DESC
             LIMIT ?9`,
          )
          .bind(
            ctx.actor.workspaceId,
            op.noteIds ? JSON.stringify(op.noteIds) : null,
            op.authors ? JSON.stringify(op.authors) : null,
            op.from ?? null,
            op.to ?? null,
            op.before?.createdAt ?? null,
            op.before?.noteId ?? null,
            op.before?.revision ?? null,
            op.limit + 1,
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
           WHERE n.workspace_id = ? ORDER BY name COLLATE NOCASE, c.author_id`,
        )
        .bind(ctx.actor.workspaceId)
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
           WHERE n.workspace_id = ?1
             AND (?2 IS NULL OR n.id IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR n.id > ?3)
             AND EXISTS (SELECT 1 FROM changes c WHERE c.note_id = n.id AND c.author_kind = ?4 AND c.author_id = ?5)
           ORDER BY n.id LIMIT ?6`,
        )
        .bind(ctx.actor.workspaceId, op.noteIds ? JSON.stringify(op.noteIds) : null, op.after ?? null, op.author.kind, op.author.id, REVERT_AUTHOR_NOTES + 1)
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

  "note.move": {
    needs: "edit",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id);
      const folder = await loadFolder(ctx, op.folderId);
      if (folder.id !== row.folder_id) await intoFolder(ctx.db.prepare("UPDATE notes SET folder_id = ? WHERE id = ?").bind(folder.id, row.id).run());
      return toNote({ ...row, folder_id: folder.id });
    },
  },

  "folder.list": {
    needs: "view",
    async run(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id) AS note_count, ${FOLDER_COLUMNS}
           WHERE f.workspace_id = ? ORDER BY f.name COLLATE NOCASE, f.id`,
        )
        .bind(ctx.actor.workspaceId)
        .all<FolderRow & { note_count: number }>();
      return { unsortedId: results.find((row) => row.unsorted)!.id, folders: results.map((row) => ({ ...toFolder(row), noteCount: row.note_count })) };
    },
  },

  "folder.create": {
    needs: "edit",
    async run(ctx, op) {
      if (op.parentId) await loadFolder(ctx, op.parentId);
      const folder: Folder = { id: newId(), name: op.name, parentId: op.parentId ?? null };
      await intoFolder(ctx.db.prepare("INSERT INTO folders (id, workspace_id, parent_id, name) VALUES (?, ?, ?, ?)").bind(folder.id, ctx.actor.workspaceId, folder.parentId, folder.name).run(), folder.name);
      return folder;
    },
  },

  "folder.rename": {
    needs: "edit",
    async run(ctx, op) {
      const folder = await loadFolder(ctx, op.id);
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be renamed");
      await intoFolder(ctx.db.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(op.name, folder.id).run(), op.name);
      return toFolder({ ...folder, name: op.name });
    },
  },

  "folder.delete": {
    needs: "manage",
    async run(ctx, op) {
      // One statement, so a note or child folder added concurrently can't be left in a deleted folder.
      const { meta } = await ctx.db
        .prepare(
          `DELETE FROM folders WHERE id = ? AND workspace_id = ?
             AND id <> (SELECT unsorted_folder_id FROM workspaces WHERE id = folders.workspace_id)
             AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
             AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
        )
        .bind(op.id, ctx.actor.workspaceId)
        .run();
      if (meta.changes) return { id: op.id };
      const folder = await loadFolder(ctx, op.id);
      if (folder.unsorted) throw new OpError("invalid", "Unsorted can't be deleted");
      throw new OpError("invalid", `"${folder.name}" isn't empty. Move or delete what's in it first.`);
    },
  },
};
