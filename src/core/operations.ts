import { ChangeSet } from "@codemirror/state";
import { z } from "zod";
import { newId } from "./ids.ts";
import { Op, OpError, type ChangeEntry, type Note, type OpInput, type OpType, type Results, type Role } from "./protocol.ts";
import { noteSlug, noteTitle } from "./slug.ts";
import { applyChanges, changesBetween } from "./text.ts";

/** Who is performing an operation, in which workspace. */
export type Actor = { kind: "member"; personId: string; workspaceId: string };

interface Context {
  db: D1Database;
  actor: Actor;
  now: number;
}

type Access = "view" | "edit";
const ALLOWS: Record<Role, ReadonlySet<Access>> = {
  admin: new Set(["view", "edit"]),
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

  const member = await db
    .prepare("SELECT role FROM members WHERE workspace_id = ? AND person_id = ?")
    .bind(actor.workspaceId, actor.personId)
    .first<{ role: Role }>();
  if (!member) throw new OpError("not_found", "No such workspace");
  if (!ALLOWS[member.role].has(handler.needs)) throw new OpError("forbidden", `A ${member.role} can't ${op.type}`);

  return handler.run({ db, actor, now }, op as never) as Promise<Results[T["type"]]>;
}

interface NoteRow {
  id: string;
  folder_id: string;
  revision: number;
  text: string;
  title: string;
  updated_at: number;
}

const toNote = (row: NoteRow, text = row.text, revision = row.revision): Note => {
  const title = text === row.text ? row.title : noteTitle(text);
  return { id: row.id, title, slug: noteSlug(title), folderId: row.folder_id, revision, updatedAt: row.updated_at, text };
};

async function loadNote(ctx: Context, id: string): Promise<NoteRow> {
  const row = await ctx.db
    .prepare("SELECT id, folder_id, revision, text, title, updated_at FROM notes WHERE id = ? AND workspace_id = ?")
    .bind(id, ctx.actor.workspaceId)
    .first<NoteRow>();
  if (!row) throw new OpError("not_found", "No such note");
  return row;
}

/** The note's text at `revision`, and the changes after it composed into one. */
async function replay(ctx: Context, id: string, revision: number): Promise<{ text: string; since: ChangeSet }> {
  const { results } = await ctx.db.prepare("SELECT revision, diff FROM changes WHERE note_id = ? ORDER BY revision").bind(id).all<{ revision: number; diff: string }>();
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
    .bind(noteId, revision, baseRevision, ctx.actor.kind, ctx.actor.personId, JSON.stringify(changes.toJSON()), ctx.now, writeId);

const HANDLERS: { [K in OpType]: Handler<K> } = {
  "note.list": {
    needs: "view",
    async run(ctx) {
      const { results } = await ctx.db
        .prepare("SELECT id, folder_id, revision, text, title, updated_at FROM notes WHERE workspace_id = ? ORDER BY updated_at DESC")
        .bind(ctx.actor.workspaceId)
        .all<NoteRow>();
      return results.map((row) => {
        const { text: _, ...summary } = toNote(row);
        return summary;
      });
    },
  },

  "note.create": {
    needs: "edit",
    async run(ctx, op) {
      const workspace = await ctx.db.prepare("SELECT unsorted_folder_id FROM workspaces WHERE id = ?").bind(ctx.actor.workspaceId).first<{ unsorted_folder_id: string }>();
      if (!workspace) throw new OpError("not_found", "No such workspace");
      const id = newId();
      const revision = op.text ? 1 : 0;
      const row: NoteRow = { id, folder_id: workspace.unsorted_folder_id, revision, text: op.text, title: noteTitle(op.text), updated_at: ctx.now };
      const insertNote = ctx.db
        .prepare("INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, ctx.actor.workspaceId, row.folder_id, revision, row.text, row.title, ctx.now, ctx.now);
      await ctx.db.batch(op.text ? [insertNote, insertChange(ctx, id, 1, 0, changesBetween("", op.text))] : [insertNote]);
      return toNote(row);
    },
  },

  "note.read": {
    needs: "view",
    async run(ctx, op) {
      const row = await loadNote(ctx, op.id);
      if (op.revision === undefined || op.revision === row.revision) return toNote(row);
      if (op.revision > row.revision) throw new OpError("not_found", `The note has no revision ${op.revision}`);
      return toNote(row, (await replay(ctx, op.id, op.revision)).text, op.revision);
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
          const base = await replay(ctx, row.id, op.baseRevision);
          // At a tie, the stale write's insertion goes first: it stays next to the text it was typed after.
          changes = changesBetween(base.text, op.text).map(base.since, true);
        }
        if (changes.empty) return toNote(row);

        const revision = row.revision + 1;
        const text = applyChanges(changes, row.text);
        const title = noteTitle(text);
        try {
          await ctx.db.batch([
            insertChange(ctx, row.id, revision, op.baseRevision, changes, op.writeId),
            ctx.db.prepare("UPDATE notes SET revision = ?, text = ?, title = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(revision, text, title, ctx.now, row.id, row.revision),
          ]);
        } catch (err) {
          if (attempt < MAX_WRITE_ATTEMPTS && isChangeTaken(err)) continue;
          throw err;
        }
        return toNote({ ...row, revision, text, title, updated_at: ctx.now });
      }
    },
  },

  "note.history": {
    needs: "view",
    async run(ctx, op) {
      await loadNote(ctx, op.id);
      const { results } = await ctx.db
        .prepare(
          `SELECT c.revision, c.base_revision, c.author_id, p.name, c.created_at
           FROM changes c LEFT JOIN people p ON p.id = c.author_id
           WHERE c.note_id = ? ORDER BY c.revision`,
        )
        .bind(op.id)
        .all<{ revision: number; base_revision: number; author_id: string; name: string | null; created_at: number }>();
      return results.map(
        (r): ChangeEntry => ({
          revision: r.revision,
          baseRevision: r.base_revision,
          author: { kind: "member", personId: r.author_id, name: r.name ?? "Someone" },
          createdAt: r.created_at,
        }),
      );
    },
  },
};
