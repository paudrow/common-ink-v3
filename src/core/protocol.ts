import { z } from "zod";
import { isDay } from "./todos.ts";

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

/** An email as a person signs in with it: trimmed and in lower case, and otherwise as written. */
const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "not an email address");
const RoleName = z.enum(["admin", "editor", "viewer"]);
const GrantAccess = z.enum(["view", "edit"]);
const LinkKind = z.enum(["public", "signed_in"]);
/** What a grant is on: one note or one folder, so exactly one of the two. The operation checks that. */
const On = { noteId: Id.optional(), folderId: Id.optional() };

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

/** A calendar date, such as 2026-10-14. Whose day it is, is the asker's to say: the server never works out today. */
const Day = z.string().refine(isDay, "not a date written YYYY-MM-DD");
const ImportanceLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

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
   * Makes what is derived from the notes' text again, for every note in the workspace: which notes
   * link to which, and the index of todos and tags. Nothing needs it while every write
   * keeps them, so it is for a record that was changed some other way. It covers so many notes a
   * call: while the answer's `done` is false, ask again. It is the same operation as todos.rebuild.
   */
  z.object({ type: z.literal("links.rebuild") }),
  /**
   * The todos in the notes the asker can see: open ones, or done ones too with `includeCompleted`.
   * Open ones come first, then by due date with those that have none last, then the most important.
   * `dueFrom` and `dueTo` are days, both included, and leave out todos with no due date; `noDue`
   * lists only those. `importance` lists the levels wanted, 0 for normal to 3. `tag` matches ignoring
   * case, and is a tag of the todo's note: one written on the todo's own line, or anywhere else in the
   * note. `folderId` lists the todos of the notes in that folder and in every folder under it; one the
   * asker can't see is no folder. Pass the answer's `next` as `offset` for the page after. A field it
   * doesn't know is refused, so a filter it no longer has, such as a project, is never read as no filter.
   */
  z.object({
    type: z.literal("todo.list"),
    folderId: Id.optional(),
    tag: z.string().min(1).max(100).optional(),
    dueFrom: Day.optional(),
    dueTo: Day.optional(),
    noDue: z.boolean().optional(),
    importance: z.array(ImportanceLevel).min(1).max(4).optional(),
    includeCompleted: z.boolean().default(false),
    noteId: Id.optional(),
    limit: z.number().int().min(1).max(200).default(100),
    offset: z.number().int().min(0).default(0),
  }).strict(),
  /** What todo.list can be narrowed by, besides the folders of folder.list: the tags of the notes that have todos, in notes the asker can see. */
  z.object({ type: z.literal("todo.filters") }),
  /**
   * Changes one todo by rewriting its line, as a change to its note by whoever asks. `revision`,
   * `line` and `text` are the todo as todo.list gave it: the line it was on at that revision of its
   * note, and what the line said. The line is followed through every change recorded since, so it is
   * found wherever it has moved to, and no other line is ever taken for it, however alike. Refused as
   * a conflict when the line itself was changed or deleted since. The same call made again changes
   * nothing more. What is left out stays as written.
   */
  z.object({
    type: z.literal("todo.set"),
    id: Id,
    revision: Revision,
    line: z.number().int().min(0),
    text: z.string().max(MAX_NOTE_LENGTH),
    done: z.boolean().optional(),
    importance: ImportanceLevel.optional(),
    due: Day.nullable().optional(),
  }).strict(),
  /** The same operation as links.rebuild, under the name of the other record it makes again. */
  z.object({ type: z.literal("todos.rebuild") }),
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
  /** Everyone in the workspace, by name and role. Any member may ask. Only an admin is told emails, and no agent is. */
  z.object({ type: z.literal("member.list") }),
  /**
   * Offers `as`, a role, to whoever signs in with `email`. They become a member the next time they
   * sign in or open Common Ink. Inviting an email again changes the role offered, and inviting
   * someone who is already a member changes their role.
   */
  z.object({ type: z.literal("member.invite"), email: Email, as: RoleName }),
  /** Gives the member `memberId`, a person's id from member.list, the role `as`. */
  z.object({ type: z.literal("member.setRole"), memberId: Id, as: RoleName }),
  /** Takes a member out of the workspace. What they wrote stays, under their name. */
  z.object({ type: z.literal("member.remove"), memberId: Id }),
  /** Takes whoever asks out of the workspace. */
  z.object({ type: z.literal("member.leave") }),
  /** The invites nobody has taken up yet. */
  z.object({ type: z.literal("invite.list") }),
  /** Takes back an invite nobody has taken up. */
  z.object({ type: z.literal("invite.revoke"), id: Id }),
  /**
   * How a note or a folder is shared: the grants on it, the grants on the folders above that cover
   * it, its link, and for a note whether it is private. Anyone who can see the item may ask, and is
   * told the grants only if they may share it. With neither a note nor a folder, every grant in the
   * workspace, for an admin.
   */
  z.object({ type: z.literal("grant.list"), ...On }),
  /**
   * Gives whoever signs in with `email` view or edit on a note or a folder, or changes what they
   * have. Someone who isn't a member becomes a guest, who sees that and nothing else. Naming a
   * member only narrows what their role allows there, which an admin does; on a private note of
   * one's own it lets that member in.
   */
  z.object({ type: z.literal("grant.set"), ...On, email: Email, access: GrantAccess }),
  /**
   * Sets the link on a note or a folder: `public` opens for anyone who has it, `signed_in` for
   * anyone signed in to Common Ink who has it, and null takes the link away, which stops it at once.
   * A link only ever lets its holder read.
   */
  z.object({ type: z.literal("grant.link"), ...On, link: LinkKind.nullable() }),
  /** Takes a grant or a link away. */
  z.object({ type: z.literal("grant.revoke"), id: Id }),
  /**
   * Makes a note private, which hides it from every other member, admins too, or stops it being so.
   * Only the member who made the note can make it private, and they are then its owner. Every grant
   * and link on the note that someone else made is taken away as it becomes private.
   */
  z.object({ type: z.literal("note.setPrivate"), id: Id, private: z.boolean() }),
  /** What the link the visitor holds is on: a note, or a folder with the folders and notes in it. */
  z.object({ type: z.literal("shared.open") }),
  /** One note the visitor's link covers. */
  z.object({ type: z.literal("shared.read"), id: Id }),
]);
export type Op = z.output<typeof Op>;
export type OpInput = z.input<typeof Op>;
export type OpType = Op["type"];

export type Role = z.output<typeof RoleName>;
export type GrantAccess = z.output<typeof GrantAccess>;
export type LinkKind = z.output<typeof LinkKind>;
/** What a person is in a workspace: a member with a role, or a guest, who is in it only by a grant. */
export type Standing = Role | "guest";

export interface Member {
  personId: string;
  name: string;
  role: Role;
  /** Told to an admin of the workspace, signed in, and to nobody else: not an editor, a viewer, or anyone's agent. */
  email?: string;
}

/** An invite nobody has taken up yet. */
export interface Invite {
  /** What the link an admin shares ends in: `/invite/<id>`. It lets in only the person with `email`. */
  id: string;
  email: string;
  role: Role;
  invitedBy: { personId: string; name: string };
  createdAt: number;
}

export interface NoteSummary {
  id: string;
  title: string;
  slug: string;
  /** Null when the one asking can't see the folder the note is in, as a guest given only the note can't. */
  folderId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Who changed the text last, or who created the note when it was never written. */
  updatedBy: Author;
  snippet: string;
  openTodos: number;
  /** What the one asking may do with the note. A note they can't see is never listed. */
  access: GrantAccess;
  /** Whether the note is private: hidden from every member but its owner and whoever the owner let in. */
  private: boolean;
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

/** A todo as a listing gives it. `revision`, `line` and `text` are what todo.set finds it by. */
export interface ListedTodo {
  noteId: string;
  noteTitle: string;
  /** The revision its note was at when it was listed. */
  revision: number;
  /** Which line of the note it is, counted from 0. */
  line: number;
  /** The line as the note writes it. */
  text: string;
  done: boolean;
  /** 0 for normal, and 1 to 3 for `!`, `!!` and `!!!`. */
  importance: 0 | 1 | 2 | 3;
  /** A calendar date, YYYY-MM-DD, or null. */
  due: string | null;
  /** The tags of the note it is in. The ones written on its own line are those `text` has. */
  tags: string[];
  /** The line without its list mark, checkbox, importance and due date. */
  words: string;
  /** What the one asking may do with its note. With edit, todo.set changes it. */
  access: GrantAccess;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

/** A grant as someone who may share its item is told of it. */
export interface Grant {
  id: string;
  on: { kind: "note" | "folder"; id: string; name: string };
  access: GrantAccess;
  to:
    | {
        kind: "person";
        /** Kept from anyone but an admin and whoever made the grant, once a person has taken the grant up. */
        email: string | null;
        /** Null until someone signs in with the email. */
        personId: string | null;
        name: string | null;
        /** Their role when they are a member, whom the grant narrows. Null for a guest. */
        role: Role | null;
      }
    /** `token` is what the link's address ends in: `/s/<token>`. */
    | { kind: "link"; link: LinkKind; token: string };
  grantedBy: { personId: string; name: string };
  createdAt: number;
}

export interface Sharing {
  /** Whether the one asking may change any of this. When they can't, `grants` and `inherited` are empty. */
  canShare: boolean;
  /** The grants on the item itself, people first. */
  grants: Grant[];
  /** The grants on the folders above the item, nearest first. They cover it unless a grant on it says otherwise. */
  inherited: Grant[];
  /** Null for a folder, and for the whole workspace. */
  note: {
    private: boolean;
    /** Whose it is while it is private. */
    owner: { personId: string; name: string } | null;
    /** Whether the one asking may make it private, or stop it being so. */
    canSetPrivate: boolean;
    /** Set for a note that stopped being private when its owner was removed from the workspace. */
    released: { from: string; by: string; at: number } | null;
  } | null;
}

/** A note as whoever holds a link reads it. It names nobody. */
export interface SharedNote {
  id: string;
  title: string;
  slug: string;
  /** Null for the note a link is on, and for a note right in the folder a link is on. */
  folderId: string | null;
  updatedAt: number;
  snippet: string;
}

export interface Shared {
  link: LinkKind;
  on: { kind: "note"; id: string } | { kind: "folder"; id: string; name: string };
  /** The folders inside a shared folder, each with the folder it is in, or null right inside the shared one. */
  folders: Folder[];
  notes: SharedNote[];
}

export interface ListedFolder extends Folder {
  /** Notes directly in this folder that the one asking can see, not in its children. */
  noteCount: number;
  /** What the one asking may do with the folder: with edit, make notes and folders in it. */
  access: GrantAccess;
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

/**
 * How far a rebuild got. It covers notes the one asking can't see too, so it says nothing of how
 * many notes there were or which: only whether to ask again.
 */
export interface Rebuilt {
  done: boolean;
}

export interface Results {
  "note.list": NoteSummary[];
  "note.create": Note;
  "note.read": ReadNote;
  "note.write": Note;
  "note.backlinks": NoteSummary[];
  "links.rebuild": Rebuilt;
  /** `next` is the `offset` of the page after, or null on the last. */
  "todo.list": { todos: ListedTodo[]; next: number | null };
  /** Each name once, ignoring case, as a note writes it. */
  "todo.filters": { tags: string[] };
  "todo.set": Note;
  "todos.rebuild": Rebuilt;
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
  /** `unsortedId` is null for a guest, who can't see Unsorted unless it was shared with them. */
  "folder.list": { unsortedId: string | null; folders: ListedFolder[] };
  "folder.create": Folder;
  "folder.rename": Folder;
  "folder.delete": { id: string };
  "settings.read": StoredSettings;
  "settings.write": StoredSettings;
  "member.list": Member[];
  /** `member` when the email was already a member's, whose role this changed. Otherwise `invite`. */
  "member.invite": { member: Member; invite: null } | { member: null; invite: Invite };
  "member.setRole": Member;
  "member.remove": { memberId: string };
  "member.leave": { memberId: string };
  "invite.list": Invite[];
  "invite.revoke": { id: string };
  "grant.list": Sharing;
  "grant.set": Grant;
  "grant.link": Grant | null;
  "grant.revoke": { id: string };
  /** `removed` is how many grants and links other people had put on the note, which went as it became private. */
  "note.setPrivate": { id: string; private: boolean; removed: number };
  "shared.open": Shared;
  "shared.read": SharedNote & { text: string; revision: number; links: LinkedNote[] };
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
  /**
   * The folders this token is limited to, in its one workspace: it reaches them, the folders under
   * them, and the notes in those, and nothing else is there for it. Null for every note its member
   * can reach. A folder deleted since is still listed, and stands for nothing.
   */
  folderIds: string[] | null;
}

export const MAX_AGENT_FOLDERS = 50;
/** The folders to limit an agent to. Each stands for itself and the folders under it. */
const FolderLimit = z.array(Id).min(1, "Name at least one folder, or leave folders out for all notes").max(MAX_AGENT_FOLDERS);

/** What a member may ask for when connecting an agent. */
/** How long a token lasts from when it is set, in days, or "never" for one that doesn't expire. */
export const ExpiresIn = z.union([z.number().int().min(1).max(MAX_EXPIRY_DAYS), z.literal("never")]);
export type ExpiresIn = z.infer<typeof ExpiresIn>;

export const ConnectOptions = z.object({
  expiresInDays: ExpiresIn.default(DEFAULT_EXPIRY_DAYS),
  workspaceId: Id.optional(),
  readOnly: z.boolean().default(false),
  /** Limits the agent to these folders of `workspaceId`, which must then be given. Left out, it reaches all notes. */
  folderIds: FolderLimit.optional(),
});
export type ConnectOptions = z.input<typeof ConnectOptions>;

/**
 * What a member changes about an agent they connected: what its token may do, with the token itself
 * unchanged. A field left out stays as it is. `expiresInDays` counts from the edit, a null
 * `workspaceId` lets the token reach every workspace its member can, and a null `folderIds` lets it
 * reach all notes. Folders are those of the token's one workspace, so an edit that moves a limited
 * token to another workspace names its folders there, or null.
 */
export const AgentEdit = z.strictObject({
  expiresInDays: ExpiresIn.optional(),
  workspaceId: Id.nullable().optional(),
  readOnly: z.boolean().optional(),
  folderIds: FolderLimit.nullable().optional(),
});
export type AgentEdit = z.input<typeof AgentEdit>;

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Standing;
}

export interface Me {
  person: { id: string; email: string; name: string };
  workspaces: WorkspaceSummary[];
}

/** What an operation answers anyone who isn't in the workspace, whether or not there is one. */
export const NO_SUCH_WORKSPACE = "No such workspace";

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
