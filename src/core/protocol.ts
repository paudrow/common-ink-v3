import { z } from "zod";
import type { UploadKind } from "./filetypes.ts";
import type { NoteState } from "./lifecycle.ts";
import { readableName } from "./mentions.ts";
import { OWN_SANDBOXED_IDS } from "./ownPlugins.ts";
import { CAPABILITY_NAMES, HTML_EMBEDS, MAX_PLUGIN_CODE, MAX_PLUGIN_MANIFEST, Origins, type Draft, type DraftSummary, type PluginRecord, type Validated } from "./plugins.ts";
import { parseRule } from "./recurrence.ts";
import { dayIn } from "./history.ts";
import { MAX_SEARCH_LENGTH, type SortKey } from "./query.ts";
import { TODO_STATES, isDay, isTagName, type LastDone, type TodoState } from "./todos.ts";

export { MAX_SEARCH_LENGTH };

export const MAX_NOTE_LENGTH = 500_000;
/** The longest a tag's description can be. */
export const MAX_TAG_DESCRIPTION = 500;
export const MAX_SETTINGS_LENGTH = 100_000;

export const Id = z.string().regex(/^[a-z0-9]{12}$/, "not an id");
const Revision = z.number().int().min(0);
/**
 * Line endings as a note keeps them and no half of a character pair: what the database and a recorded change would each make of them differs, and the text stored must be the text its changes replay to.
 * No control character but tab and newline either: each is six characters once a change is written as JSON, so a note of them would make a change past what D1 keeps in one value.
 */
const normalized = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000B-\u001F]/g, "\uFFFD");
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
/** Chosen by the writer; an operation sent again with the same id takes effect once. */
const WriteId = z.string().min(1).max(64).optional();
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
/** What a grant is on: one note, one folder or one upload, so exactly one of the three. The operation checks that. */
const On = { noteId: Id.optional(), folderId: Id.optional(), uploadId: Id.optional() };

export { MAX_UPLOAD_BYTES, PART_BYTES } from "./parts.ts";

/** The most bytes of uploads in one part of an export, and the most uploads: what one request reads well inside a Worker's time and its calls to the bucket. A larger upload is a part alone. */
export const EXPORT_PART_BYTES = 2 ** 30;
export const EXPORT_PART_FILES = 300;
/** Where an upload is in the order an export's parts take them: when it was made, then its id. */
const ExportPlace = z.string().regex(/^\d{1,16}\.[a-z0-9]{12}$/, "not a place in an export");
/** The most bytes `upload_file` takes from an agent as base64 in one tool call. A larger file goes in parts. */
export const MAX_INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;
/** A file's name as it was given. What is kept of it is its last part, cleaned: see `cleanName`. */
const FileName = z.string().min(1).max(1000);

/** What a permission is of: a plugin installed in the workspace, or HTML embeds. */
const PluginSubject = z.union([Id, z.literal(HTML_EMBEDS)]);
const CapabilityName = z.enum(CAPABILITY_NAMES);
/** A plugin whose source a member may copy: one installed in the workspace, or one of Common Ink's own that runs shut off. */
const Drafted = z.union([Id, z.enum(OWN_SANDBOXED_IDS)]);
const CodeHash = z.string().regex(/^[0-9a-f]{64}$/);

const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\p{Cc}]*$/u, "can't contain / or control characters");

/**
 * What a write does with a link written by title, `[[Title]]`, outside code. `resolve` stores it by
 * the id of the one note with that title, ignoring case, and leaves it as written when no note the
 * writer can see has it or several do: the write names those in `unresolved`. `resolve-strict`
 * refuses the write for them instead. `keep` leaves every link as written, where it links nothing.
 */
const LinkTitles = z.enum(["resolve", "resolve-strict", "keep"]).default("resolve");
export type LinkTitles = z.output<typeof LinkTitles>;

/** What folder.create does when the parent has a folder of that name, ignoring case: answer with it, or refuse. */
const IfExists = z.enum(["return", "error"]).default("error");

/**
 * What a write does with a mention it introduces, `@[[Name]]` or `@[[id]]`, outside code. `resolve`
 * stores a mention of the one member with that name, ignoring case, by their id, as
 * `@[[id|Name]]`, and refuses the write when several members have the name. A name no member has is
 * left as written: a mention of someone by name, who is told nothing and given nothing. `keep`
 * leaves every mention as written. A writer who isn't a member is never told who is one, so theirs
 * are kept.
 */
const MentionNames = z.enum(["resolve", "keep"]).default("resolve");
/**
 * The tags, with or without the `#`, an agent's write may bring in though no note the agent can see has
 * them: the new tags its member asked for, matched ignoring case. An agent's write that brings in
 * any other tag no such note has is refused, so an agent reuses the workspace's tags. A person's
 * write and a plugin's are never refused for a tag.
 */
const NewTags = z.array(z.string().min(1).max(100).transform((name) => name.replace(/^#/, ""))).max(50).optional();
/** A member's id, or the name of anyone else as a mention writes it. */
const Person = z
  .string()
  .max(200)
  .regex(/^[^[\]|\n]*$/, "can't contain brackets, | or a line break")
  .transform(readableName)
  .refine((name) => name.length > 0, "is no name: nothing in it shows");

/** A calendar date, such as 2026-10-14. Whose day it is, is the asker's to say: the server never works out today. */
const Day = z.string().refine(isDay, "not a date written YYYY-MM-DD");
/** A time zone by its name, such as Europe/Paris. */
const Zone = z
  .string()
  .max(64)
  .refine((zone) => {
    try {
      dayIn(zone);
      return true;
    } catch {
      return false;
    }
  }, "not a time zone, such as Europe/Paris");
/**
 * What a query's days are read by. `today` is the day it is for the asker, which `today`, `yesterday`,
 * `tomorrow`, `7d` and `+7d` are counted from: the server never works it out, so a query with one of
 * them and no `today` is refused. `zone` is where a day begins and ends for `updated:` and `created:`.
 * Left out, it is the member's zone: the one their `daily.timeZone` setting names, or else the one of
 * the browser they last used Common Ink in, or else UTC.
 */
const Days = { today: Day.optional(), zone: Zone.optional() };
/** How a todo recurs, as it is written after `every:`, such as `2w`, `mon,thu`, `3d-after-done`, `last-fri`, `mar-1` or `1m-times-5`. docs/todos.md has every rule. */
const Recurrence = z.string().max(1000).refine((rule) => parseRule(rule) !== null, "not a way to repeat, such as 2w, mon,thu, 3d-after-done, last-fri, mar-1 or 1m-times-5");
/** The orders todo.list can list todos in. */
export const TODO_SORTS = ["due", "priority", "changed", "note", "text"] as const;
export type TodoSort = (typeof TODO_SORTS)[number];
/** The `sort:` word of a query that says each order: the query's `sort:` and `sort` are one choice. */
export const TODO_SORT_WORDS: Record<TodoSort, SortKey> = { due: "due-asc", priority: "priority-desc", changed: "updated-desc", note: "title-asc", text: "text-asc" };

const ImportanceLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
/**
 * Whether a listing also covers archived notes, which it leaves out unless asked. Nothing but
 * trash.list covers a note in Trash.
 */
const IncludeArchived = z.boolean().default(false);
/** For a listing of notes that can also be asked for the archived ones alone, with `"only"`. */
const Archived = z.union([z.boolean(), z.literal("only")]).default(false);
/**
 * Where a page of a list starts: the `next` the page before gave, made from that page's last row.
 * The rows after it are the ones that come after that row in the list's order now, so a row that
 * moves in the order between pages, as a note changed meanwhile does, may be listed twice or not at
 * all, and one added where the pages have already been is not listed. Every other row is listed once.
 * It holds the values the list is ordered by, which can be a long heading.
 */
const After = z.string().min(1).max(20_000).optional();
/** How many rows a page holds: `most` keeps one answer small enough to send and read. */
const Limit = (byDefault: number, most: number) => z.number().int().min(1).max(most).default(byDefault);
/** The orders a search answers in. `match` is notes whose title matches first, then the latest changed. */
export const SEARCH_SORTS = ["match", "recent", "created", "title"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
/** A data source's id, such as `google-calendar`. */
const SourceId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "not a data source's id");
/** A record's id as its data source gave it. It is passed back to that data source and read as nothing else. */
const RecordId = z.string().min(1).max(1024);
/** What one line of a contact's says: an email, a phone number, an address, a page. */
const LineValue = (max: number) => z.string().trim().min(1).max(max);
/** A line of a contact's with its label: Google's own type, one the member wrote, or none. */
const Labelled = <V extends z.ZodString>(value: V) => z.object({ value, type: z.string().trim().min(1).max(100).nullable().default(null) });
/** A birthday as YYYY-MM-DD, or --MM-DD when the year isn't known, on a day the month has. */
const Birthday = z
  .string()
  .regex(/^(\d{4}|-)-(\d{2})-(\d{2})$/, "a birthday is YYYY-MM-DD, or --MM-DD without the year")
  .refine((day) => {
    const [, year, month, date] = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(day)!;
    const last = new Date(Date.UTC(year === "-" ? 2024 : Number(year), Number(month), 0)).getUTCDate();
    return Number(month) >= 1 && Number(month) <= 12 && Number(date) >= 1 && Number(date) <= last;
  }, "not a day of the year");
/** What a contact's page can change of them. Each is the whole of that field: a list given is the list it becomes, and null takes it away. */
const ContactFields = {
  name: z.string().trim().min(1).max(500),
  emails: z.array(Labelled(LineValue(320).regex(/^[^\s@]+@[^\s@]+$/, "not an email address"))).max(20),
  phones: z.array(Labelled(LineValue(100).regex(/^[\d\s()+.\-/*#,;ext]+$/i, "not a phone number"))).max(20),
  organization: LineValue(500).nullable(),
  title: LineValue(500).nullable(),
  addresses: z.array(Labelled(LineValue(1000))).max(10),
  birthday: Birthday.nullable(),
  urls: z.array(Labelled(LineValue(2000).regex(/^https?:\/\/[^\s]+$/, "a website starts https:// or http://"))).max(20),
  notes: z.string().max(8000).nullable(),
};
/** A picture as its bytes in base64: a JPEG or a PNG, up to half a megabyte. */
const Photo = z
  .string()
  .max(700_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64")
  .refine((b64) => b64.startsWith("/9j/") || b64.startsWith("iVBORw0KGgo"), "a picture is a JPEG or a PNG");
/**
 * When an event is. An all-day event is on calendar dates, `from` its first day and `to` its last,
 * with no time and no zone. Any other is between two instants.
 */
/** An event's instant: up to the last a Date can hold, so a data source can always write it as a date. */
const EventTime = Time.max(8_640_000_000_000_000);
const EventWhen = z
  .union([z.object({ allDay: z.literal(true), from: Day, to: Day }), z.object({ allDay: z.literal(false), from: EventTime, to: EventTime })])
  .refine((when) => when.from <= when.to, "an event can't end before it starts");
export type EventWhen = z.output<typeof EventWhen>;

export const Op = z.discriminatedUnion("type", [
  /**
   * `updatedSince` leaves out notes that haven't changed since that time: neither their text, nor
   * their state, as by being unarchived or restored. A note that left the listing since, by being
   * archived or trashed, is not in it to be told of: ask with `includeArchived`, and trash.list.
   * `folderId` lists the notes in that folder. A folder the asker can't see lists nothing, and the
   * note is still in the list with no folder. `tag` lists only the notes with that tag, ignoring case.
   * `includeArchived: "only"` lists the archived notes and no live one. The latest changed come first. Pass the answer's
   * `next` as `after` for the page after.
   */
  z.object({ type: z.literal("note.list"), folderId: Id.optional(), updatedSince: Time.optional(), tag: z.string().min(1).max(100).optional(), includeArchived: Archived, limit: Limit(200, 1000), after: After }),
  z.object({
    type: z.literal("note.create"),
    text: NoteText.default(""),
    folderId: Id.optional(),
    linkTitles: LinkTitles,
    mentionNames: MentionNames,
    newTags: NewTags,
    /** Chosen by the writer. A create sent again with the same id returns the note from the first time. */
    writeId: z.string().min(1).max(64).optional(),
  }),
  /** The note, and for each note its text links to by id, that note's title now. A note in Trash is read as any other, and its `state` says where it is. */
  z.object({ type: z.literal("note.read"), id: Id, revision: Revision.optional() }),
  z.object({
    type: z.literal("note.write"),
    id: Id,
    baseRevision: Revision,
    text: NoteText,
    /** Chosen by the writer; a write sent again with the same id is recorded once. */
    writeId: z.string().min(1).max(64).optional(),
    linkTitles: LinkTitles,
    mentionNames: MentionNames,
    newTags: NewTags,
    /**
     * The day it is for the writer, which counts when the write checks off a recurring todo: the todo
     * is completed on that day, as todo.set does it. Left out, it is today in the member's zone, as
     * `memberZone` picks it.
     */
    on: Day.optional(),
  }),
  /**
   * Replaces lines of the note at `baseRevision` and leaves the rest. Each edit includes `from`
   * and stops before `to`, counted from 0 in that revision: `from` equal to `to` inserts, and an
   * empty `text` deletes. Every range is counted in that revision, so one edit does not shift
   * another. The result is merged with edits made since, as note.write merges a whole note.
   */
  z.object({
    type: z.literal("note.edit"),
    id: Id,
    baseRevision: Revision,
    edits: z
      .array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0), text: NoteText }))
      .min(1)
      .max(50),
    /** Chosen by the writer; an edit sent again with the same id is recorded once. */
    writeId: z.string().min(1).max(64).optional(),
    linkTitles: LinkTitles,
    mentionNames: MentionNames,
    newTags: NewTags,
    on: Day.optional(),
  }),
  /** The notes whose text links to this one, latest change first. */
  z.object({ type: z.literal("note.backlinks"), id: Id }),
  z.object({ type: z.literal("note.history"), id: Id }),
  /** What one change did to its note, as a line diff. */
  z.object({ type: z.literal("note.diff"), id: Id, revision: Revision.min(1) }),
  /** Who wrote each line of the note as it is now: the change that last wrote or edited it. */
  z.object({ type: z.literal("note.blame"), id: Id }),
  z.object({ type: z.literal("note.move"), id: Id, folderId: Id }),
  /**
   * Archives a note, or with `archived` false brings it back. An archived note keeps its folder, id
   * and links, opens and is changed as before, and is left out of every listing that isn't asked to
   * include archived notes. Done twice, it changes nothing more.
   */
  z.object({ type: z.literal("note.archive"), id: Id, archived: z.boolean() }),
  /**
   * Moves a note to Trash, where it waits 30 days and is then removed with its history. Until then
   * it is listed only by trash.list, opens to be read, can't be changed, and any link on it opens
   * nothing. note.restore brings it back.
   */
  z.object({ type: z.literal("note.trash"), id: Id }),
  /**
   * Brings a note back from Trash to the folder it was in, archived if it was. When that folder was
   * deleted meanwhile it comes back to Unsorted, and the answer's `folderGone` says so.
   */
  z.object({ type: z.literal("note.restore"), id: Id }),
  /** Removes a note in Trash now, with its history, instead of after its 30 days. Nothing brings it back. */
  z.object({ type: z.literal("note.purge"), id: Id }),
  z.object({ type: z.literal("note.discard"), id: Id }),
  /** The notes in Trash that the asker can see, latest trashed first. Pass the answer's `next` as `after` for the page after. */
  z.object({ type: z.literal("trash.list"), limit: Limit(100, 500), after: After }),
  /**
   * The tags of the notes the asker can see, by name, each with how many of those notes have it and
   * its description. A member who sees the whole workspace is also given each tag that is described,
   * or was made in Settings, and that none of those notes has, with 0 notes. `name` lists that one
   * tag alone, ignoring case. Pass the answer's `next` as `after` for the page after.
   */
  z.object({ type: z.literal("tag.list"), name: z.string().min(1).max(100).optional(), includeArchived: IncludeArchived, limit: Limit(200, 1000), after: After }),
  /**
   * Says when to use a tag, for everyone who tags a note to choose by: tag.list answers it beside the
   * tag. It is kept by the tag's name ignoring case, whether or not a note has the tag now, so it is
   * there again when one does, and a tag no note has yet is listed by it: making a tag ahead in
   * Settings describes it with nothing. An empty description takes it away, and keeps a tag no note
   * has. Null forgets a tag no note has: its description goes, and it is listed no more. A tag a
   * note has is left as it is, and it is refused while notes are still being indexed.
   */
  z.object({
    type: z.literal("tag.describe"),
    name: z
      .string()
      .max(100)
      .transform((name) => name.replace(/^#/, ""))
      .refine(isTagName, "not a tag's name: letters, digits, _, / and -, with something besides digits"),
    description: z.string().trim().max(MAX_TAG_DESCRIPTION).nullable(),
  }),
  /**
   * The notes the asker can see that `query` finds, written in the query language of docs/search.md:
   * words, each matching the start of a word in the note, ignoring case and accents; "a phrase"; filters
   * such as `folder:`, `tag:` or `#name`, `updated:`, `editor:`, `is:`, `has:`; `-` and `NOT`, `OR`, and
   * parentheses. A query that can't be read is refused as invalid, saying where and why, and so is a
   * `folder:` or an `editor:` that names nothing the asker can see. A query with no words and no filter
   * finds nothing. Notes whose title matches come first, then the latest changed, unless the query's
   * `sort:` or else `sort` asks for another order. Archived notes are left out unless the query says
   * `is:archived`, and notes in Trash unless it says `is:trashed`.
   *
   * The fields beside `query` are from before it could say them, and narrow it further: `folderId` to
   * the notes in one folder, not those of the folders inside it, where a folder the asker can't see is
   * no such folder; `hasTodos` to notes with an open todo; `includeArchived` to cover archived notes
   * too, or with `"only"` them alone. Pass the answer's `next` as `after` for more.
   */
  z.object({
    type: z.literal("search"),
    query: z.string().max(MAX_SEARCH_LENGTH),
    folderId: Id.optional(),
    includeArchived: Archived,
    hasTodos: z.boolean().default(false),
    sort: z.enum(SEARCH_SORTS).default("match"),
    ...Days,
    limit: Limit(20, 50),
    after: After,
  }),
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
    /** Leaves out the changes by these authors, such as the asker's own. */
    notAuthors: z.array(AuthorRef).min(1).max(50).optional(),
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
  z.object({ type: z.literal("history.revertAuthor"), author: AuthorRef, noteIds: z.array(Id).min(1).max(200).optional(), after: Id.optional(), /** Moves each note the revert left with no text to Trash, such as one the author created. */ trashEmptied: z.boolean().default(false), resolve: z.record(Id, Resolve).refine((byNote) => Object.keys(byNote).length <= 200, "resolve names at most 200 notes").optional() }),
  /**
   * Makes what is derived from the notes' text again, for every note in the workspace: which notes
   * link to which, and the index of todos and tags. Nothing needs it while every write
   * keeps them, so it is for a record that was changed some other way. It covers so many notes a
   * call: while the answer's `done` is false, ask again. It is the same operation as todos.rebuild.
   */
  z.object({ type: z.literal("links.rebuild") }),
  /**
   * The todos in the notes the asker can see that `query` finds, in the same language as search's:
   * words are looked for in the todo's own line, and `is:done`, `due:`, `priority:`, `has:due` and
   * `has:repeat` are of the todo. With no query it is every open todo. A query that names no state
   * lists only open ones; `is:done`, `is:abandoned` and `is:backlog` list those, and `is:open OR
   * is:backlog` both. Open ones come first, then by due date with those that have none last, then
   * the most important, unless the query's `sort:` says otherwise.
   *
   * The fields beside `query` are from before it could say them, and narrow it further. `dueFrom` and
   * `dueTo` are days, both included, and leave out todos with no due date; `noDue` lists only those.
   * `importance` lists the priority levels wanted, 0 for None to 3 for High. `tag` matches ignoring case, and is a tag
   * of the todo's note: one written on the todo's own line, or anywhere else in the note. `assignee`
   * is `assignee:` of the query: a member's id, or anyone else's name, ignoring case. `assignedToMe`
   * is `assignee:@me`: the asker, or the member an agent acts for. `folderId`
   * lists the todos of the notes in that folder and in every folder under it; one the asker can't see
   * is no folder. Pass the answer's `next` as `after` for the page after. A field it doesn't know is
   * refused, so a filter it no longer has, such as a project, is never read as no filter.
   * `includeCompleted` lists done ones beside the open ones, when the query names no state.
   * `sort` orders the open ones, and the rest after them, another way: `priority` the highest
   * first, then by due date; `changed` those whose note changed last first; `note` by their note's
   * title; `text` by their words, A to Z. Ties go by note and line. A `sort:` in the query wins over it
   * (`TODO_SORT_WORDS` names the word for each).
   */
  z.object({
    type: z.literal("todo.list"),
    query: z.string().max(MAX_SEARCH_LENGTH).default(""),
    ...Days,
    folderId: Id.optional(),
    tag: z.string().min(1).max(100).optional(),
    dueFrom: Day.optional(),
    dueTo: Day.optional(),
    noDue: z.boolean().optional(),
    importance: z.array(ImportanceLevel).min(1).max(4).optional(),
    assignee: Person.optional(),
    assignedToMe: z.boolean().optional(),
    includeCompleted: z.boolean().default(false),
    includeArchived: IncludeArchived,
    noteId: Id.optional(),
    sort: z.enum(TODO_SORTS).default("due"),
    limit: Limit(100, 200),
    after: After,
  }).strict(),
  /** What todo.list can be narrowed by, besides the folders of folder.list: the tags of the notes that have todos, and who todos are assigned to, in notes the asker can see. */
  z.object({ type: z.literal("todo.filters"), includeArchived: IncludeArchived }),
  /**
   * Changes one todo by rewriting its line, as a change to its note by whoever asks. `revision`,
   * `line` and `text` are the todo as todo.list gave it: the line it was on at that revision of its
   * note, and what the line said. The line is followed through every change recorded since, so it is
   * found wherever it has moved to, and no other line is ever taken for it, however alike. Refused as
   * a conflict when the line itself was changed or deleted since. The same call made again changes
   * nothing more. What is left out stays as written, and only `words` moves a token: the due date,
   * the rule and who it is assigned to go after them.
   *
   * `state` writes its box: `done` checks it off, and `open`, `abandoned` and `backlog` are their
   * marks, `[ ]`, `[-]` and `[>]`, and nothing else. `done` is the older way to say it: true is the
   * state done, and false alone is open. With a state, done must say whether that state is done.
   *
   * `every` sets how it recurs, or with null stops it recurring. Checking off a todo that recurs
   * leaves it open with its next due date and a mark of when it was last done and how many times,
   * and files the checked line on the daily note of whoever asks, or of the member an agent acts
   * for. `on` is the day that happens on, as it is for note.write. A rule that ends after so many
   * times has one fewer left, and its last time, or the last before the day it runs until, checks
   * the todo off for good.
   *
   * `skip` moves a recurring todo's due date to its next one with nothing checked off, recorded or
   * filed. It counts as one of a rule's times. It is refused for a todo that doesn't recur, for the
   * last time of a rule that ends, for one that isn't open, and together with the state done.
   *
   * `assign` assigns it to a person by writing a mention of them on the line: a member's id, or a
   * name. A name one member has is theirs, as it is for a mention note.write introduces, and a name
   * no member has is written as a name. `unassign` takes it from a member's id or name, or from
   * anyone else's name, and is refused when the listed line isn't assigned to them.
   */
  z.object({
    type: z.literal("todo.set"),
    id: Id,
    revision: Revision,
    line: z.number().int().min(0),
    text: z.string().max(MAX_NOTE_LENGTH),
    state: z.enum(TODO_STATES).optional(),
    done: z.boolean().optional(),
    importance: ImportanceLevel.optional(),
    due: Day.nullable().optional(),
    every: Recurrence.nullable().optional(),
    assign: Person.optional(),
    unassign: Person.optional(),
    skip: z.boolean().optional(),
    on: Day.optional(),
    /** What the todo says instead: its words and tags, as todo.list's `words`, on one line. */
    words: z.string().max(MAX_NOTE_LENGTH).regex(/^[^\r\n]*$/, "A todo's words are one line").optional(),
    newTags: NewTags,
  }).strict(),
  /**
   * Each time a recurring todo was checked off: the day, and who did it, latest first. `revision`,
   * `line` and `text` are the todo as todo.list gave it, and it is found as todo.set finds it. A
   * completion that was undone is left out, and so is one made before the todo's line was cut out
   * of its note and put back.
   */
  z.object({ type: z.literal("todo.history"), id: Id, revision: Revision, line: z.number().int().min(0), text: z.string().max(MAX_NOTE_LENGTH) }),
  /**
   * The daily note of whoever asks, or of the member an agent acts for, for the day `on`: found, or
   * made with the date as its heading, in the folder their settings pick or else in Daily at the top
   * of the workspace, which is made too if it isn't there. Left out, `on` is today in their zone, as
   * `memberZone` picks it.
   */
  z.object({ type: z.literal("daily.open"), on: Day.optional() }),
  /**
   * The daily note for the day `on` of whoever asks, or of the member an agent acts for, when there
   * is one: nothing is made. `on` is read as daily.open reads it.
   */
  z.object({ type: z.literal("daily.find"), on: Day.optional() }),
  /**
   * The notes whoever asks has pinned to their dashboard, or the member an agent acts for, earliest
   * pinned first: those they can see now that are live, and with `includeArchived` the archived ones
   * too, which are pinned still and off the dashboard until unarchived. A pin on a note they can't
   * see, or one in Trash, is not listed and is there again when the note is. A pin is theirs alone
   * and is not in the note.
   */
  z.object({ type: z.literal("pin.list"), includeArchived: IncludeArchived }),
  /**
   * Pins a note to the dashboard of whoever asks, or of the member an agent acts for, or with
   * `pinned` false takes the pin away. Nobody else is told, and the note doesn't change. Done twice,
   * it changes nothing more.
   */
  z.object({ type: z.literal("pin.set"), id: Id, pinned: z.boolean() }),
  /**
   * How far whoever asks has read the changes their dashboard sums up, or the member an agent acts
   * for. `readUntil` is the time they last marked them read up to, or null when they never have.
   * `now` is the server's time, which is what visit.mark is handed. The changes since are
   * history.list's, from `readUntil`.
   */
  z.object({ type: z.literal("visit.read") }),
  /**
   * Says the member has read the changes made before `until`, which is the `now` of the visit.read
   * the summary they were shown was made from. It only moves forward: an earlier time than the one
   * kept, as from a tab left open, changes nothing, and a time yet to come is read as now.
   */
  z.object({ type: z.literal("visit.mark"), until: Time.min(1) }),
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
  z.object({ type: z.literal("folder.create"), name: FolderName, parentId: Id.optional(), ifExists: IfExists }),
  /** The folder at a path such as `Projects/Skills`, from the top of what the asker can see, ignoring case and then accents. */
  z.object({ type: z.literal("folder.find"), path: z.string().max(1000) }),
  z.object({ type: z.literal("folder.rename"), id: Id, name: FolderName }),
  /** Puts a folder inside another, or at the top with a null `parentId`. What is in it goes with it. */
  z.object({ type: z.literal("folder.move"), id: Id, parentId: Id.nullable() }),
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
  /**
   * Keeps the time zone of the browser the member is using, which is theirs in every workspace and is
   * the one the server takes their day and times in when nobody says them and their settings name none.
   * Keeping the zone already kept changes nothing.
   */
  z.object({ type: z.literal("timeZone.record"), timeZone: Zone }),
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
  /**
   * Signs `memberId` out of every browser they are signed in on. Anyone may ask it of themself, and an
   * admin of any member. With `agents`, the default, it disconnects their agents too: every one of
   * their own, or a member's that reach this workspace.
   */
  z.object({ type: z.literal("member.signOut"), memberId: Id, agents: z.boolean().default(true) }),
  /** The invites nobody has taken up yet. */
  z.object({ type: z.literal("invite.list") }),
  /** Takes back an invite nobody has taken up. */
  z.object({ type: z.literal("invite.revoke"), id: Id }),
  /** What deleting the asker's own account would do: the workspaces they are alone in, deleted with it, and those it waits on, where they are the only admin and others are members. */
  z.object({ type: z.literal("account.read") }),
  /**
   * Deletes the asker's own account, once `confirm` is their email. What they wrote in workspaces
   * they share stays, under "A former member", and everything else of theirs goes.
   */
  z.object({ type: z.literal("account.delete"), confirm: z.string().max(400) }),
  /** Deletes the workspace and everything in it, for an admin, once `confirm` is its name. */
  z.object({ type: z.literal("workspace.delete"), confirm: z.string().max(400) }),
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
   * one's own it lets that member in. A member can be named by `memberId` in place of `email`,
   * since only an admin is told a member's email. The grant then keeps the email from whoever made it.
   */
  z.object({ type: z.literal("grant.set"), ...On, email: Email.optional(), memberId: Id.optional(), access: GrantAccess }),
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
  /** The bytes of one upload the visitor's link covers: one in the folder the link is on, or in a folder inside it. A link on a note covers no upload. */
  z.object({ type: z.literal("shared.upload"), id: Id }),
  /**
   * Puts a file in a folder, or in Unsorted, in one request. The bytes come with the request and not
   * in the operation: over HTTP as the body of `POST /api/workspaces/<id>/uploads`, which docs/mcp.md
   * describes. `size` is how many bytes are coming, at most PART_BYTES, which is as much as one
   * request carries, and a body of any other length is refused. A larger file is sent in parts:
   * `upload.start`. What the file is served as is decided from its name's ending and its first bytes.
   * `private` makes it private to the member who uploads it, as a private note is. Sent again with the
   * same `writeId`, it answers the upload the first made and stores nothing more.
   */
  z.object({ type: z.literal("upload.create"), name: FileName, size: z.number().int().min(1), folderId: Id.optional(), private: z.boolean().default(false), writeId: WriteId }),
  /**
   * Begins a file of `size` bytes, at most MAX_UPLOAD_BYTES, sent in parts of PART_BYTES. The upload
   * is pending, and no one sees it, until `upload.finish`. The answer says how the file is cut and
   * gives an address each part is sent to, once, over HTTP (`upload.part`), which lapses in an hour.
   * Sent again with the same `writeId` while the upload is being sent, it answers as `upload.resume` does.
   */
  z.object({ type: z.literal("upload.start"), name: FileName, size: z.number().int().min(1), folderId: Id.optional(), private: z.boolean().default(false), writeId: WriteId }),
  /** Which parts of an upload being sent are stored, and a fresh address for the rest. Only whoever started it can ask. */
  z.object({ type: z.literal("upload.resume"), id: Id }),
  /**
   * Stores one part of an upload being sent. Its bytes are the body of `PUT` at the address
   * `upload.start` or `upload.resume` gave, and the address says which upload; it is refused without one.
   */
  z.object({ type: z.literal("upload.part"), id: Id, number: z.number().int().min(1) }),
  /** Puts the parts of an upload together once every one is stored, checks it is the size it was said to be, and makes it live. Done again, it answers the upload. */
  z.object({ type: z.literal("upload.finish"), id: Id }),
  /** Stops an upload being sent and throws away the parts it has. */
  z.object({ type: z.literal("upload.abort"), id: Id }),
  /** How many bytes the workspace's uploads take, for its members. There is no limit to it. */
  z.object({ type: z.literal("upload.storage") }),
  /**
   * The uploads the asker can see that `query` finds, in the query language (docs/search.md), latest
   * first: with no query, every live one. `folderId` narrows to one folder's own uploads and
   * `includeArchived` covers archived ones too, as `is:archived` does. Pass the answer's `next` as
   * `after` for the page after.
   */
  z.object({ type: z.literal("upload.list"), query: z.string().max(MAX_SEARCH_LENGTH).default(""), ...Days, folderId: Id.optional(), includeArchived: IncludeArchived, limit: Limit(100, 500), after: After }),
  /** One upload, and the notes the asker can see that refer to it. */
  z.object({ type: z.literal("upload.read"), id: Id }),
  /** The bytes of one upload. Over HTTP it is `GET /api/workspaces/<id>/uploads/<upload id>`. */
  z.object({ type: z.literal("upload.open"), id: Id }),
  z.object({ type: z.literal("upload.move"), id: Id, folderId: Id }),
  /**
   * What putting an upload in a note asks of it, before its embed is written there. An upload that is
   * private to the asker, theirs alone, goes to the note's folder and stops being private, so whoever
   * reads the note sees it. In a private note it stays theirs. Any other upload is left as it is.
   */
  z.object({ type: z.literal("upload.place"), id: Id, noteId: Id }),
  /** Archives an upload, or brings it back, as note.archive does a note. Notes that refer to it still show it. */
  z.object({ type: z.literal("upload.archive"), id: Id, archived: z.boolean() }),
  /**
   * Moves an upload to Trash, where it waits 30 days and is then removed with its bytes. Notes that
   * refer to it say it is in Trash until it is restored, and after it is removed read as they would
   * for an upload that never was.
   */
  z.object({ type: z.literal("upload.trash"), id: Id }),
  z.object({ type: z.literal("upload.restore"), id: Id }),
  /** Removes an upload in Trash now, with its bytes, instead of after its 30 days. Nothing brings it back. */
  z.object({ type: z.literal("upload.purge"), id: Id }),
  /** The uploads in Trash that the asker can see, latest trashed first. */
  z.object({ type: z.literal("upload.trashed") }),
  /** Makes an upload private to the member who uploaded it, or stops it being so, as note.setPrivate does a note. */
  z.object({ type: z.literal("upload.setPrivate"), id: Id, private: z.boolean() }),
  /**
   * The parts of an export of the workspace: the live and archived notes and uploads the asker can
   * see, as Markdown and files in their folders, in zips of at most `partBytes` of uploads and
   * `partFiles` uploads each. Each part has the address of its bytes.
   */
  z.object({ type: z.literal("export.plan"), partBytes: z.number().int().min(1).max(EXPORT_PART_BYTES).optional(), partFiles: z.number().int().min(1).max(EXPORT_PART_FILES).optional() }),
  /**
   * The bytes of one part of an export, a zip: with `notes`, the folders, the notes and the index of
   * every id; and the uploads after `after` up to `through`. Over HTTP it is the address export.plan gives.
   */
  z.object({ type: z.literal("export.open"), notes: z.boolean().default(false), after: ExportPlace.optional(), through: ExportPlace.optional() }),
  /**
   * The data sources of whoever asks, each with whether it is connected and whether it takes changes.
   * A data source is a person's own. Every operation on one answers for the person asking and nobody
   * else, whatever their role in the workspace it was asked in.
   */
  z.object({ type: z.literal("source.list") }),
  /**
   * Connects a data source. `redirect`, when there is one, is where the member's browser goes to
   * agree to it, and `back` is the path in Common Ink it returns to. `edit` asks to change it as well
   * as read it, where that is agreed to apart, as Google's contacts are.
   */
  z.object({ type: z.literal("source.connect"), id: SourceId, back: z.string().max(1000).default("/"), edit: z.boolean().default(false) }),
  /** Disconnects a data source, and every other one that came through the same account: they were agreed to as one. */
  z.object({ type: z.literal("source.disconnect"), id: SourceId }),
  /**
   * The asker's events in a span of time, soonest first, each occurrence of a recurring event on its
   * own. An all-day event is in the span when one of its days is one of the days the span covers in
   * `timeZone`, the asker's.
   */
  z.object({ type: z.literal("event.list"), from: Time, to: Time, timeZone: z.string().min(1).max(64) }),
  /**
   * Changes an event where it is kept, as the member whose it is. `etag` is the event's as it was
   * read: the change is refused when the event has changed there since. A read-only data source
   * refuses, and so does an event in a calendar the member can only read. Only the fields given change.
   */
  z.object({
    type: z.literal("event.update"),
    sourceId: SourceId,
    id: RecordId,
    etag: z.string().min(1).max(200),
    title: z.string().max(1000).optional(),
    location: z.string().max(1000).optional(),
    description: z.string().max(8000).optional(),
    when: EventWhen.optional(),
  }),
  /**
   * Adds an event to one of the asker's calendars where it is kept, as the member whose it is.
   * `calendarId` is one of the `calendars` `event.list` answers. A read-only data source refuses, and
   * so does a calendar the member can only read. With neither `sourceId` nor `calendarId` it goes in
   * the member's default calendar, as `defaultCalendar` in sources.ts chooses it.
   */
  z.object({
    type: z.literal("event.create"),
    sourceId: SourceId.optional(),
    calendarId: RecordId.optional(),
    title: z.string().max(1000),
    when: EventWhen,
    location: z.string().max(1000).optional(),
    description: z.string().max(8000).optional(),
  }),
  /** The asker's contacts by name. `query` keeps those with every word of it at the start of a word of their name, email or organization. */
  z.object({ type: z.literal("contact.list"), query: z.string().max(100).optional() }),
  /**
   * Changes one of the asker's contacts where it is kept, as the member whose it is: only the fields
   * given, each as a whole. `etag` is the contact's as it was read: the change is refused when the
   * contact has changed there since. A data source that is read-only refuses.
   */
  z.object({ type: z.literal("contact.update"), sourceId: SourceId, id: RecordId, etag: z.string().min(1).max(200), ...z.object(ContactFields).partial().shape }),
  /** Puts a picture on one of the asker's contacts where it is kept, in place of the one it had, or with null takes its own off. */
  z.object({ type: z.literal("contact.photo"), sourceId: SourceId, id: RecordId, photo: Photo.nullable() }),
  /** Adds a contact to the asker's own contacts where they are kept: a name, and whatever else is known of them. */
  z.object({ type: z.literal("contact.create"), sourceId: SourceId, ...z.object(ContactFields).partial().shape, name: ContactFields.name }),
  /**
   * A person, as a mention names them, as the asker may be told of them: what their page shows. `who`
   * is a member's id, or a name. A name one member has is that member, for an asker told who the
   * members are. The member they are, only for such an asker. The asker's own contacts that are them,
   * matched by name or by the member's email, with all those contacts hold, and nobody else's. The
   * open todos assigned to them, and each line that mentions them, in the notes the asker can see,
   * the note changed latest first, `limit` of them.
   */
  z.object({ type: z.literal("person.read"), who: Person, limit: z.number().int().min(1).max(200).default(50) }),
  /**
   * What a note writes to reference an event or a contact: `ref`, an id that says nothing of the
   * record, and `text`, the embed that carries it. Asked again of the same record it answers the same.
   */
  z.object({ type: z.literal("record.refer"), sourceId: SourceId, id: RecordId }),
  /** The event or contact a reference stands for, as it is now. A reference someone else made reads as none at all. */
  z.object({ type: z.literal("record.read"), ref: Id }),
  /**
   * The notes that reference one of the asker's records with the asker's own reference, and for an
   * event their calendar has now, another member's reference to the same event, among the notes they
   * can see and not in Trash, latest change first. A note they can't see is left out, title and all.
   * Each says who sees it: only its owner, the people it is shared with, or the workspace.
   */
  z.object({ type: z.literal("record.notes"), sourceId: SourceId, id: RecordId }),
  /**
   * The workspace's plugins: each one installed, what it declares, and what it is permitted. Every
   * member reads it and only an admin changes it. It is no part of anyone's settings.
   */
  z.object({ type: z.literal("plugin.list") }),
  /** An installed plugin's code, which the app runs shut off from itself. */
  z.object({ type: z.literal("plugin.read"), id: Id }),
  /**
   * Installs a plugin from its manifest, as JSON, and its code. Only an admin does. Nothing is
   * permitted by installing. With `replaces` it takes the place of an installed plugin and keeps its
   * id: what was permitted stands only where neither the code nor that capability's declaration changed.
   */
  z.object({ type: z.literal("plugin.install"), manifest: z.string().min(2).max(MAX_PLUGIN_MANIFEST), code: z.string().max(MAX_PLUGIN_CODE), replaces: Id.optional() }),
  /** Takes a plugin out of the workspace, and with it everything it was permitted and every request for it. Only an admin does. */
  z.object({ type: z.literal("plugin.uninstall"), id: Id }),
  /**
   * An admin's decision on one permission, for the whole workspace. It answers every request for it.
   * `locked` keeps it as decided: it takes no requests, and is changed only once an admin has
   * unlocked it. `origins` are the sites, for HTML embeds' network alone; a plugin's are its manifest's.
   * `codeHash` is the plugin's code as the admin read it, and allowing a plugin anything needs it:
   * the decision is refused when the plugin has been replaced since, so nobody allows code they
   * haven't been shown. HTML embeds have no code, and turning a permission off needs none.
   */
  z.object({
    type: z.literal("plugin.permit"),
    id: PluginSubject,
    capability: CapabilityName,
    allowed: z.boolean(),
    locked: z.boolean().optional(),
    origins: Origins.optional(),
    codeHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /** A member who isn't an admin saying yes: it allows nothing, and waits for an admin. `origins` as for plugin.permit. */
  z.object({ type: z.literal("plugin.request"), id: PluginSubject, capability: CapabilityName, origins: Origins.optional() }),
  /**
   * What admins' agents have asked to do to the workspace's plugins. An admin is told every request
   * still waiting; an agent is told its own, waiting or answered; anyone else is told none.
   */
  z.object({ type: z.literal("plugin.proposals") }),
  /** An admin answering an agent's request: approving does what it asked, as the admin, and declining does nothing. */
  z.object({ type: z.literal("plugin.decide"), id: Id, approve: z.boolean() }),
  /** A new plugin's two files to start from: a manifest named `name`, and code that runs shut off and does one small thing. Nothing is kept. */
  z.object({ type: z.literal("plugin.scaffold"), name: z.string().min(1).max(60) }),
  /** What installing a manifest and code would make of them, without installing or keeping anything: the manifest as it would be kept and what it asks for, or why it would be refused. */
  z.object({ type: z.literal("plugin.validate"), manifest: z.string().max(MAX_PLUGIN_MANIFEST), code: z.string().max(MAX_PLUGIN_CODE) }),
  /**
   * What a frame of the plugin's, or of an HTML embed, is opened with when its network is allowed:
   * a token, good once and for a minute, for the address that answers with those sites let through.
   * `token` is null when its network isn't allowed.
   */
  z.object({ type: z.literal("plugin.frame"), id: z.union([PluginSubject, z.enum(OWN_SANDBOXED_IDS)]) }),
  /**
   * A member turning a plugin that asks for full trust on for themself, or off. Such a plugin runs
   * inside the app, in the session of each member who turned it on and nobody else's, and only while
   * an admin's grant of that exact code stands. `codeHash` is the code the member was shown. Nothing
   * here names a person: it is for whoever asks, signed in, and for nobody else.
   */
  z.object({ type: z.literal("plugin.trust"), id: Id, on: z.boolean(), codeHash: CodeHash.optional() }).refine((op) => !op.on || op.codeHash !== undefined, "Say which code you are turning on: codeHash, as plugin.list answers it"),
  /**
   * The asker's own copies of plugins' source. A draft is kept beside its author's settings and is
   * theirs alone: no operation reads or changes another member's, an admin's included, and none takes
   * a person. It is no note, so it is in no folder, search or history.
   */
  z.object({ type: z.literal("draft.list") }),
  z.object({ type: z.literal("draft.read"), id: Drafted }),
  /**
   * Keeps the asker's draft of a plugin as it is now. `baseHash` is the original's code when the
   * copy was made. With `running` it runs in the original's place for its author alone, shut off
   * from the app, with what the original is permitted and never more.
   */
  z.object({ type: z.literal("draft.save"), id: Drafted, manifest: z.string().max(MAX_PLUGIN_MANIFEST), code: z.string().max(MAX_PLUGIN_CODE), baseHash: CodeHash.nullable().optional(), running: z.boolean() }),
  z.object({ type: z.literal("draft.discard"), id: Drafted }),
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
  /** Where the note is in its life: live, archived, or trashed. */
  state: NoteState;
  /** For a note in Trash, when it is removed for good. Null otherwise. */
  purgesAt: number | null;
  /** When its state last changed, or null for a note that has only ever been live. */
  stateAt: number | null;
}

/** A note in Trash. */
export interface TrashedNote extends NoteSummary {
  trashedAt: number;
  trashedBy: Author;
}

/** A line of a note that a search matched. */
export interface SearchMatch {
  /** Which line of the note, counted from 0. */
  line: number;
  /** The line as the note writes it, or the part of a long line around the first match. Markdown, not HTML. */
  text: string;
  /** Where in `text` the matches are, each as [from, to]. */
  marks: [number, number][];
}

export interface SearchResult {
  note: NoteSummary;
  /** The first few lines that matched. Empty when only the note's tag did, or the match can't be shown on one line. */
  matches: SearchMatch[];
}

export interface ListedTag {
  /** The tag as a note writes it, without the #. */
  name: string;
  /** How many notes the asker can see have it. */
  notes: number;
  /** When to use it, as tag.describe last said. Left out when nobody has. */
  description?: string;
}

export interface Note extends NoteSummary {
  text: string;
}

/** A note that a note's text links to. */
export interface LinkedNote {
  id: string;
  /** Null when there is no such note or the one asking can't see it. Nothing tells the two apart, and a note removed from Trash is no such note. */
  title: string | null;
  /** Where the linked note is in its life, so a link can say it is in Trash. Null with a null title. */
  state: NoteState | null;
}

/**
 * Someone a note mentions, or a todo is assigned to. `id` is the person's id when the mention names
 * one, and null for a name alone. `member` says they are a member of the workspace now, and `name`
 * is then their name now. Otherwise, and always for an asker who isn't a member themself, `name` is
 * the name as the note writes it, and nothing else is told of them.
 */
export interface Mentioned {
  id: string | null;
  name: string;
  member: boolean;
}

export interface ReadNote extends Note {
  /** Each note the text links to by id, once, in the order they first appear. */
  links: LinkedNote[];
  /** Each person the text mentions, once, in the order they first appear. */
  mentions: Mentioned[];
  /** Each upload the text refers to, once, in the order they first appear. */
  uploads: ReferredUpload[];
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
  /** What its box says: open, done, abandoned or backlog. */
  state: TodoState;
  /** 0 for normal, and 1 to 3 for `!`, `!!` and `!!!`. */
  importance: 0 | 1 | 2 | 3;
  /** A calendar date, YYYY-MM-DD, or null. */
  due: string | null;
  /** How it recurs, as written after `every:`, or null. */
  every: string | null;
  /** That rule as a chip says it, such as "every 2 weeks on Mon · 5 left", or null. */
  recurs: string | null;
  /** When it was last checked off and how many times, for a todo that recurs and has been. */
  lastDone: LastDone | null;
  /** When its line was ticked and by whom: the change that last made it done. Null for a todo that isn't done. */
  completed: Ticking | null;
  /** The tags of the note it is in. The ones written on its own line are those `text` has. */
  tags: string[];
  /** The note's tags written on its other lines, which stay with the note whatever this line becomes. */
  tagsElsewhere: string[];
  /** Who it is assigned to: each person mentioned on its line. */
  assignees: Mentioned[];
  /** The line without its list mark, checkbox, importance, due date and assignees. */
  words: string;
  /** What the one asking may do with its note. With edit, todo.set changes it. */
  access: GrantAccess;
}

/** What a change that checked off recurring todos filed, and where. */
export interface Filed {
  /** The day the todos were completed on. */
  on: string;
  /** The daily note the checked lines went on. Null when the one completing can't have one here: a guest, or a member who can't write in their daily folder. */
  dailyNoteId: string | null;
  todos: number;
}

/** A note after a change to its text. `filed` is there when the change checked off a recurring todo. */
export interface Written extends Note {
  filed?: Filed;
  /**
   * There when the change took completions back out, or put them back: how many filed lines were
   * taken off daily notes, how many were left because the line had been edited or deleted since, and
   * the daily notes that changed, those the one asking can see.
   */
  unfiled?: { removed: number; left: number; dailyNoteIds: string[] };
}

/** One time a recurring todo was checked off. */
export interface Completion {
  /** The day it was done, as whoever did it said it was. */
  on: string;
  at: number;
  by: Author;
  /** The daily note it was filed on, when the one asking can see it. */
  dailyNoteId: string | null;
}

/** The change that ticked a todo's line: when it was made and who made it. */
export type Ticking = Pick<Completion, "at" | "by">;

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

/** A file in a workspace. Its name is for showing, and is in no address. */
export interface Upload {
  id: string;
  name: string;
  /** What its bytes are served as. */
  type: string;
  kind: UploadKind;
  size: number;
  /** For an image whose size its bytes say. */
  width: number | null;
  height: number | null;
  /** Null when the one asking can't see the folder it is in. */
  folderId: string | null;
  createdAt: number;
  uploadedBy: Author;
  access: GrantAccess;
  private: boolean;
  state: NoteState;
  purgesAt: number | null;
  stateAt: number | null;
}

/** An upload as a listing gives it: with how many notes the asker can see show it. */
export interface ListedUpload extends Upload {
  uses: number;
}

export interface TrashedUpload extends Upload {
  trashedAt: number;
  trashedBy: Author;
}

/** An upload that a note's text refers to. */
export interface ReferredUpload {
  id: string;
  /** Null when there is no such upload or the one asking can't see it. Nothing tells the two apart, and nothing else is told of it. */
  upload: Pick<Upload, "name" | "type" | "kind" | "size" | "width" | "height" | "state"> | null;
}

/**
 * An upload being sent in parts, as whoever started it is told: how the file is cut, which parts are
 * stored, and where the rest go. `address` is a path on the server with `{part}` where a part's number
 * goes; it takes each part once, and lapses at `expiresAt`.
 */
export interface SendingUpload {
  id: string;
  name: string;
  size: number;
  /** What a note that shows it is to write it as, judged from its name until its bytes are read. */
  kind: UploadKind;
  partSize: number;
  partCount: number;
  stored: number[];
  address: string;
  expiresAt: number;
}

/** How much the uploads of a workspace take. Pending ones are those still being sent. */
export interface UploadStorage {
  bytes: number;
  files: number;
  trashedBytes: number;
  pendingBytes: number;
}

/** An upload's bytes as they were read from the bucket: all of them, the part that was asked for, or none when the asker already has them. */
export interface OpenedUpload {
  upload: Upload;
  /** Absent when the asker's copy, named by the validator they sent, is still good. */
  body?: ReadableStream<Uint8Array>;
  /** Names these bytes, for asking again. */
  etag: string;
  /** The part read, when a part was asked for. */
  range?: { offset: number; length: number };
}

/** One part of an export: how many notes and uploads it holds, their bytes before the zip's own, and the address of its bytes. */
export interface ExportPart {
  number: number;
  notes: number;
  uploads: number;
  bytes: number;
  address: string;
}

/** An export of what the asker can see, in parts. Most are one. */
export interface ExportPlan {
  notes: number;
  uploads: number;
  parts: ExportPart[];
}

/** A part of an export as it is sent: a zip written while it is read. */
export interface OpenedExport {
  /** The workspace's name, which the file is saved under. */
  workspace: string;
  body: ReadableStream<Uint8Array>;
}

/** A grant as someone who may share its item is told of it. */
export interface Grant {
  id: string;
  on: { kind: "note" | "folder" | "upload"; id: string; name: string };
  access: GrantAccess;
  to:
    | {
        kind: "person";
        /** Kept from anyone but an admin and whoever made the grant by typing it, once a person has taken the grant up. */
        email: string | null;
        /** Null until someone signs in with the email. */
        personId: string | null;
        name: string | null;
        /** Their role when they are a member, whom the grant narrows. Null for a guest. */
        role: Role | null;
      }
    /**
     * `token` is what the link's address ends in: `/s/<token>`. Null when the link is on a folder
     * this member cannot share. They are told the link exists. The address stays with whoever can change that folder.
     */
    | { kind: "link"; link: LinkKind; token: string | null };
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
  /** Uploads directly in this folder that the one asking can see. */
  uploadCount: number;
  /** What the one asking may do with the folder: with edit, make notes and folders in it. */
  access: GrantAccess;
  /** Its name after those of the folders it is in, as far up as the one asking can see: `Projects/Skills`. */
  path: string;
}

/** A link written by title that a write left as written: no note the writer can see has the title, or several do (`matches`). */
export interface UnresolvedLink {
  target: string;
  matches: string[];
}

/** A note a write made or changed, with the links by title it left as written, when there were any. */
export type Linked<T> = T & { unresolved?: UnresolvedLink[] };

export type Author =
  | { kind: "member"; personId: string; name: string }
  /** A connected agent, named as its member named it; `onBehalfOf` is that member. */
  | { kind: "agent"; agentId: string; name: string; onBehalfOf: string }
  /** A plugin installed in the workspace, acting for the member `onBehalfOf` within what it is permitted. */
  | { kind: "plugin"; pluginId: string; name: string; onBehalfOf: string };

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

/** Who wrote each line of a note: the change that last wrote or edited it. */
export interface Blame {
  /** The revision the note is at, whose text this is. */
  revision: number;
  text: string;
  /** Runs of lines one change last wrote, top to bottom, one for every line of `text` and none for no text. Lines count from 1. */
  lines: { from: number; to: number; revision: number }[];
  /** The changes `lines` names, oldest first, each once. */
  changes: ChangeEntry[];
  /**
   * The name of each member whose agent wrote a line, by their person id, for someone who may know
   * who the members are: a member who sees the whole workspace. Nobody's for anyone else.
   */
  owners: Record<string, string>;
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
  /** As `Written.unfiled`: there when the revert took completions back out, or put them back. */
  unfiled?: Written["unfiled"];
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
  reverted: { note: NoteSummary & Pick<Written, "unfiled">; revisions: number[] }[];
  /** The reverted notes left with no text, each under the title it had, and whether it was moved to Trash, as `trashEmptied` asks. */
  emptied: { noteId: string; title: string; trashed: boolean }[];
  /** Notes that refused the change, such as one it would make too long. They are left as they were. */
  failed: { noteId: string; title: string; message: string }[];
  /** Pass as `after` to cover the notes not reached yet; null when every note was. */
  next: string | null;
}

/** How far one person has read the changes in one workspace. */
export interface Visit {
  /** Every change made before this is one they marked read. Null until they first do. */
  readUntil: number | null;
  /** The server's time as it answered. */
  now: number;
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
  /** `next` is the `after` of the page after, or null on the last, here and in each list that pages. */
  "note.list": { notes: NoteSummary[]; next: string | null };
  "note.create": Linked<Note>;
  "note.read": ReadNote;
  "note.write": Linked<Written>;
  "note.edit": Linked<Written>;
  "note.backlinks": NoteSummary[];
  "links.rebuild": Rebuilt;
  "todo.list": { todos: ListedTodo[]; next: string | null };
  /** Each name once, ignoring case, as a note writes it. */
  "todo.filters": { tags: string[]; assignees: Mentioned[] };
  "todo.set": Written;
  /** `completed` is as todo.list gives it. */
  "todo.history": { completions: Completion[]; completed: Ticking | null };
  "daily.open": Note;
  "daily.find": { note: NoteSummary | null };
  "pin.list": NoteSummary[];
  "pin.set": { id: string; pinned: boolean };
  "visit.read": Visit;
  "visit.mark": Visit;
  "todos.rebuild": Rebuilt;
  "note.history": ChangeEntry[];
  "note.move": Note;
  "note.archive": Note;
  "note.trash": Note;
  /** `folderGone` when the folder it was in was deleted while it was in Trash, so it came back to Unsorted. */
  "note.restore": Note & { folderGone: boolean };
  "note.purge": { id: string };
  "note.discard": { id: string };
  "trash.list": { notes: TrashedNote[]; next: string | null };
  /** `indexing` is true while some notes are still to be read into the index, as after a deploy: the answer may lack them, and asking again reads more. */
  "tag.list": { tags: ListedTag[]; next: string | null; indexing: boolean };
  "tag.describe": { name: string; description: string | null };
  /** `indexing` is as for tag.list. */
  search: { results: SearchResult[]; next: string | null; indexing: boolean };
  "note.label": { id: string; revision: number; label: string | null };
  "note.revert": Written;
  "note.revertChanges": Written;
  "note.previewRevert": RevertPreview;
  "note.undo": Written;
  "note.redo": Written;
  "note.diff": Diff;
  "note.blame": Blame;
  "history.summary": HistorySummary;
  "history.list": HistoryPage;
  "history.authors": Author[];
  "history.revertAuthor": AuthorReverted;
  "history.diff": SelectionDiff;
  "history.previewRevert": NoteRevertPreview[];
  "history.revert": RevertedNotes;
  /** `unsortedId` is null for a guest, who can't see Unsorted unless it was shared with them. */
  "folder.list": { unsortedId: string | null; folders: ListedFolder[] };
  /** `created` is false when the parent already had the folder, which `ifExists: "return"` answers with. */
  "folder.create": Folder & { created: boolean };
  "folder.find": ListedFolder;
  "folder.rename": Folder;
  "folder.move": Folder;
  "folder.delete": { id: string };
  "settings.read": StoredSettings;
  "settings.write": StoredSettings;
  "timeZone.record": { timeZone: string };
  "member.list": Member[];
  /** `member` when the email was already a member's, whose role this changed. Otherwise `invite`. */
  "member.invite": { member: Member; invite: null } | { member: null; invite: Invite };
  "member.setRole": Member;
  "member.remove": { memberId: string };
  "member.leave": { memberId: string };
  "member.signOut": { memberId: string };
  "invite.list": Invite[];
  "invite.revoke": { id: string };
  "account.read": AccountDeletion;
  /** The workspaces deleted with the account. */
  "account.delete": { deleted: WorkspaceRef[] };
  /** False while some of what it held is still being erased, which carries on without anyone. */
  "workspace.delete": { erased: boolean };
  "grant.list": Sharing;
  "grant.set": Grant;
  "grant.link": Grant | null;
  "grant.revoke": { id: string };
  /** `removed` is how many grants and links other people had put on the note, which went as it became private. */
  "note.setPrivate": { id: string; private: boolean; removed: number };
  "shared.open": Shared;
  "shared.read": SharedNote & { text: string; revision: number; links: LinkedNote[]; uploads: ReferredUpload[] };
  "shared.upload": OpenedUpload;
  "upload.create": Upload;
  "upload.start": SendingUpload;
  "upload.resume": SendingUpload;
  "upload.part": { id: string; number: number; stored: number };
  "upload.finish": Upload;
  "upload.abort": { id: string };
  "upload.storage": UploadStorage;
  "upload.list": { uploads: ListedUpload[]; next: string | null };
  "upload.read": Upload & { usedIn: NoteSummary[] };
  "upload.open": OpenedUpload;
  "upload.move": Upload;
  "upload.place": Upload;
  "upload.archive": Upload;
  /** `usedIn` is how many notes the asker can see still refer to it. */
  "upload.trash": Upload & { usedIn: number };
  "upload.restore": Upload & { folderGone: boolean };
  "upload.purge": { id: string };
  "upload.trashed": TrashedUpload[];
  "upload.setPrivate": { id: string; private: boolean; removed: number };
  "export.plan": ExportPlan;
  "export.open": OpenedExport;
  "source.list": { sources: Source[] };
  /** `redirect` is where the member's browser goes to agree, or null when the data source is connected already. */
  "source.connect": { sources: Source[]; redirect: string | null };
  "source.disconnect": { sources: Source[] };
  /**
   * `sources` is every calendar data source the asker has, so one that needs reconnecting is said and
   * not just missing. `calendars` is every calendar in the connected ones, with or without events in the span.
   */
  "event.list": { events: CalendarEvent[]; sources: Source[]; calendars: Calendar[] };
  "event.update": CalendarEvent;
  "event.create": CalendarEvent;
  /** `more` when a data source has more contacts than it lists. */
  "contact.list": { contacts: Contact[]; sources: Source[]; more: boolean };
  "contact.update": ContactCard;
  "contact.photo": ContactCard;
  "contact.create": ContactCard;
  "person.read": PersonPage;
  "record.refer": Reference;
  "record.read": SourceRecord;
  "record.notes": { notes: NoteAbout[] };
  "plugin.list": PluginRecord;
  "plugin.read": { id: string; code: string; codeHash: string };
  "plugin.install": PluginRecord & { id: string; proposed?: PluginProposal };
  "plugin.uninstall": PluginRecord & { proposed?: PluginProposal };
  "plugin.permit": PluginRecord & { proposed?: PluginProposal };
  "plugin.proposals": { proposals: PluginProposal[] };
  "plugin.decide": PluginRecord;
  "plugin.request": PluginRecord;
  "plugin.scaffold": { manifest: string; code: string };
  "plugin.validate": Validated;
  "plugin.frame": { token: string | null; origins: string[] };
  "plugin.trust": PluginRecord;
  "draft.list": { drafts: DraftSummary[] };
  "draft.read": Draft;
  "draft.save": DraftSummary;
  "draft.discard": { drafts: DraftSummary[] };
}

/**
 * An admin's agent asking to install, update, permit or uninstall a plugin, which waits for an admin.
 * `request` is the operation it sent. An answer to an agent's plugin.install, plugin.permit or
 * plugin.uninstall carries it as `proposed`, and nothing else has changed.
 */
export interface PluginProposal {
  id: string;
  kind: "install" | "update" | "permit" | "uninstall";
  /** The plugin it is about: the id a new one will take, or `html` for HTML embeds. */
  pluginId: string;
  name: string;
  request: Extract<Op, { type: "plugin.install" | "plugin.permit" | "plugin.uninstall" }>;
  agent: { id: string; name: string };
  /** The admin the agent asked for. */
  for: { id: string; name: string };
  createdAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "declined" | "expired";
  decidedBy: { id: string; name: string } | null;
  decidedAt: number | null;
  message: string;
}

export type SourceKind = "calendar" | "contacts";
/** `needs_reconnect` when it was connected and where it comes from stopped answering for the member. */
export type SourceState = "connected" | "needs_reconnect" | "not_connected";

/** A data source as its owner sees it. Nobody else is told it exists. */
export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  /** Where it comes from, such as "Google". Data sources that share one are connected and disconnected together. */
  provider: string;
  state: SourceState;
  /** False for a read-only data source, which refuses every change. */
  writable: boolean;
  /** Set on one that is read-only only because the member agreed to no more: connecting it again with `edit` asks to change it too. */
  reconnectToWrite?: true;
  /** The account it is connected to, or null when it isn't. */
  account: string | null;
}

/** One calendar in a calendar data source, such as a member's work calendar in their Google account. */
export interface Calendar {
  sourceId: string;
  /** Unique within its data source. */
  id: string;
  name: string;
  /** As `#rrggbb`, or null when its data source says none. */
  color: string | null;
  /** Whether the member may add events to it and change its own. */
  writable: boolean;
}

export interface CalendarEvent {
  sourceId: string;
  id: string;
  /** The calendar it is in, by its id in the data source. */
  calendarId: string;
  /** The name of the calendar it is in, and that calendar's color as `#rrggbb`. */
  calendar: string;
  color: string | null;
  title: string;
  when: EventWhen;
  /** The zone the event was made in, when it says. */
  timeZone: string | null;
  location: string | null;
  description: string | null;
  /** True for one occurrence of an event that recurs. Changing it changes that occurrence alone. */
  recurring: boolean;
  /** False when the member can only read the calendar it is in, or the data source is read-only. */
  editable: boolean;
  /** Sent back with a change, which is refused when the event has changed since. */
  etag: string;
  /** Its page where it is kept. */
  url: string | null;
}

/**
 * The labels Google's contacts have of their own for each kind of line, as People's `type` names
 * them, each with the plain words it is shown in. Any other label is one the member wrote.
 */
export const CONTACT_LABELS = {
  emails: { home: "Home email", work: "Work email", other: "Other email" },
  phones: { mobile: "Mobile", home: "Home phone", work: "Work phone", main: "Main", homeFax: "Home fax", workFax: "Work fax", pager: "Pager", other: "Other phone" },
  addresses: { home: "Home address", work: "Work address", other: "Other address" },
  urls: { homePage: "Home page", work: "Work website", blog: "Blog", profile: "Profile", other: "Other website" },
} as const satisfies Record<string, Record<string, string>>;
/** A contact's fields that are lines, each with a label. */
export type LabelledField = keyof typeof CONTACT_LABELS;

/** The label a member typed, as it is kept: one of Google's own when it names one, in any case and either as its key or its words; else the words as typed, spaces made one; null when empty. */
export function labelType(field: LabelledField, typed: string): string | null {
  const said = typed.trim().replace(/\s+/g, " ");
  if (!said) return null;
  const folded = said.toLowerCase();
  return Object.entries(CONTACT_LABELS[field]).find(([type, words]) => type.toLowerCase() === folded || words.toLowerCase() === folded)?.[0] ?? said;
}

/** One line of a contact's and its label: a key of `CONTACT_LABELS` for its field, a label the member wrote, or null for none. */
export interface ContactLine {
  value: string;
  type: string | null;
}

export interface Contact {
  sourceId: string;
  id: string;
  name: string;
  emails: ContactLine[];
  phones: ContactLine[];
  organization: string | null;
  url: string | null;
}

/** A contact with all its data source holds of them, as its owner alone is shown it. */
export interface ContactCard extends Contact {
  /** Their job title, where the organization is. */
  title: string | null;
  addresses: ContactLine[];
  /** YYYY-MM-DD, or --MM-DD when the year isn't known. */
  birthday: string | null;
  notes: string | null;
  /** An https address of their picture, or a data: address for one kept here. */
  photo: string | null;
  urls: ContactLine[];
  /** Sent back with a change, which is refused when the contact has changed since. */
  etag: string;
}

/** A change to a contact: each field given is the whole of it, and null takes it away. */
export type ContactChange = Partial<{ name: string; emails: ContactLine[]; phones: ContactLine[]; organization: string | null; title: string | null; addresses: ContactLine[]; birthday: string | null; urls: ContactLine[]; notes: string | null }>;

/** One line of a note that mentions a person, as the asker is shown it: each mention on it written as the name it shows. */
export interface MentionLine {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  updatedAt: number;
}

/** A person as one asker may be told of them. */
export interface PersonPage {
  /** Who it is, as a mention names them: a member's id, or a name. */
  who: string;
  name: string;
  member: Member | null;
  contacts: ContactCard[];
  todos: ListedTodo[];
  mentionedIn: MentionLine[];
  /** Whether more lines mention them than are listed. */
  more: boolean;
  /** The query that finds the notes that mention them, which a search from their page is narrowed by. */
  query: string;
  /** The query that lists the todos assigned to them, as the Todos page reads it. */
  todoQuery: string;
}

export type SourceRecord = { kind: "event"; ref: string; event: CalendarEvent } | { kind: "contact"; ref: string; contact: Contact };

/**
 * Who sees a note: `private`, a private note nobody else is let in to; `shared`, a private note its
 * owner shared with some people or by a link; `workspace`, a note every member of the workspace sees.
 */
export type Audience = "private" | "shared" | "workspace";

/** A note that references a record, as `record.notes` lists it. */
export interface NoteAbout {
  id: string;
  title: string;
  updatedAt: number;
  audience: Audience;
}

export interface Reference {
  ref: string;
  kind: SourceRecord["kind"];
  /** The embed a note writes, such as `::event{k3j5h8d9f0a1 Lunch with Sam}`. */
  text: string;
}

export const MAX_AGENT_NAME = 60;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

/** A member's live clipper sign-in, as Settings lists it. */
export interface ClipperGrantView {
  id: string;
  extensionId: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

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
  /** The app it was connected from by OAuth, as that app names itself, which nobody has checked. Null for an agent connected on the Agents page. */
  app: string | null;
}

export const MAX_AGENT_FOLDERS = 50;
/** The folders to limit an agent to. Each stands for itself and the folders under it. */
const FolderLimit = z.array(Id).min(1, "Name at least one folder, or leave folders out for all notes").max(MAX_AGENT_FOLDERS);

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
  /** The time zone of the browser they last used Common Ink in, or null when none has said one yet. */
  timeZone: string | null;
  workspaces: WorkspaceSummary[];
  /** True on this machine and in Previews, and never in production: there a test may put plugins on the page itself. */
  dev: boolean;
}

export interface WorkspaceRef {
  id: string;
  name: string;
}

/** What deleting someone's account would do. */
export interface AccountDeletion {
  email: string;
  /** The workspaces they are the only member of, which go with the account. */
  deletes: WorkspaceRef[];
  /** The workspaces where they are the only admin and others are members. The account can't be deleted until each has another admin or is deleted. */
  blocking: WorkspaceRef[];
}

/** What an operation answers anyone who isn't in the workspace, whether or not there is one. */
export const NO_SUCH_WORKSPACE = "No such workspace";

/** How the server the app is on is set up, where the app follows it. Only the server says it. */
export interface Setup {
  /** Whether HTML embeds are served from a host of their own (`EMBED_ORIGIN`), apart from the app's site. */
  embedSite: boolean;
  /** Whether files are opened in a tab from a site of their own (`FILE_ORIGIN`). Without one a PDF is downloaded. */
  fileSite: boolean;
}

/** What `/api/me` answers: who is signed in, and how the server is set up. */
export interface MeHere extends Me {
  setup: Setup;
}

/** `unavailable` when something outside Common Ink that the operation needs did not answer. */
export type OpErrorCode = "invalid" | "not_found" | "forbidden" | "conflict" | "unavailable";

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
