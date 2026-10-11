import { z } from "zod";

export const MAX_NOTE_LENGTH = 500_000;
export const MAX_SETTINGS_LENGTH = 100_000;

export const Id = z.string().regex(/^[a-z0-9]{12}$/, "not an id");
const Revision = z.number().int().min(0);
const NoteText = z.string().max(MAX_NOTE_LENGTH);
const LabelName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^\P{Cc}*$/u, "can't contain control characters");
const Time = z.number().int().min(0);
/** As many revisions as putting back can name at once. It is far past where a note's record is too long to replay. */
const MAX_NOTE_CHANGES_NAMED = 100_000;
/** Revisions of one note that a change made, so never 0. */
const Revisions = z.array(Revision.min(1)).min(1).max(500);
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
  z.object({ type: z.literal("note.move"), id: Id, folderId: Id }),
  /** Names a revision, or takes its name away when `name` is null. */
  z.object({ type: z.literal("note.label"), id: Id, revision: Revision.min(1), name: LabelName.nullable() }),
  /** Puts the note back to how it was at `revision`, as a new change. */
  z.object({ type: z.literal("note.revert"), id: Id, revision: Revision }),
  /** Takes the chosen changes back out and keeps the rest, as one new change. */
  z.object({ type: z.literal("note.revertChanges"), id: Id, revisions: Revisions }),
  /**
   * Puts back chosen changes that were taken out, as one new change. Changes taken out together go
   * back together, so this takes as many as one revert can name, which is every change of a note.
   */
  z.object({ type: z.literal("note.reapplyChanges"), id: Id, revisions: z.array(Revision.min(1)).min(1).max(MAX_NOTE_CHANGES_NAMED) }),
  /** Takes back the author's own latest change that still stands. */
  z.object({ type: z.literal("note.undo"), id: Id }),
  z.object({ type: z.literal("note.redo"), id: Id }),
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
  z.object({ type: z.literal("history.revertAuthor"), author: AuthorRef, noteIds: z.array(Id).min(1).max(200).optional(), after: Id.optional() }),
  z.object({
    type: z.literal("history.activity"),
    /** The IANA zone whose days the changes are counted in, such as "America/Chicago". */
    timeZone: z.string().min(1).max(64),
    /** Whose changes to count; the one asking when left out. */
    author: AuthorRef.optional(),
    from: Time.optional(),
    to: Time.optional(),
  }),
  z.object({ type: z.literal("folder.list") }),
  z.object({ type: z.literal("folder.create"), name: FolderName, parentId: Id.optional() }),
  z.object({ type: z.literal("folder.rename"), id: Id, name: FolderName }),
  z.object({ type: z.literal("folder.delete"), id: Id }),
  /** The settings of whoever asks, in this workspace. Nobody reads another member's. */
  z.object({ type: z.literal("settings.read") }),
  /**
   * Replaces them. `text` is a JSON object; what its keys mean is the app's to say, so an unknown key is kept.
   * `baseRevision` is the revision the writer read, and the write is refused as a conflict when the
   * settings have been written since. `supersedes` names a write of the writer's own that may still be
   * on its way: this one is also taken when that one was the only write since `baseRevision`.
   */
  z.object({
    type: z.literal("settings.write"),
    /** At most MAX_SETTINGS_LENGTH characters, which the operation checks so that it can say so plainly. */
    text: z.string(),
    baseRevision: Revision,
    writeId: z.string().min(1).max(64).optional(),
    supersedes: z.string().min(1).max(64).optional(),
  }),
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

/** The changes a change took back out. `to` is the revision a revert put the note back to. */
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
  /** The later change that took this one back out and still stands. */
  revertedBy: number | null;
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

export interface Activity {
  timeZone: string;
  /** Days with a change, oldest first, each as YYYY-MM-DD in `timeZone`. */
  days: { date: string; count: number }[];
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

/** One member's settings in one workspace, as they wrote them. */
export interface StoredSettings {
  /** A JSON object holding only what differs from the defaults. `{}` until the member changes something. */
  text: string;
  /** How many times they have been written. 0 until the member changes something. */
  revision: number;
  /** Null until the member changes something. */
  updatedAt: number | null;
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
  "note.reapplyChanges": Note;
  "note.undo": Note;
  "note.redo": Note;
  "history.list": HistoryPage;
  "history.authors": Author[];
  "history.revertAuthor": AuthorReverted;
  "history.activity": Activity;
  "folder.list": { unsortedId: string; folders: ListedFolder[] };
  "folder.create": Folder;
  "folder.rename": Folder;
  "folder.delete": { id: string };
  "settings.read": StoredSettings;
  "settings.write": StoredSettings;
}

export const MAX_AGENT_NAME = 60;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

export interface Agent {
  id: string;
  name: string;
  /** Tells this token from the member's other tokens under the same name, e.g. "laptop". */
  label: string | null;
  /** The first characters of its token, to tell tokens apart. Not enough to use it. */
  tokenPrefix: string;
  createdAt: number;
  /** After this the token stops working. */
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** The one workspace this token can reach, or null for every workspace its member can reach. */
  workspaceId: string | null;
  /** A read-only token can't change anything, whatever its member's role. */
  readOnly: boolean;
}

/** What a member may ask for when connecting an agent. */
export const ConnectOptions = z.object({
  label: z.string().trim().max(MAX_AGENT_NAME).optional(),
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).default(DEFAULT_EXPIRY_DAYS),
  workspaceId: Id.optional(),
  readOnly: z.boolean().default(false),
});
export type ConnectOptions = z.input<typeof ConnectOptions>;

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  person: { id: string; email: string; name: string };
  workspaces: WorkspaceSummary[];
}

export type OpErrorCode = "invalid" | "not_found" | "forbidden" | "conflict";

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}
