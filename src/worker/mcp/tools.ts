import { whoAmI } from "../../core/accounts.ts";
import { perform, type Actor } from "../../core/operations.ts";
import { NO_SUCH_WORKSPACE, OpError, type OpInput, type OpType } from "../../core/protocol.ts";
import { RULE_GRAMMAR } from "../../core/recurrence.ts";
import type { ConnectedAgent } from "../../core/agents.ts";

/** What a tool call comes back with: text for the agent, and whether it failed. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const workspaceProp = {
  type: "string",
  description: "The workspace id. Optional when you belong to only one; list_workspaces shows yours.",
} as const;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The operation this tool performs. Its arguments are the operation's own, and the core checks them. */
  op?: OpType;
}

const MEMBERS =
  "Who is in a workspace decides who can read and change everything in it, and a change to that is not a change in history: it can't be reverted the way an agent's edits can. An agent reads notes other people wrote, so one that was talked into it could invite a stranger as admin or remove the other admins. Only the member, signed in, changes who is in a workspace.";

const SHARING =
  "Who a note or a folder is shared with decides who can read it, up to anyone on the internet for a public link, and a change to that is not a change in history: it can't be reverted the way an agent's edits can. An agent reads notes other people wrote, so one that was talked into it could publish a note or hand a folder to a stranger. Only the member, signed in, shares.";

/**
 * Operations an agent is deliberately not given, each with the reason. Every other operation has a
 * tool below, and test/core/agent-parity.test.ts fails when one has neither.
 */
export const NOT_FOR_AGENTS: Partial<Record<OpType, string>> = {
  "settings.read": "Settings shape the member's own app: its theme, keys, and which plugins are on. An agent has no use for them, and they hold only what differs from defaults the app knows and the server doesn't.",
  "settings.write": "Only the member changes their settings. What the keys mean is assembled in the app from its plugins, so the server couldn't check what an agent wrote, and an agent could turn off or rebind what the member relies on.",
  "member.invite": MEMBERS,
  "member.setRole": MEMBERS,
  "member.remove": MEMBERS,
  "member.leave": "Leaving ends the member's own access and their agents' with it, and only an admin can undo it. The member does that themself.",
  "invite.list": "Invites name people who are not in the workspace yet, by email, and are only of use for managing them, which an agent can't do.",
  "invite.revoke": MEMBERS,
  "grant.list": "How a note is shared names people outside the workspace by email, and is only of use for sharing it, which an agent can't do. What the agent itself may do with a note is in every listing of it, as access.",
  "grant.set": SHARING,
  "grant.link": SHARING,
  "grant.revoke": SHARING,
  "note.setPrivate": "A private note is hidden from every other member, admins too, and that is not a change in history. The member who made the note decides it, in the app.",
  "shared.open": "A link is opened by whoever holds it, in a browser, with no token. An agent reads the notes its member can see.",
  "shared.read": "A link is opened by whoever holds it, in a browser, with no token. An agent reads the notes its member can see.",
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { workspace: workspaceProp, ...properties },
  required,
  additionalProperties: false,
});

const noteId = { type: "string", description: "The note id" };
const linkTitles = { type: "string", enum: ["resolve", "keep"], description: 'What to do with links written by title, [[Title]]. "resolve", the default, stores each by its note\'s id and refuses the write when no note or more than one has that title. "keep" leaves them as text that links nothing.' };
const day = (description: string) => ({ type: "string", description: `${description}, as YYYY-MM-DD` });
const TODOS =
  "A todo is a checkbox line in a note: - [ ] open, - [x] done. Its options are tokens on the line: !, !! or !!! right after the checkbox for importance, and due:YYYY-MM-DD for the day it is due. every:RULE makes it repeat, and each listed todo's recurs says its rule in words. The rules:\n" +
  RULE_GRAMMAR +
  "\ndone:YYYY-MM-DDxN is when a repeating todo was last checked off and how many times, which checking it off writes. A #tag anywhere in a note tags the note, and a todo counts as tagged with its note's tags.";
const LINKS = "A link to another note is [[id]] or [[id|display text]] with the note's id, so it survives the note being renamed. You can write [[Title]] or [[Title|display text]] instead and it is stored by id; text in code is left alone.";
const folderId = (description: string) => ({ type: "string", description });
const folderName = { type: "string", maxLength: 100, description: "The folder's name, without a /" };
const revisions = { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, description: "The revisions of the changes, from note_history or history" };
const choice = {
  anyOf: [
    { type: "string", enum: ["keep", "back"] },
    { type: "object", properties: { text: { type: "string", description: "The lines to have there, typed out; an empty string for no lines" } }, required: ["text"], additionalProperties: false },
  ],
};
const choices = { anyOf: [{ type: "string", enum: ["keep", "back"] }, { type: "array", items: choice }] };
const resolve = {
  type: "object",
  description:
    'How to settle the conflicts preview_revert lists: places where later changes edited lines this revert changes. "keep" keeps the later edits (what a revert does when this is left out), "back" returns the lines to how they were before the reverted changes and drops the later edits to them, and { text } puts the lines given there. Pass one choice for all of them, or a list with one for each conflict in the order preview_revert lists them.',
  properties: {
    at: { type: "integer", minimum: 0, description: "The revision preview_revert answered with. The revert is refused when the note has changed since: preview again" },
    choices,
  },
  required: ["at", "choices"],
  additionalProperties: false,
};
const resolveByNote = {
  type: "object",
  description:
    "How to settle the conflicts of the notes named here, by note id: for each, what preview_revert with author listed, settled as resolve settles them there. A note left out keeps every later edit. A note that has changed since its preview is left as it was and named in failed.",
  additionalProperties: resolve,
  maxProperties: 200,
};
const author = {
  type: "object",
  properties: { kind: { type: "string", enum: ["member", "agent", "plugin"] }, id: { type: "string" } },
  required: ["kind", "id"],
  additionalProperties: false,
};
const noteIds = (description: string) => ({ type: "array", items: { type: "string" }, minItems: 1, description });
const by = { type: "string", enum: ["people", "agents"], description: "Only changes by people, or only by agents" };
const selected = (item: Record<string, unknown>, required: string[], description: string) => ({
  type: "array",
  minItems: 1,
  maxItems: 40,
  description,
  items: { type: "object", properties: { noteId, ...item }, required: ["noteId", ...required], additionalProperties: false },
});
const reverted = selected(
  {
    revisions,
    to: { type: "integer", minimum: 0, description: "Instead of revisions: the revision to return the note to" },
    author: { ...author, description: "Instead of revisions: the member or agent whose changes to this note that still stand are reverted, as revert_author picks them" },
    at: { type: "integer", minimum: 0, description: "The note's revision that preview_reverts answered with. The note is skipped when it has changed since" },
    choices: { ...choices, description: "How to settle this note's conflicts, as resolve.choices of revert_changes does. Needs at" },
  },
  [],
  "The notes to revert, each named once: up to 40, each with revisions (its changes to revert), to (the revision to return to) or author (whose changes to revert)",
);
const time = (description: string) => ({ type: "integer", minimum: 0, description: `${description}, in milliseconds since 1970` });

export const TOOLS: Tool[] = [
  {
    name: "list_workspaces",
    description:
      "The workspaces you can reach, each with your member's role in it: admin, editor or viewer, or guest where they aren't a member and were given some notes or folders. You act with your member's role and grants, and no more.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_notes",
    description:
      "The notes in a workspace that you can see, newest change first: id, title, folder, revision, when it last changed, and access, which is edit or view: what you may do with that note. A note you can't see is never listed, and reads as no such note everywhere. Narrow it to one folder, or to notes whose text changed since a time.",
    inputSchema: object({ folderId: folderId("Only notes in this folder, from list_folders"), updatedSince: time("Only notes whose text changed at or after this time") }),
    op: "note.list",
  },
  {
    name: "read_note",
    description: "A note's markdown text. Pass revision to read an earlier version. Links in the text are [[id]] or [[id|display text]]: links names each linked note's id with its title now, or a null title for a note that doesn't exist or that you can't see.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 0, description: "An earlier revision; default is the latest" } }, ["id"]),
    op: "note.read",
  },
  {
    name: "create_note",
    description: `Make a note with markdown text whose first # heading is its title, in a folder or in Unsorted when none is named. ${LINKS} ${TODOS} Needs the editor or admin role.`,
    inputSchema: object({ text: { type: "string", description: "The note's markdown" }, folderId: folderId("The folder to put it in, from list_folders; default is Unsorted"), linkTitles }),
    op: "note.create",
  },
  {
    name: "write_note",
    description:
      `Replace a note's text. Give the revision you read as baseRevision: edits made since then are merged in, not overwritten. Send the same writeId again after a failed call and the write is recorded once. ${LINKS} Checking the box of a repeating todo here completes it as set_todo does: the answer has the line open again with its next due date, and filed says where the checked line went. Needs the editor or admin role. The change is recorded under your agent's name.`,
    inputSchema: object(
      {
        id: noteId,
        baseRevision: { type: "integer", minimum: 0, description: "The revision your text is based on" },
        text: { type: "string", description: "The note's full new markdown" },
        writeId: { type: "string", maxLength: 64, description: "Any unique string, to make a retry safe" },
        linkTitles,
        on: day("The day it is for you, which a repeating todo checked off is completed on and filed under. Left out, it is today in the time zone your member's settings name, or in UTC"),
      },
      ["id", "baseRevision", "text"],
    ),
    op: "note.write",
  },
  {
    name: "backlinks",
    description: "The notes whose text links to a note, latest change first, each as list_notes gives it. Only notes you can see are listed.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: "note.backlinks",
  },
  {
    name: "rebuild_links",
    description: "Make what is derived from the notes' text again, for every note in the workspace: the record behind backlinks, and the index behind list_todos. Every write keeps them, so this is only for a record that was changed some other way. It covers so many notes a call: while the answer's done is false, call again. Needs the admin role.",
    inputSchema: object({}),
    op: "links.rebuild",
  },
  {
    name: "list_todos",
    description: `The todos in the notes you can see: open ones, or done ones too with includeCompleted. ${TODOS} Open ones come first, then the soonest due, then the most important. Each has its note, the revision the note was at, its line counted from 0 and the line's text, which set_todo takes to find it, and its done, importance, due, the note's tags, and access. Narrow it by folder, by a tag of the note, by a range of due days, both included, or to those with no due date, and by importance. Due days are calendar dates: pass the days you mean, since the server doesn't know your time zone. While next isn't null, pass it as offset for more.`,
    inputSchema: object({
      folderId: { type: "string", description: "Only todos in notes in this folder or in a folder under it, from list_folders" },
      tag: { type: "string", description: "Only todos in notes with this tag, without the #, ignoring case: a tag on the todo's own line, or anywhere else in its note" },
      dueFrom: day("Only todos due on or after this day"),
      dueTo: day("Only todos due on or before this day"),
      noDue: { type: "boolean", description: "True for only todos with no due date" },
      importance: { type: "array", items: { type: "integer", minimum: 0, maximum: 3 }, minItems: 1, description: "Only these levels: 0 is normal, 1 to 3 are !, !! and !!!" },
      includeCompleted: { type: "boolean", description: "True to list done todos too" },
      noteId: { type: "string", description: "Only the todos in this note" },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "How many todos; default 100" },
      offset: { type: "integer", minimum: 0, description: "The next of the page before" },
    }),
    op: "todo.list",
  },
  {
    name: "todo_filters",
    description: "The tags list_todos can be narrowed by: those of the notes that have todos, among the notes you can see. The folders it can be narrowed by are list_folders'.",
    inputSchema: object({}),
    op: "todo.filters",
  },
  {
    name: "set_todo",
    description:
      "Check a todo off, skip it, or change its importance, due date, how it repeats or its words, by rewriting its line in its note. Checking off a todo that repeats leaves it open with its next due date and a done: mark, and files the checked line on your member's daily note for the day: the answer's filed says which day and note. A rule that ends (-times-N, -until-DAY) counts down, and its last time checks the todo off for good. skip moves a repeating todo to its next due date with nothing checked off, and is refused for one that doesn't repeat or is on its last time. Undoing or reverting that change takes the filed line off the daily note again. Pass id, revision, line and text as list_todos gave them. The line is followed through every change made to the note since that revision, so it is found where it has moved to and no other todo is taken for it, even one that reads the same. The call is refused as a conflict when that line was itself changed or deleted, so list again. Made twice, it changes nothing more. Whatever you leave out stays as written. Needs edit on the note. The change is recorded under your agent's name.",
    inputSchema: object(
      {
        id: noteId,
        revision: { type: "integer", minimum: 0, description: "The revision of the note the todo was listed at, from list_todos" },
        line: { type: "integer", minimum: 0, description: "The todo's line, from list_todos" },
        text: { type: "string", description: "The todo's line as written, from list_todos" },
        done: { type: "boolean", description: "True checks it off, false opens it again" },
        importance: { type: "integer", minimum: 0, maximum: 3, description: "0 for normal, 1 to 3 for !, !! and !!!" },
        due: { type: ["string", "null"], description: "The day it is due as YYYY-MM-DD, or null for no due date" },
        every: { type: ["string", "null"], description: `How it repeats, as written after every:, or null to stop it repeating. The rules:\n${RULE_GRAMMAR}` },
        skip: { type: "boolean", description: "True moves a repeating todo's due date to its next one with nothing checked off or filed. It counts as one of a rule's -times-N. Not together with done" },
        on: day("The day it is for you, which a repeating todo checked off is completed on and filed under. Left out, it is today in the time zone your member's settings name, or in UTC"),
        words: { type: "string", description: "What the todo says instead, as list_todos gives its words: everything but its checkbox, importance, due date, rule and done: mark, tags included, on one line. Its due date and how it repeats are written after them" },
      },
      ["id", "revision", "line", "text"],
    ),
    op: "todo.set",
  },
  {
    name: "todo_history",
    description: "Each time a repeating todo was checked off, latest first: the day, who did it, and the daily note it was filed on when you can see that note. Pass id, revision, line and text as list_todos gave them.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 0, description: "The revision of the note, from list_todos" }, line: { type: "integer", minimum: 0, description: "The todo's line, from list_todos" }, text: { type: "string", description: "The todo's line as written, from list_todos" } }, ["id", "revision", "line", "text"]),
    op: "todo.history",
  },
  {
    name: "daily_note",
    description: "Your member's daily note for a day: found, or made with the date as its heading in the folder their settings name. A member has one for each day, and it is where a repeating todo they or you check off is filed. Needs the editor or admin role.",
    inputSchema: object({ on: day("The day. Left out, it is today in the time zone your member's settings name, or in UTC") }),
    op: "daily.open",
  },
  {
    name: "rebuild_todos",
    description: "The same as rebuild_links: makes the index behind list_todos and the record behind backlinks again from the notes' text, for every note in the workspace. Notes written before there was an index are indexed without it, the first time todos are listed. While the answer's done is false, call again. Needs the admin role.",
    inputSchema: object({}),
    op: "todos.rebuild",
  },
  {
    name: "move_note",
    description: "Put a note in another folder. Its id and text stay the same. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, folderId: folderId("The folder to move it to, from list_folders") }, ["id", "folderId"]),
    op: "note.move",
  },
  {
    name: "list_folders",
    description: "The folders in a workspace: id, name, the folder each is inside (parentId), and how many notes are directly in it. unsortedId is the folder a note goes to when none is named.",
    inputSchema: object({}),
    op: "folder.list",
  },
  {
    name: "create_folder",
    description: "Make a folder, inside another when parentId is given. Needs the editor or admin role.",
    inputSchema: object({ name: folderName, parentId: folderId("The folder to make it inside; default is the top level") }, ["name"]),
    op: "folder.create",
  },
  {
    name: "rename_folder",
    description: "Give a folder another name. Unsorted can't be renamed. Needs the editor or admin role.",
    inputSchema: object({ id: folderId("The folder id"), name: folderName }, ["id", "name"]),
    op: "folder.rename",
  },
  {
    name: "delete_folder",
    description: "Delete a folder that has no notes and no folders in it. Needs the admin role.",
    inputSchema: object({ id: folderId("The folder id") }, ["id"]),
    op: "folder.delete",
  },
  {
    name: "note_history",
    description:
      "A note's recorded changes, oldest first: revision, the revision it was based on, who made it (a member, or an agent by name), when, its label, the lines it added and removed, the changes it reverted (reverts) and the later change that reverted it (revertedBy).",
    inputSchema: object({ id: noteId }, ["id"]),
    op: "note.history",
  },
  {
    name: "change_diff",
    description: "What one change did to its note, as a line diff: hunks of added, removed and unchanged lines, with the lines it added and removed counted.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 1, description: "The change, by the revision it made" } }, ["id", "revision"]),
    op: "note.diff",
  },
  {
    name: "history_summary",
    description:
      "The notes that changed, latest change first, each with how many changes it had, the lines they added and removed, when the first and last were made, and who made them. Start here, then read one note's changes with history and one change with change_diff. Narrow it by noteIds, authors (from history_authors) and a time range, which then count only the changes that match. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: noteIds("Only these notes"),
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
      by,
      from: time("Changes made at or after this time"),
      to: time("Changes made before this time"),
      before: { type: "object", description: "The next of the page before" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many notes; default 30" },
    }),
    op: "history.summary",
  },
  {
    name: "history",
    description:
      "Changes across the workspace, newest first, each with its note, author, the lines it added and removed, and a line diff. Narrow it by noteIds (one note, several, or all when left out), authors (from history_authors) and a time range. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: noteIds("Only these notes"),
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
      by,
      from: time("Changes made at or after this time"),
      to: time("Changes made before this time"),
      before: { type: "object", description: "The next of the page before" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many changes; default 50" },
      diffs: { type: "boolean", description: "False leaves the diffs out" },
    }),
    op: "history.list",
  },
  {
    name: "history_authors",
    description: "Everyone who has changed a note in the workspace: members by person id and agents by agent id, each with a name.",
    inputSchema: object({}),
    op: "history.authors",
  },
  {
    name: "history_diff",
    description:
      "What a selection of changes did, note by note, across up to 40 notes. A note's selected changes that follow one another are one run with one line diff, from the note before the first of them to the note after the last, so a line written and taken out again within a run shows in neither. A change left out in between starts a new run, which says how many were skipped. Each run has its revisions (from, to), how many changes it is (saves), who made them, when, and the lines it added and removed. An answer holds about 2000 diff lines: a run past them has diff null, and asking for its note alone returns it. A run's diff shows at most 200 lines and counts the rest in omitted.",
    inputSchema: object({ changes: selected({ revisions }, ["revisions"], "The selection: each note once, with the revisions of its changes") }, ["changes"]),
    op: "history.diff",
  },
  {
    name: "preview_reverts",
    description:
      "What revert_many would do to each note, with nothing written: for each, the note's revision it was worked out at (pass it back as at), the changes that would be reverted (revisions), the ones left out because something already reverted them (already), the diff from the note as it is to the note after, and its conflicts as preview_revert lists them. A change selected together with the change that reverted it stays reverted and that revert goes too. An empty diff means the note would not change.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: "history.previewRevert",
  },
  {
    name: "revert_many",
    description:
      "Revert changes of up to 40 notes at once, each note as one new change under your agent's name. Each note is reverted or skipped whole, by itself: the answer lists reverted (each with the revision the revert made and the changes it reverted) and skipped (each with why: changed, when the note is no longer at the revision passed as at; nothing, when the revert would change nothing; refused, with the reason). Call preview_reverts first and pass each note's revision back as at. To undo a revert, revert the revision it made, with at set to that revision: the note is skipped if it has been changed since. Needs the editor or admin role.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: "history.revert",
  },
  {
    name: "label_revision",
    description: "Name one revision of a note, so it can be found and reverted to. A null name takes the label away. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 1 }, name: { type: ["string", "null"], maxLength: 60 } }, ["id", "revision", "name"]),
    op: "note.label",
  },
  {
    name: "revert_note",
    description:
      "Put a note back to how it was at a revision. This is recorded as a new change under your agent's name; nothing is erased. Call preview_revert first; if it lists conflicts, pass resolve to settle them. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 0, description: "The revision to return to" }, resolve }, ["id", "revision"]),
    op: "note.revert",
  },
  {
    name: "revert_changes",
    description:
      "Revert chosen changes of a note and keep every other change, recorded as one new change under your agent's name. History only goes forward: to have a reverted change again, revert the change that reverted it (its revertedBy). Call preview_revert first; if it lists conflicts, pass resolve to settle them, or the later edits are kept. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revisions, resolve }, ["id", "revisions"]),
    op: "note.revertChanges",
  },
  {
    name: "revert_author",
    description:
      "Revert every change one author made that still stands, in every note or in noteIds, and keep everyone else's. Each note gets one new change under your agent's name. It covers ten notes a call: while the answer's next isn't null, call again with it as after. A note that refuses the change is left as it was and named in failed. To settle a note's conflicts, preview_revert it with author first and pass resolve; without it the later edits are kept. A note left with no text, such as one the author created, is named in emptied: it stays, since a note can't be deleted yet. Needs the editor or admin role.",
    inputSchema: object({ author: { ...author, description: "Whose changes, from history_authors" }, noteIds: noteIds("Only in these notes"), after: { type: "string", description: "The next of the call before" }, resolve: resolveByNote }, ["author"]),
    op: "history.revertAuthor",
  },
  {
    name: "preview_revert",
    description:
      "What a revert would do to a note, with nothing written. Pass one of: revisions to preview revert_changes of those changes, to to preview revert_note to that revision, or author to preview what revert_author would do to this note. Returns the note's revision it was worked out at, the changes that would be reverted (revisions), the diff from the note as it is to the note after (diff), overlaps: later changes that still stand and edited the same lines, and conflicts: each place they did, top of the note first, with the lines as they were before the reverted changes (before), as they are now (now), as the revert leaves them with the later edits kept (kept), the line of the result kept starts at (line), and the later changes that edited them with their authors (later). Settle each conflict with resolve on the revert; pass the same resolve here to see the diff of the revert settled that way. A read-only token can use it.",
    inputSchema: object({ id: noteId, revisions, to: { type: "integer", minimum: 0, description: "The revision to return to" }, author: { ...author, description: "Whose changes, from history_authors" }, resolve }, ["id"]),
    op: "note.previewRevert",
  },
  {
    name: "undo",
    description: "Take back your own latest change to a note that still stands, as a new change. Other authors' changes are kept. Needs the editor or admin role.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: "note.undo",
  },
  {
    name: "redo",
    description: "Revert your latest undo on a note, as a new change, so what it undid stands again. Needs the editor or admin role.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: "note.redo",
  },
  {
    name: "list_members",
    description: "Everyone in the workspace: person id, name and role (admin, editor or viewer), and no email, which only an admin is shown in the app. Members are the authors history names by person id. An agent can't invite, remove, or change anyone's role; a member does that in the app, on the Members page.",
    inputSchema: object({}),
    op: "member.list",
  },
];

export const toolList = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/** Runs a tool as `agent`. Failures the agent can act on come back as an error result, not a protocol error. */
export async function callTool(db: D1Database, agent: ConnectedAgent, name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    // The core leaves out a field it doesn't know, which would turn a misspelt argument into a different request.
    const takes = Object.keys((tool.inputSchema as { properties: object }).properties);
    const unknown = Object.keys(args).find((key) => !takes.includes(key));
    if (unknown !== undefined) throw new OpError("invalid", `${name} takes no "${unknown}". It takes ${takes.join(", ") || "no arguments"}.`);
    const me = await whoAmI(db, agent.personId);
    // A token pinned to one workspace sees only that one, as if the member belonged to no other.
    if (agent.workspaceId) me.workspaces = me.workspaces.filter((w) => w.id === agent.workspaceId);
    if (name === "list_workspaces") return text({ person: me.person, workspaces: me.workspaces, readOnly: agent.readOnly, folderIds: agent.folderIds });

    const { workspace, ...rest } = args;
    let workspaceId: string;
    if (workspace === undefined) {
      if (me.workspaces.length !== 1) throw new OpError("invalid", `Pass workspace: you can reach ${me.workspaces.length} (${me.workspaces.map((w) => w.id).join(", ")})`);
      workspaceId = me.workspaces[0]!.id;
    } else {
      if (typeof workspace !== "string" || !me.workspaces.some((w) => w.id === workspace)) throw new OpError("not_found", NO_SUCH_WORKSPACE);
      workspaceId = workspace;
    }
    const actor: Actor = { kind: "agent", agentId: agent.agentId, personId: agent.personId, workspaceId, scope: { pinnedWorkspaceId: agent.workspaceId, readOnly: agent.readOnly, folderIds: agent.folderIds } };
    return text(await perform(db, actor, { ...rest, type: tool.op! } as OpInput));
  } catch (err) {
    if (err instanceof OpError) return text(`${err.code}: ${err.message}`, true);
    throw err;
  }
}
