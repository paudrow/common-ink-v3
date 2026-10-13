import { ChangeSet } from "@codemirror/state";
import { z } from "zod";
import { lineDiff, textDiff } from "./diff.ts";
import { dayIn, rebased, redoTarget, revertedBy, revertible, reverting, runsOf, settledRevert, undoTarget, type Choice, type Resolution, type Reverting, type Step } from "./history.ts";
import { newId } from "./ids.ts";
import { summarize } from "./markdown.ts";
import {
  MAX_NOTE_LENGTH,
  Op,
  OpError,
  type Author,
  type AuthorRef,
  type ChangeEntry,
  type DiffRun,
  type Folder,
  type HistoryEntry,
  type Note,
  type NoteDiff,
  type NoteRevertPreview,
  type NoteSummary,
  type OpInput,
  type OpType,
  type Results,
  type Resolve,
  type RevertedNotes,
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

const kindOf = (by: "people" | "agents" | undefined) => (by === "people" ? "member" : by === "agents" ? "agent" : null);

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
const isChangeTaken = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: changes\./.test(err.message);

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
      ctx.actor.kind,
      authorId(ctx.actor),
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

async function takingBack(ctx: Context, id: string, choose: Choose, resolve?: Resolve): Promise<TakingBack> {
  const row = await loadNote(ctx, id);
  const { results } = await ctx.db.prepare(`SELECT ${RECORDED_COLUMNS} WHERE c.note_id = ? AND c.revision <= ? ORDER BY c.revision`).bind(row.id, row.revision).all<RecordedRow>();
  return takingBackOf(row, results.map(toRecorded), choose, resolve);
}

/** The notes named, each with its changes up to the revision it was read at, in two reads however many they are. A note that isn't in the workspace is left out. */
async function loadWithHistory(ctx: Context, ids: readonly string[]): Promise<Map<string, { row: NoteRow; history: Recorded[] }>> {
  const named = JSON.stringify(ids);
  const [notes, changes] = await ctx.db.batch<NoteRow & RecordedRow & { note_id: string }>([
    ctx.db.prepare(`SELECT n.text, ${SUMMARY_COLUMNS} WHERE n.workspace_id = ? AND n.id IN (SELECT value FROM json_each(?))`).bind(ctx.actor.workspaceId, named),
    ctx.db
      .prepare(`SELECT ${RECORDED_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ? AND c.note_id IN (SELECT value FROM json_each(?)) ORDER BY c.note_id, c.revision`)
      .bind(ctx.actor.workspaceId, named),
  ]);
  const recorded = Map.groupBy(changes!.results, (r) => r.note_id);
  return new Map(notes!.results.map((row) => [row.id, { row, history: (recorded.get(row.id) ?? []).filter((r) => r.revision <= row.revision).map(toRecorded) }]));
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
  if (settled.changes.newLength > MAX_NOTE_LENGTH) throw new OpError("invalid", `With these choices the note would be over ${MAX_NOTE_LENGTH} characters`);
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

/** Records one change that takes other changes back out of a note. */
function takeBack(ctx: Context, id: string, choose: Choose, resolve?: Resolve): Promise<Note> {
  return settle(async () => {
    const { row, reverts, changes, resolution } = await takingBack(ctx, id, choose, resolve);
    if (!reverts) return toNote(row);
    const next = await record(ctx, row, changes, row.revision, { reverts, resolution });
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
  const choose = item.to !== undefined ? revertTo(item.to) : revertStanding(item.revisions!);
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
      const standing = standingOf(results.map(stepOf));
      return results.map((r) => toEntry(r, standing));
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
      const { row, history, reverts, found, changes } = await takingBack(ctx, op.id, op.to !== undefined ? revertTo(op.to) : revertOf(op.revisions!), op.resolve);
      const conflicts = found.conflicts.map((c) => ({ ...c, later: c.later.map((revision) => ({ revision, author: history[revision - 1]!.named })) }));
      return { revision: row.revision, revisions: reverts?.revisions ?? [], diff: lineDiff(row.text, changes), overlaps: found.overlaps, conflicts };
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
             AND (?5 IS NULL OR c.created_at < ?5)
             AND (?6 IS NULL OR c.author_kind = ?6)`;
      const binds = [ctx.actor.workspaceId, op.noteIds ? JSON.stringify(op.noteIds) : null, op.authors ? JSON.stringify(op.authors) : null, op.from ?? null, op.to ?? null, kindOf(op.by)];
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
             HAVING ?7 IS NULL OR last_at < ?7 OR (last_at = ?7 AND c.note_id < ?8)
             ORDER BY last_at DESC, c.note_id DESC
             LIMIT ?9`,
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
           WHERE ${narrowed} AND c.note_id IN (SELECT value FROM json_each(?7))
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
               AND (?10 IS NULL OR c.author_kind = ?10)
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
           WHERE n.workspace_id = ? ORDER BY name COLLATE NOCASE, c.author_id`,
        )
        .bind(ctx.actor.workspaceId)
        .all<Pick<ChangeRow, "author_kind" | "author_id" | "name" | "agent_owner">>();
      return results.map((r) => authorOf(r.author_kind, r.author_id, r.name, r.agent_owner));
    },
  },

  "history.diff": {
    needs: "view",
    async run(ctx, op) {
      const asked = new Map(op.changes.map((c) => [c.noteId, c.revisions]));
      const named = JSON.stringify([...asked.keys()]);
      const [read, recorded] = await ctx.db.batch<SummaryRow & ChangeRow & { diff: string }>([
        ctx.db.prepare(`SELECT ${SUMMARY_COLUMNS} WHERE n.workspace_id = ? AND n.id IN (SELECT value FROM json_each(?))`).bind(ctx.actor.workspaceId, named),
        ctx.db.prepare(`SELECT c.diff, ${CHANGE_COLUMNS} JOIN notes n ON n.id = c.note_id WHERE n.workspace_id = ? AND c.note_id IN (SELECT value FROM json_each(?)) ORDER BY c.note_id, c.revision`).bind(ctx.actor.workspaceId, named),
      ]);
      const rows = Map.groupBy(recorded!.results, (r) => r.note_id);
      if (read!.results.length < asked.size) throw new OpError("not_found", "No such note");
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
        if (!note) return { noteId: item.noteId, noteTitle: "", revision: 0, ...none, refused: "No such note" };
        try {
          const { row, history, reverts, found, changes } = takingBackItem(note.row, note.history, item);
          const conflicts = found.conflicts.map((c) => ({ ...c, later: c.later.map((revision) => ({ revision, author: history[revision - 1]!.named })) }));
          return {
            ...titled(row),
            revision: row.revision,
            revisions: reverts?.revisions ?? [],
            already: item.revisions ? revertible(history, item.revisions).already : [],
            diff: lineDiff(row.text, changes),
            overlaps: found.overlaps,
            conflicts,
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
          done.skipped.push({ noteId: item.noteId, noteTitle: "", why: "refused", message: "No such note" });
          continue;
        }
        const { row, history } = note;
        const name = row.title || "Untitled";
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
          const next = await record(ctx, row, changes, row.revision, { reverts, resolution });
          // By the title it had: a revert can leave a note with another, or with none.
          if (next) done.reverted.push({ ...titled(row), revision: next.revision, reverted: reverts.revisions });
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
