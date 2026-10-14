import { z } from "zod";

export const MAX_NOTE_LENGTH = 500_000;
export const MAX_SETTINGS_LENGTH = 100_000;

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
/** Whose changes: people's, or agents'. */
const By = z.enum(["people", "agents"]);

/** As many notes as one request reads the changes of or reverts. A larger selection is sent in parts. */
export const MAX_NOTES_AT_ONCE = 40;
const unique = (changes: { noteId: string }[]) => new Set(changes.map((c) => c.noteId)).size === changes.length;
/** Some changes of one note. */
const Selected = z.object({ noteId: Id, revisions: Revisions }).strict();
/**
 * A revert of one note among several: of the chosen changes, of the note to the revision `to`, or
 * of every change of `author` that still stands, as `history.revertAuthor` picks them.
 * Changes already reverted are left out and no reason to refuse. `at` is the note's revision the
 * revert was previewed at: a note that has changed since is skipped and said to be. `choices`
 * settles its conflicts as `resolve` does for one note, and needs `at`.
 */
const Reverted = z
  .object({ noteId: Id, revisions: Revisions.optional(), to: Revision.optional(), author: AuthorRef.optional(), at: Revision.optional(), choices: Resolve.shape.choices.optional() })
  .strict()
  .refine((r) => [r.revisions, r.to, r.author].filter((given) => given !== undefined).length === 1, "pass either revisions, the changes to revert, or to, the revision to return to, or author, whose changes to revert")
  .refine((r) => r.choices === undefined || r.at !== undefined, "choices settle the conflicts of a preview: pass at, the revision that preview was of");
const ManyNotes = <T extends z.ZodType<{ noteId: string }>>(item: T) => z.array(item).min(1).max(MAX_NOTES_AT_ONCE).refine(unique, "name each note once");

const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\p{Cc}]*$/u, "can't contain / or control characters");

/**
 * What a write does with a link written by title, `[[Title]]`, outside code. `resolve` stores it by
 * the id of the one note with that title, ignoring case, and refuses the write when no note the
 * writer can see has it or several do. `keep` leaves the text as written, where it links nothing.
 */
const LinkTitles = z.enum(["resolve", "keep"]).default("resolve");

export const Op = z.discriminatedUnion("type", [
  /** `updatedSince` leaves out notes whose text hasn't changed since that time. */
  z.object({ type: z.literal("note.list"), folderId: Id.optional(), updatedSince: Time.optional() }),
  z.object({ type: z.literal("note.create"), text: NoteText.default(""), folderId: Id.optional(), linkTitles: LinkTitles }),
  /** The note, and for each note its text links to by id, that note's title now. */
  z.object({ type: z.literal("note.read"), id: Id, revision: Revision.optional() }),
  z.object({
    type: z.literal("note.write"),
    id: Id,
    baseRevision: Revision,
    text: NoteText,
    /** Chosen by the writer; a write sent again with the same id is recorded once. */
    writeId: z.string().min(1).max(64).optional(),
    linkTitles: LinkTitles,
  }),
  /** The notes whose text links to this one, latest change first. */
  z.object({ type: z.literal("note.backlinks"), id: Id }),
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
    by: By.optional(),
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
    by: By.optional(),
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
  /**
   * Makes the record of which notes link to which again from the notes' text. Nothing needs it while
   * every write keeps the record, so it is for a record that was changed some other way. It covers
   * some notes a call; pass the answer's `next` as `after` for the rest.
   */
  z.object({ type: z.literal("links.rebuild"), after: Id.optional() }),
  /**
   * What a selection of changes did, note by note: the changes of each note that follow one another
   * are one run with one diff, from the note before the first of them to the note after the last.
   */
  z.object({ type: z.literal("history.diff"), changes: ManyNotes(Selected) }),
  /** What `history.revert` would do to each note, with nothing written. */
  z.object({ type: z.literal("history.previewRevert"), changes: ManyNotes(Reverted) }),
  /**
   * Reverts changes of several notes, each note as one new change. A note is reverted or skipped
   * whole and by itself: the answer names each note of both kinds, and why one was skipped.
   */
  z.object({ type: z.literal("history.revert"), changes: ManyNotes(Reverted) }),
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

/** A note that a note's text links to. */
export interface LinkedNote {
  id: string;
  /** Null when there is no such note or the one asking can't see it. Nothing tells the two apart. */
  title: string | null;
}

export interface ReadNote extends Note {
  /** Each note the text links to by id, once, in the order they first appear. */
  links: LinkedNote[];
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
  /** How many of the changes it reverted were themselves reverts, undos or redos: what those took out stands again. */
  restores: number;
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
  /** How many lines the text had before. */
  lines: number;
}

/** Changes of one note that follow one another, as one: from the note before the first to the note after the last. */
export interface DiffRun {
  from: number;
  to: number;
  /** How many changes it is. */
  saves: number;
  /** Changes of the note between the run before and this one that were not asked for. */
  skipped: number;
  firstAt: number;
  lastAt: number;
  /** Who made them, in the order they first did. */
  authors: Author[];
  /** The label on the revision the run ends at. */
  label: string | null;
  added: number;
  removed: number;
  /** Null when the answer already holds as many lines as one answer does: ask for this note again, alone. */
  diff: Diff | null;
}

export interface NoteDiff {
  noteId: string;
  noteTitle: string;
  /** The note's latest revision. */
  revision: number;
  /** Earliest first. */
  runs: DiffRun[];
  /** Lines its runs added and removed: what the selection came to, so a line written and then taken out counts for nothing within a run. */
  added: number;
  removed: number;
}

export interface SelectionDiff {
  /** The note whose selected changes are the latest first. */
  notes: NoteDiff[];
}

/** What a revert would do to one note of several. */
export interface NoteRevertPreview extends RevertPreview {
  noteId: string;
  noteTitle: string;
  /** Changes asked for that were already reverted, so the revert leaves them be. */
  already: number[];
  /** Why this note's revert can't be made, when it can't: the rest of the preview is then empty, and the other notes' stand. */
  refused?: string;
}

export interface RevertedNote {
  noteId: string;
  noteTitle: string;
  /** The change the revert made: the note's revision now. */
  revision: number;
  /** The changes it reverted. */
  reverted: number[];
}

export interface SkippedNote {
  noteId: string;
  noteTitle: string;
  /** `changed`: the note is no longer at the revision the revert was previewed at. `nothing`: the revert would change nothing. `refused`: it can't be made, for the reason in `message`. */
  why: "changed" | "nothing" | "refused";
  message: string;
}

export interface RevertedNotes {
  reverted: RevertedNote[];
  skipped: SkippedNote[];
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
  /**
   * For a revert of chosen changes, where these lines are in the note as each run of those changes
   * left it, so that the conflict can be shown on the diff of that run: `revision` is the run's
   * last, `line` is counted from 1 in the note at that revision, and no `lines` is the place
   * before that line. Runs are the ones `history.diff` answers with for the same changes.
   */
  runs: Array<{ revision: number; line: number; lines: number }>;
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
  "note.read": ReadNote;
  "note.write": Note;
  "note.backlinks": NoteSummary[];
  "links.rebuild": { notes: number; next: string | null };
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
  "history.diff": SelectionDiff;
  "history.previewRevert": NoteRevertPreview[];
  "history.revert": RevertedNotes;
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

/** How long a token lasts from when it is set, in days, or "never" for one that doesn't expire. */
export const ExpiresIn = z.union([z.number().int().min(1).max(MAX_EXPIRY_DAYS), z.literal("never")]);
export type ExpiresIn = z.infer<typeof ExpiresIn>;

/**
 * What a member may ask for when connecting an agent. Each option narrows the token and its default
 * is the widest, so a key this doesn't know is refused: a misspelt `readOnly` or `workspaceId`
 * left out without a word would mint a token that can do more than was asked for.
 */
export const ConnectOptions = z.strictObject({
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

/** How the server the app is on is set up, where the app follows it. Only the server says it. */
export interface Setup {
  /** Whether HTML embeds are served from a host of their own (`EMBED_ORIGIN`), apart from the app's site. */
  embedSite: boolean;
}

/** What `/api/me` answers: who is signed in, and how the server is set up. */
export interface MeHere extends Me {
  setup: Setup;
}

export type OpErrorCode = "invalid" | "not_found" | "forbidden" | "conflict";

/** What a client is told of a fault that is no request's doing. The fault's own words stay in the server's log: they can name tables and rows. */
export const BROKE = "Common Ink broke while doing that. Nothing says it was done: try again";

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}
