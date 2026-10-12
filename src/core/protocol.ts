import { z } from "zod";

export const MAX_NOTE_LENGTH = 500_000;

export const Id = z.string().regex(/^[a-z0-9]{12}$/, "not an id");
const Revision = z.number().int().min(0);
/** Line endings as a note keeps them and no half of a character pair: what the database and a recorded change would each make of them differs, and the text stored must be the text its changes replay to. */
const normalized = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
const NoteText = z.string().max(MAX_NOTE_LENGTH).transform(normalized);
const LabelName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^\P{Cc}*$/u, "can't contain control characters");
const Time = z.number().int().min(0);
/** Revisions of one note that a change made, so never 0. */
const Revisions = z.array(Revision.min(1)).min(1).max(500);
/** What becomes of one conflict of a revert: the later edits kept, the lines as they were before, or the lines given (no text is no lines). */
const Choice = z.union([z.literal("keep"), z.literal("back"), z.object({ text: NoteText }).strict()]);
/**
 * How a revert's conflicts are settled: one choice for all of them, or one for each in the order
 * `note.previewRevert` lists them. `at` is the note's revision that preview was worked out at; the
 * revert is refused when the note has changed since.
 */
const Resolve = z.object({ at: Revision, choices: z.union([z.literal("keep"), z.literal("back"), z.array(Choice).max(1000)]) }).strict();
export type Resolve = z.output<typeof Resolve>;
const AuthorRef = z.object({ kind: z.enum(["member", "agent", "plugin"]), id: Id });
export type AuthorRef = z.output<typeof AuthorRef>;

const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\p{Cc}]*$/u, "can't contain / or control characters");

export const Op = z.discriminatedUnion("type", [
  /** `updatedSince` leaves out notes whose text hasn't changed since that time. */
  z.object({ type: z.literal("note.list"), folderId: Id.optional(), updatedSince: Time.optional() }),
  z.object({ type: z.literal("note.create"), text: NoteText.default(""), folderId: Id.optional() }),
  z.object({ type: z.literal("note.read"), id: Id, revision: Revision.optional() }),
  z.object({
    type: z.literal("note.write"),
    id: Id,
    baseRevision: Revision,
    text: NoteText,
    /** Chosen by the writer; a write sent again with the same id is recorded once. */
    writeId: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal("note.history"), id: Id }),
  /** What one change did to its note, as a line diff. */
  z.object({ type: z.literal("note.diff"), id: Id, revision: Revision.min(1) }),
  z.object({ type: z.literal("note.move"), id: Id, folderId: Id }),
  /** Names a revision, or takes its name away when `name` is null. */
  z.object({ type: z.literal("note.label"), id: Id, revision: Revision.min(1), name: LabelName.nullable() }),
  /** Puts the note back to how it was at `revision`, as a new change. */
  z.object({ type: z.literal("note.revert"), id: Id, revision: Revision, resolve: Resolve.optional() }),
  /**
   * Reverts the chosen changes and keeps the rest, as one new change. Reverting a change that was
   * itself a revert, an undo, or a redo has what it reverted stand again.
   */
  z.object({ type: z.literal("note.revertChanges"), id: Id, revisions: Revisions, resolve: Resolve.optional() }),
  /**
   * What a revert would do, with nothing written: of the chosen changes as `note.revertChanges`
   * reverts them, of the note to a revision as `note.revert` does, or of one author's changes
   * to this note as `history.revertAuthor` does. With `resolve`, the diff is of the revert with its
   * conflicts settled that way.
   */
  z
    .object({ type: z.literal("note.previewRevert"), id: Id, revisions: Revisions.optional(), to: Revision.optional(), author: AuthorRef.optional(), resolve: Resolve.optional() })
    .refine(
      (op) => [op.revisions, op.to, op.author].filter((given) => given !== undefined).length === 1,
      "pass one of revisions, the changes to revert, to, the revision to return to, or author, whose changes to revert",
    ),
  /** Takes back the author's own latest change that still stands. */
  z.object({ type: z.literal("note.undo"), id: Id }),
  z.object({ type: z.literal("note.redo"), id: Id }),
  /** The notes that changed, latest change first, each with how many changes it had and the lines they added and removed. */
  z.object({
    type: z.literal("history.summary"),
    noteIds: z.array(Id).min(1).max(200).optional(),
    authors: z.array(AuthorRef).min(1).max(50).optional(),
    /** Only changes made at or after this time, and before `to`, are counted. */
    from: Time.optional(),
    to: Time.optional(),
    /** The `next` of the page before this one. */
    before: z.object({ lastAt: Time, noteId: Id }).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  z.object({
    type: z.literal("history.list"),
    /** One note, several, or every note in the workspace when left out. */
    noteIds: z.array(Id).min(1).max(200).optional(),
    authors: z.array(AuthorRef).min(1).max(50).optional(),
    /** Changes made at or after this time, and before `to`. */
    from: Time.optional(),
    to: Time.optional(),
    /** The `next` of the page before this one. */
    before: z.object({ createdAt: Time, noteId: Id, revision: Revision }).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    diffs: z.boolean().default(true),
  }),
  z.object({ type: z.literal("history.authors") }),
  /**
   * Takes back out every change by one author that still stands, as one new change in each note
   * by whoever asks. It covers a few notes at a time; pass the answer's `next` as `after` for the rest.
   */
  /** `resolve` settles the conflicts of the notes it names, by note id, as `note.previewRevert` with `author` listed them. A note it leaves out keeps every later edit. */
  z.object({ type: z.literal("history.revertAuthor"), author: AuthorRef, noteIds: z.array(Id).min(1).max(200).optional(), after: Id.optional(), resolve: z.record(Id, Resolve).refine((byNote) => Object.keys(byNote).length <= 200, "resolve names at most 200 notes").optional() }),
  z.object({ type: z.literal("folder.list") }),
  z.object({ type: z.literal("folder.create"), name: FolderName, parentId: Id.optional() }),
  z.object({ type: z.literal("folder.rename"), id: Id, name: FolderName }),
  z.object({ type: z.literal("folder.delete"), id: Id }),
]);
export type Op = z.output<typeof Op>;
export type OpInput = z.input<typeof Op>;
export type OpType = Op["type"];

export type Role = "admin" | "editor" | "viewer";

export interface NoteSummary {
  id: string;
  title: string;
  slug: string;
  folderId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Who changed the text last, or who created the note when it was never written. */
  updatedBy: Author;
  snippet: string;
  openTodos: number;
}

export interface Note extends NoteSummary {
  text: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ListedFolder extends Folder {
  /** Notes directly in this folder, not in its children. */
  noteCount: number;
}

export type Author =
  | { kind: "member"; personId: string; name: string }
  /** A connected agent, named as its member named it; `onBehalfOf` is that member. */
  | { kind: "agent"; agentId: string; name: string; onBehalfOf: string };

/** The changes a change reverted. `to` is the revision a revert put the note back to. */
export interface Reverts {
  how: "undo" | "redo" | "revert";
  revisions: number[];
  to?: number;
}

export interface ChangeEntry {
  revision: number;
  baseRevision: number;
  author: Author;
  createdAt: number;
  /** The label on the revision this change made. */
  label: string | null;
  /** Null for an edit. */
  reverts: Reverts | null;
  /** The later change that reverted this one and still stands. */
  revertedBy: number | null;
  /** Lines this change added and removed. */
  added: number;
  removed: number;
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** A run of changed lines with the unchanged lines around it. Line numbers start at 1. */
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface Diff {
  hunks: Hunk[];
  added: number;
  removed: number;
  /** Lines left out of `hunks` because the change is long. */
  omitted: number;
}

export interface RevertPreview {
  /** The note's revision the preview was worked out at. */
  revision: number;
  /** The changes that would be reverted. */
  revisions: number[];
  /** From the note's text as it is to its text after the revert, its conflicts settled as asked: every later edit kept when nothing was asked. */
  diff: Diff;
  /** Later changes that still stand and edited lines the revert changes. */
  overlaps: number[];
  /** Each place those changes edited lines the revert changes, top of the note first. A revert settles each with a choice. */
  conflicts: RevertConflict[];
}

/** Lines are without their line ends. */
export interface RevertConflict {
  /** The line of the note after the revert, with every later edit kept, that `kept` starts at. Counted from 1. */
  line: number;
  /** The lines as they were before the reverted changes, with the later edits to them out too: what "back" leaves. */
  before: string[];
  /** The lines as the note has them now. */
  now: string[];
  /** What "keep" leaves: the revert, and the later edits kept. */
  kept: string[];
  /** The later changes that edited these lines. */
  later: Array<{ revision: number; author: Author }>;
}

export interface HistoryEntry extends ChangeEntry {
  noteId: string;
  noteTitle: string;
  /** Null when the listing was asked for without diffs. */
  diff: Diff | null;
}

export interface HistoryPage {
  /** Newest first. */
  changes: HistoryEntry[];
  /** Pass as `before` for the next page; null on the last. */
  next: { createdAt: number; noteId: string; revision: number } | null;
}

/** A note's changes, counted: all of them, or the ones a listing was narrowed to. */
export interface ChangedNote {
  noteId: string;
  noteTitle: string;
  changes: number;
  /** Lines the changes added and removed, each change counted on its own. */
  added: number;
  removed: number;
  firstAt: number;
  lastAt: number;
  /** Who made them, whoever changed the note latest first. */
  authors: Author[];
}

export interface HistorySummary {
  /** Latest change first. */
  notes: ChangedNote[];
  /** Pass as `before` for the next page; null on the last. */
  next: { lastAt: number; noteId: string } | null;
}

export interface AuthorReverted {
  /** Each note that got a new change, and the author's changes it took back out. */
  reverted: { note: NoteSummary; revisions: number[] }[];
  /** The reverted notes left with no text, each under the title it had. There is no deleting a note yet, so they stay. */
  emptied: { noteId: string; title: string }[];
  /** Notes that refused the change, such as one it would make too long. They are left as they were. */
  failed: { noteId: string; title: string; message: string }[];
  /** Pass as `after` to cover the notes not reached yet; null when every note was. */
  next: string | null;
}

export interface Results {
  "note.list": NoteSummary[];
  "note.create": Note;
  "note.read": Note;
  "note.write": Note;
  "note.history": ChangeEntry[];
  "note.move": Note;
  "note.label": { id: string; revision: number; label: string | null };
  "note.revert": Note;
  "note.revertChanges": Note;
  "note.previewRevert": RevertPreview;
  "note.undo": Note;
  "note.redo": Note;
  "note.diff": Diff;
  "history.summary": HistorySummary;
  "history.list": HistoryPage;
  "history.authors": Author[];
  "history.revertAuthor": AuthorReverted;
  "folder.list": { unsortedId: string; folders: ListedFolder[] };
  "folder.create": Folder;
  "folder.rename": Folder;
  "folder.delete": { id: string };
}

export const MAX_AGENT_NAME = 60;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

export interface Agent {
  id: string;
  name: string;
  /** The first characters of its token, to tell tokens apart. Not enough to use it. */
  tokenPrefix: string;
  createdAt: number;
  /** After this the token stops working. Null when it never expires. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** The one workspace this token can reach, or null for every workspace its member can reach. */
  workspaceId: string | null;
  /** A read-only token can't change anything, whatever its member's role. */
  readOnly: boolean;
}

/** What a member may ask for when connecting an agent. */
/** How long a token lasts from when it is set, in days, or "never" for one that doesn't expire. */
export const ExpiresIn = z.union([z.number().int().min(1).max(MAX_EXPIRY_DAYS), z.literal("never")]);
export type ExpiresIn = z.infer<typeof ExpiresIn>;

export const ConnectOptions = z.object({
  expiresInDays: ExpiresIn.default(DEFAULT_EXPIRY_DAYS),
  workspaceId: Id.optional(),
  readOnly: z.boolean().default(false),
});
export type ConnectOptions = z.input<typeof ConnectOptions>;

/**
 * What a member changes about an agent they connected: what its token may do, with the token itself
 * unchanged. A field left out stays as it is. `expiresInDays` counts from the edit, and a null
 * `workspaceId` lets the token reach every workspace its member can.
 */
export const AgentEdit = z.strictObject({
  expiresInDays: ExpiresIn.optional(),
  workspaceId: Id.nullable().optional(),
  readOnly: z.boolean().optional(),
});
export type AgentEdit = z.input<typeof AgentEdit>;

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  person: { id: string; email: string; name: string };
  workspaces: WorkspaceSummary[];
}

export type OpErrorCode = "invalid" | "not_found" | "forbidden";

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}
