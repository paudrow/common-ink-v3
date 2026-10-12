import { ChangeSet } from "@codemirror/state";
import { z } from "zod";
import { newId } from "./ids.ts";
import { summarize } from "./markdown.ts";
import { MAX_NOTE_LENGTH, Op, OpError, type Author, type ChangeEntry, type Folder, type Note, type NoteSummary, type OpInput, type OpType, type Results, type Role } from "./protocol.ts";
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

const insertChange = (ctx: Context, noteId: string, revision: number, baseRevision: number, changes: ChangeSet, writeId: string | null = null) =>
  ctx.db
    .prepare("INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at, write_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(noteId, revision, baseRevision, ctx.actor.kind, authorId(ctx.actor), JSON.stringify(changes.toJSON()), ctx.now, writeId);

const HANDLERS: { [K in OpType]: Handler<K> } = {
  "note.list": {
    needs: "view",
    async run(ctx, op) {
      const { results } = await ctx.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ? AND (? IS NULL OR n.folder_id = ?) ORDER BY n.updated_at DESC`)
        .bind(ctx.actor.workspaceId, op.folderId ?? null, op.folderId ?? null)
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
    async run(ctx, op) {
      for (let attempt = 1; ; attempt++) {
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

        const revision = row.revision + 1;
        const text = applyChanges(changes, row.text);
        if (text.length > MAX_NOTE_LENGTH) throw new OpError("invalid", `With the other changes merged in, the note would be over ${MAX_NOTE_LENGTH} characters`);
        const next: NoteRow = { ...row, revision, ...written(ctx, text) };
        try {
          await ctx.db.batch([
            insertChange(ctx, row.id, revision, op.baseRevision, changes, op.writeId),
            ctx.db
              .prepare("UPDATE notes SET revision = ?, text = ?, title = ?, snippet = ?, open_todos = ?, updated_at = ?, updated_by = ?, updated_by_kind = ? WHERE id = ? AND revision = ?")
              .bind(revision, next.text, next.title, next.snippet, next.open_todos, next.updated_at, next.updated_by, next.updated_by_kind, row.id, row.revision),
          ]);
        } catch (err) {
          if (attempt < MAX_WRITE_ATTEMPTS && isChangeTaken(err)) continue;
          throw err;
        }
        return toNote(next);
      }
    },
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id);
      const { results } = await ctx.db
        .prepare(
          `SELECT c.revision, c.base_revision, c.author_kind, c.author_id, COALESCE(p.name, a.name) AS name, a.person_id AS agent_owner, c.created_at
           FROM changes c
           LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
           LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
           WHERE c.note_id = ? ORDER BY c.revision`,
        )
        .bind(op.id)
        .all<{ revision: number; base_revision: number; author_kind: string; author_id: string; name: string | null; agent_owner: string | null; created_at: number }>();
      return results.map(
        (r): ChangeEntry => ({
          revision: r.revision,
          baseRevision: r.base_revision,
          author: authorOf(r.author_kind, r.author_id, r.name, r.agent_owner),
          createdAt: r.created_at,
        }),
      );
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
