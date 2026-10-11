import { ChangeSet } from "@codemirror/state";
import { z } from "zod";
import { lineDiff } from "./diff.ts";
import { dayIn, redoTarget, revertedBy, takeBackOut, undoTarget } from "./history.ts";
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

const isBy = (ctx: Context, author: AuthorRef) => author.kind === ctx.actor.kind && author.id === authorId(ctx.actor);

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
const isChangeTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: changes\./.test(err.message);

/** What a change records beyond its diff. */
interface Recording {
  writeId?: string;
  reverts?: Reverts;
}

const insertChange = (ctx: Context, noteId: string, revision: number, baseRevision: number, changes: ChangeSet, { writeId, reverts }: Recording = {}) =>
  ctx.db
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at, write_id, reverts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(noteId, revision, baseRevision, ctx.actor.kind, authorId(ctx.actor), JSON.stringify(changes.toJSON()), ctx.now, writeId ?? null, reverts ? JSON.stringify(reverts) : null);

/** Records `changes` as the next revision of `row`. Null when another write took that revision first. */
async function record(ctx: Context, row: NoteRow, changes: ChangeSet, baseRevision: number, recording?: Recording): Promise<NoteRow | null> {
  const revision = row.revision + 1;
  const text = applyChanges(changes, row.text);
  if (text.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With the other changes merged in, the note would be over ${MAX_NOTE_LENGTH} characters`);
  const next: NoteRow = { ...row, revision, ...written(ctx, text) };
  try {
    await ctx.db.batch([
      insertChange(ctx, row.id, revision, baseRevision, changes, recording),
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
    const row = await loadNote(ctx, id);
    const { results } = await ctx.db
      .prepare("SELECT revision, author_kind, author_id, diff, reverts FROM changes WHERE note_id = ? AND revision <= ? ORDER BY revision")
      .bind(row.id, row.revision)
      .all<RecordedRow>();
    const history = results.map(toRecorded);
    const reverts = choose(history, revertedBy(history));
    if (!reverts) return toNote(row);
    const changes = takeBackOut(history, reverts);
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
      await intoFolder(ctx.db.batch(op.text ? [insertNote, insertChange(ctx, id, 1, 0, changesBetween("", op.text))] : [insertNote]));
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
          // At a tie, the stale write's insertion goes first: it stays next to the text it was typed after.
          changes = changesBetween(base.text, op.text).map(base.since, true);
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
      const { results } = await ctx.db.prepare(`SELECT ${CHANGE_COLUMNS} WHERE c.note_id = ? ORDER BY c.revision`).bind(op.id).all<ChangeRow>();
      const reverted = revertedBy(results.map(stepOf));
      return results.map((r) => toEntry(r, reverted));
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
           WHERE n.workspace_id = ? ORDER BY name COLLATE NOCASE, c.author_id`,
        )
        .bind(ctx.actor.workspaceId)
        .all<Pick<ChangeRow, "author_kind" | "author_id" | "name" | "agent_owner">>();
      return results.map((r) => authorOf(r.author_kind, r.author_id, r.name, r.agent_owner));
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
      const author = op.author ?? { kind: ctx.actor.kind, id: authorId(ctx.actor) };
      const { results } = await ctx.db
        .prepare(
          `SELECT c.created_at FROM changes c JOIN notes n ON n.id = c.note_id
           WHERE n.workspace_id = ?1 AND c.author_kind = ?2 AND c.author_id = ?3 AND (?4 IS NULL OR c.created_at >= ?4) AND (?5 IS NULL OR c.created_at < ?5)
           ORDER BY c.created_at`,
        )
        .bind(ctx.actor.workspaceId, author.kind, author.id, op.from ?? null, op.to ?? null)
        .all<{ created_at: number }>();
      const counts = new Map<string, number>();
      for (const { created_at } of results) counts.set(day(created_at), (counts.get(day(created_at)) ?? 0) + 1);
      return { timeZone: op.timeZone, days: [...counts].map(([date, count]) => ({ date, count })) };
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
