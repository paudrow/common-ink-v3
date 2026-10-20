import { whoAmI } from "../../core/accounts.ts";
import { timeIn } from "../../core/history.ts";
import { PRIOR_WRITE, agentActor, isReadOnlyOp, perform, timeZoneOf, type Actor } from "../../core/operations.ts";
import { OWN_SANDBOXED_IDS } from "../../core/ownPlugins.ts";
import { CAPABILITY_NAMES } from "../../core/plugins.ts";
import { MAX_INLINE_UPLOAD_BYTES, MAX_UPLOAD_BYTES, NO_SUCH_WORKSPACE, OpError, PART_BYTES, TODO_SORTS, type OpInput, type OpType, type SendingUpload, type Upload } from "../../core/protocol.ts";
import { writtenUpload } from "../../core/uploadRefs.ts";
import { ASK_NOTE_SYNTAX, syntaxDescription, syntaxText as noteSyntaxText } from "../../core/noteSyntax.ts";
import { MAX_SEARCH_LENGTH, SCOPES, queryLanguage, type Scope } from "../../core/query.ts";
import type { ConnectedAgent } from "../../core/agents.ts";
import { CLIPPER_TOOLS } from "../../core/clipper.ts";
import type { Sources } from "../../core/sources.ts";

/** What a tool call comes back with: text for the agent, and whether it failed. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

const workspaceId = {
  type: "string",
  description: "The workspace id. Optional when you belong to only one; list_workspaces shows yours.",
} as const;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The operation this tool performs. Its arguments are the operation's own, and the core checks them. */
  op?: OpType;
  /**
   * Arguments named otherwise than the operation's field they set, each with that field. An id is
   * always named for what it is the id of, `noteId` and not `id`. The field's name was the
   * argument's before, and is still taken for it.
   */
  renames?: Record<string, string>;
  /** What an argument left out is to an agent, where that differs from what it is to the operation. */
  defaults?: Record<string, unknown>;
  /** A first call that works, shown at the end of the description. Its ids are made up. */
  example: Record<string, unknown>;
  /** Keys of this tool's answer that hold a time, besides those that do in every answer. */
  times?: string[];
  /** What the agent is told of the operation's answer, when that is more than the answer: `origin` is the server's address. */
  told?: (answer: never, origin: string) => unknown;
  /** The key a page of the operation's list is told under, with next. The operation is asked for one more than limit, to know whether there are more. */
  pages?: string;
}

/** Each argument's old name, taken for the name it has now: `workspace` for every tool, and the operation's own field for an argument renamed. */
const oldNames = (tool: Pick<Tool, "renames" | "op">): Record<string, string> =>
  Object.fromEntries([...(tool.op ? [["workspace", "workspaceId"]] : []), ...Object.entries(tool.renames ?? {}).map(([name, field]) => [field, name])]);

const MEMBERS =
  "Who is in a workspace decides who can read and change everything in it, and a change to that is not a change in history: it can't be reverted the way an agent's edits can. An agent reads notes other people wrote, so one that was talked into it could invite a stranger as admin or remove the other admins. Only the member, signed in, changes who is in a workspace.";


const SHARING =
  "Who a note, a folder or an upload is shared with decides who can read it, up to anyone on the internet for a public link, and a change to that is not a change in history: it can't be reverted the way an agent's edits can. An agent reads notes other people wrote, so one that was talked into it could publish a note or hand a folder to a stranger. Only the member, signed in, shares.";

/**
 * Operations an agent is deliberately not given, each with the reason. Every other operation has a
 * tool below, and test/core/agent-parity.test.ts fails when one has neither.
 */
const CONTACTS =
  "A contact is how the member reaches someone: the address their mail goes to, the number their phone calls, in every app that reads their Google contacts. A change to one is not a change in history, so it can't be reverted the way an agent's edits can, and nothing in Common Ink shows it was made. An agent reads notes other people wrote, so one that was talked into it could quietly send the member's mail or calls for a colleague to a stranger. An agent reads the member's contacts, and only the member, signed in, changes or adds one.";


export const NOT_FOR_AGENTS: Partial<Record<OpType, string>> = {
  "settings.read": "Settings shape the member's own app: its theme, keys, and which plugins are on. An agent has no use for them, and they hold only what differs from defaults the app knows and the server doesn't.",
  "settings.write": "Only the member changes their settings. What the keys mean is assembled in the app from its plugins, so the server couldn't check what an agent wrote, and an agent could turn off or rebind what the member relies on.",
  "member.invite": MEMBERS,
  "member.setRole": MEMBERS,
  "member.remove": MEMBERS,
  "member.leave": "Leaving ends the member's own access and their agents' with it, and only an admin can undo it. The member does that themself.",
  "member.signOut": "Signing someone out of every browser locks them out until they sign in again with Google, which an agent can't do for them. An agent that was talked into it could keep its own member, or as an admin's agent anyone in the workspace, signed out. Only the member, signed in, does it.",
  "invite.list": "Invites name people who are not in the workspace yet, by email, and are only of use for managing them, which an agent can't do.",
  "invite.revoke": MEMBERS,
  "grant.list": "How a note, a folder or an upload is shared names people outside the workspace by email, and is only of use for sharing it, which an agent can't do. What the agent itself may do with a note or an upload is in every listing of it, as access.",
  "grant.set": SHARING,
  "grant.link": SHARING,
  "grant.revoke": SHARING,
  "note.setPrivate": "A private note is hidden from every other member, admins too, and that is not a change in history. The member who made the note decides it, in the app.",
  "note.purge": "Removing a note from Trash for good takes its history with it, and nothing brings it back: not a revert, not Trash. An agent reads notes other people wrote, so one that was talked into it could destroy them past recovery. An agent moves a note to Trash, where it waits 30 days, and only the member, signed in, removes it sooner.",
  "note.discard": "It removes, outside Trash and with its history, a note its member made and left with nothing in it, and it is the member's own app that does it as they leave the note. An agent's own notes are never discarded, and it has nothing to clean up: a note it makes without text it can move to Trash.",
  "source.connect": "Connecting a data source is the member agreeing, in their own browser, to let Common Ink into their calendar or contacts. An agent can't agree for them. It reads and changes what the member connected.",
  "source.disconnect": "Disconnecting ends the member's own agreement and cuts off every reference in their notes until they agree again. The member does that themself, in the app.",
  "contact.update": CONTACTS,
  "contact.photo": CONTACTS,
  "contact.create": CONTACTS,
  "shared.open": "A link is opened by whoever holds it, in a browser, with no token. An agent reads the notes its member can see.",
  "shared.read": "A link is opened by whoever holds it, in a browser, with no token. An agent reads the notes its member can see.",
  "shared.upload": "A link is opened by whoever holds it, in a browser, with no token. An agent reads the uploads its member can see.",
  "upload.setPrivate": "A private upload is hidden from every other member, admins too, and that is not a change in history. The member who uploaded it decides it, in the app.",
  "visit.mark": "How far a member has read the changes in a workspace moves only when the member has seen them and says so, in the app. An agent that marked them read would hide from the member what they haven't looked at. An agent reads how far that is with last_visit.",
  "upload.storage": "How much a workspace's uploads take counts every member's files, private ones and those in folders a token may be kept from, so it says something of what an agent can't see. It is for the members, in Settings.",
  "plugin.frame": "A frame's token opens, once, the frame the app runs a plugin or an HTML embed in, in the member's own browser. An agent runs neither.",
  "plugin.trust": "Turning a full-trust plugin on runs its code inside the member's own session, with everything the member can see and do. Each member decides that for themself, in the app, after reading what it means. An agent that was talked into it would hand its member's session to whoever wrote the plugin.",
  "upload.purge": "Removing an upload from Trash for good removes its bytes, and nothing brings them back: not Trash, and no note that showed it. An agent reads notes other people wrote, so one that was talked into it could destroy files past recovery. An agent moves an upload to Trash, where it waits 30 days, and only the member, signed in, removes it sooner.",
};

/**
 * Operations an agent performs with its token at an HTTP address instead of with a tool, each with
 * the reason and the address. A file's bytes are the body of a request there. `ink upload` and
 * `ink download` use them.
 */
export const OVER_HTTP: Partial<Record<OpType, string>> = {
  "upload.create": `A file's bytes are not text, and a tool call carries only text. POST /api/workspaces/<workspace>/uploads with the token as Authorization: Bearer, the bytes as the body, Content-Type: application/octet-stream, Content-Length, and X-Ink-Upload: encodeURIComponent of the JSON { name, folderId? }. The answer is 201 with the upload. One request carries at most ${PART_BYTES / 1024 / 1024} MB. upload_file does the same with base64 for a small file, and start_upload sends any file in parts.`,
  "upload.part": "A part's bytes are not text, and go from the agent's own shell, never through the model. PUT them to the address start_upload or resume_upload answered, with {part} the part's number: no token goes with it, since the address is the permission, and each address takes each part once.",
  "upload.open": "A file's bytes are not text, and a tool answer carries only text. GET /api/workspaces/<workspace>/uploads/<id> with the token as Authorization: Bearer answers with the bytes. Range and If-None-Match are honoured.",
};

/** Made-up ids for the examples. */
const NOTE = "k3f9q2m8x1ab";
const FOLDER = "f7d2c9b1e4a6";
const WORKSPACE = "w4k8s2p6c1e9";
const AGENT = "a5g3n7t1q9z2";
const UPLOAD = "u2p9l4d8a3c7";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { workspaceId, ...properties },
  required,
  additionalProperties: false,
});

/** What an agent may do with plugins: what its member may, as their role allows. */
const ROLE =
  "You act in your member's role: an admin's agent installs, updates, uninstalls and permits plugins, as an admin does; any member's agent makes and checks plugins, keeps that member's own drafts and asks an admin for a permission. A read-only token or one limited to folders does none of what changes anything here, and one limited to folders reads none of it. Turning full trust on is each member's own click in the app: no agent can.";
const PLUGIN_DOCS = "A manifest is JSON: name, version, description, capabilities (each { name, reason }), commands, views, embeds and settings, as docs/plugins.md says. The code is JavaScript that runs in a frame of its own and reaches the workspace only through ink.perform, with what an admin permitted.";
const DRAFT_WORDS = "A draft is its author's alone, kept beside their settings: no other member, admin or agent reads it, and it runs for nobody else.";
const manifest = { type: "string", description: "The manifest, as JSON text" };
const code = { type: "string", description: "The plugin's code, JavaScript" };
const pluginId = { type: "string", description: "The plugin's id, from list_plugins" };
const PLUGIN = "p3x8k1m6w2qz";
const CODE_HASH = "9f2c4d7a1b6e3085c4d9a7e2b1f06c3d8e5a4b7c2d1f90e3a6b5c8d7e4f10a29";
const draftId = { type: "string", description: `The id of the plugin the draft is of: an installed plugin's, or one of ${OWN_SANDBOXED_IDS.join(", ")}` };
const MANIFEST = '{"name":"Word count","version":"1.0.0","description":"Counts the words in a note.","capabilities":[],"commands":[],"views":[]}';
const CODE = "ink.commands.register({ id: \"count\", title: \"Count words\", run() {} });";
const capability = { type: "string", enum: CAPABILITY_NAMES, description: "The capability, as the plugin's manifest names it" };

const noteId = { type: "string", description: "The note id" };
const linkTitles = {
  type: "string",
  enum: ["resolve", "resolve-strict", "keep"],
  description:
    'What to do with links written by title, [[Title]]. "resolve", the default, stores each by its note\'s id, and leaves one no note or more than one has that title as written: the answer lists those in unresolved, with the ids of the notes that have the title when several do. "resolve-strict" refuses the whole write for one instead. "keep" leaves every link as written.',
};
const mentionNames = { type: "string", enum: ["resolve", "keep"], description: 'What to do with mentions you add, @[[Name]] or @[[id]]. "resolve", the default, stores a mention of the one member with that name by their id, as @[[id|Name]], and refuses the write when several members have the name. A name no member has stays a name. "keep" leaves every mention as you wrote it.' };
const day = (description: string) => ({ type: "string", description: `${description}, as YYYY-MM-DD` });
const MAX_PAGE = 200;
const page = (what: string) => ({
  limit: { type: "integer", minimum: 1, maximum: MAX_PAGE, description: `How many ${what}; default 50` },
  offset: { type: "integer", minimum: 0, description: "Where the page starts: next, from the page before" },
});
const queryDays = {
  today: day("The day it is for you, which today, yesterday, tomorrow, 7d and +7d in the query are counted from. The server doesn't know your day, so a query with one of them and no today is refused"),
  zone: { type: "string", description: "Your time zone, such as Europe/Paris, which says when a day begins and ends for updated:, created: and uploaded:. Left out, it is the zone your member's settings name, or UTC" },
};
const TODOS =
  'A todo is a checkbox line in a note: - [ ] open, - [x] done, with tokens on the line such as !! for its priority, due:2026-10-14, @[[Name]] to assign it, and every:2w or every:mon,thu to make it repeat. query_syntax {"scope":"todos"} lists every token and every rule of every:.';
const LINKS =
  "A link to another note is [[id]] or [[id|display text]] with the note's id, so it survives the note being renamed. You can write [[Title]] or [[Title|display text]] instead and it is stored by id; one no note has the title of stays as written and is listed in the answer's unresolved. Text in code is left alone.";
const MENTIONS =
  "A mention of a person is @[[id|Name]] for a member of the workspace, with their id from list_members, or @[[Name]] for anyone else, such as one of your member's contacts. You can write @[[Name]] for a member too and it is stored by their id, unless your token is limited to folders: it is then not told who is a member, and every mention is kept and read as written. A mention on a todo's line assigns the todo. A mention gives nobody access and tells nobody. Every reader of the note sees the name, so write only the name of a contact: never their email or anything else list_contacts told you.";
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
const includeArchived = { type: "boolean", description: "True to cover archived notes too, which are left out otherwise" };
const archivedToo = { enum: [true, false, "only"], description: 'True to cover archived notes too, which are left out otherwise, or "only" for the archived notes alone' };
const LIFE = "A note is live, archived or in Trash, which its state says. An archived note is left out of listings unless includeArchived is true, and is read and changed as any other. A note in Trash is listed only by list_trash, can be read, and can't be changed until restore_note brings it back.";
const uploadId = { type: "string", description: "The upload's id, from list_uploads" };
/** An upload, with the line a note shows it by. */
const withLine = (upload: Upload) => ({ ...upload, line: writtenUpload(upload.kind, upload.id, upload.width && upload.height ? { width: upload.width, height: upload.height } : null) });
const UPLOADS =
  "A note shows an upload with an embed on a line of its own that starts with the upload's id: ::image{<id> WIDTHxHEIGHT} or ::video{<id> WIDTHxHEIGHT}, with the room to keep for it, ::audio{<id>}, or ::file{<id>} for anything else. The upload's name is never in the note. Its bytes are not in any tool's answer: GET /api/workspaces/<workspace>/uploads/<id> with the same bearer token answers with them, and POST /api/workspaces/<workspace>/uploads takes a new file. A token limited to folders reaches only the uploads in them, at those addresses too.";
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
const SOURCES = "A data source is your member's own: no other member of the workspace sees its records, whatever their role, and you see no other member's. What you read from one is your member's private data, so put it in a note only where they asked for it there. A token limited to folders is refused every data source tool: the member's calendar and contacts are in no folder.";
/** The arguments that are times, which the operations take as milliseconds. */
const TIMES = new WeakSet<object>();
/** Taken as an ISO 8601 time, as answers give times, or as milliseconds since 1970. */
const time = (description: string) => {
  const schema = { type: ["string", "integer"], description: `${description}: an ISO 8601 time such as 2026-10-15T09:30:00-07:00, or milliseconds since 1970` };
  TIMES.add(schema);
  return schema;
};
const when = {
  description: "When it is: { allDay: true, from, to } with its first and last day as YYYY-MM-DD, or { allDay: false, from, to } with instants in milliseconds since 1970",
  oneOf: [
    { type: "object", properties: { allDay: { const: true }, from: { type: "string" }, to: { type: "string" } }, required: ["allDay", "from", "to"], additionalProperties: false },
    { type: "object", properties: { allDay: { const: false }, from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 } }, required: ["allDay", "from", "to"], additionalProperties: false },
  ],
};

export const TOOLS: Tool[] = [
  {
    name: "list_workspaces",
    description:
      "The workspaces you can reach, each with your member's role in it: admin, editor or viewer, or guest where they aren't a member and were given some notes or folders. You act with your member's role and grants, and no more.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    example: {},
  },
  {
    name: "list_notes",
    description:
      `The notes in a workspace that you can see, newest change first: id, title, folder, revision, when it last changed, and access, which is edit or view: what you may do with that note. A note you can't see is never listed, and reads as no such note everywhere. Narrow it to one folder, to notes with a tag, or to notes whose text changed since a time. The answer is notes, 50 at a time; pass next as offset for more, until it is null. ${LIFE}`,
    inputSchema: object({
      folderId: folderId("Only notes in this folder, from list_folders"),
      updatedSince: time("Only notes whose text or state changed at or after this time. A note trashed since is in list_trash"),
      tag: { type: "string", description: "Only notes with this tag, without the #, ignoring case" },
      includeArchived: archivedToo,
      ...page("notes"),
    }),
    op: "note.list",
    defaults: { limit: 50 },
    pages: "notes",
    example: { workspaceId: WORKSPACE, folderId: FOLDER, updatedSince: "2026-10-01T00:00:00Z" },
  },
  {
    name: "read_note",
    description: "A note's markdown text. Pass revision to read an earlier version. Links in the text are [[id]] or [[id|display text]]: links names each linked note's id with its title and state now, or a null title for a note that doesn't exist, was removed from Trash, or that you can't see. Mentions in the text are @[[id|Name]] or @[[Name]]: mentions names each person once, with member true and their name now for a member of the workspace, and otherwise the name as written. Uploads in the text are ::image{id ...}, ::video{id ...}, ::audio{id} or ::file{id}: uploads names each one's id with its name, type, kind and size, or a null upload for one that doesn't exist or that you can't see. A note in Trash is read as any other, and its state says trashed.",
    inputSchema: object({ noteId, revision: { type: "integer", minimum: 0, description: "An earlier revision; default is the latest" } }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.read",
    example: { noteId: NOTE },
  },
  {
    name: "note_syntax",
    description: syntaxDescription(),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    example: {},
  },
  {
    name: "query_syntax",
    description: "Every form a query can take: of search with scope notes, of list_todos with todos, and of list_uploads with uploads. For todos it also lists every token a todo's line can hold and every rule of every:. It writes nothing.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: [...SCOPES], description: "Whose queries: notes for search, todos for list_todos, uploads for list_uploads" } }, required: ["scope"], additionalProperties: false },
    example: { scope: "todos" },
  },
  {
    name: "create_note",
    description: `${ASK_NOTE_SYNTAX} Make a note with markdown text whose first # heading is its title, in a folder or in Unsorted when none is named. Send the same writeId again after a failed call and the note is created once. ${LINKS} ${MENTIONS} ${TODOS} Needs the editor or admin role.`,
    inputSchema: object({
      text: { type: "string", description: "The note's markdown" },
      folderId: folderId("The folder to put it in, from list_folders; default is Unsorted"),
      linkTitles,
      mentionNames,
      writeId: { type: "string", maxLength: 64, description: "Any unique string, to make a retry return the note from the first call" },
    }),
    op: "note.create",
    example: { text: "# Plan\n\nSee [[Budget]].", folderId: FOLDER },
  },
  {
    name: "write_note",
    description:
      `${ASK_NOTE_SYNTAX} To change some lines and leave the rest, use edit_note. Replace a note's text. Give the revision you read as baseRevision: edits made since then are merged in, not overwritten. Send the same writeId again after a failed call and the write is recorded once. ${LINKS} ${MENTIONS} Checking the box of a repeating todo here completes it as set_todo does: the answer has the line open again with its next due date, and filed says where the checked line went. Needs the editor or admin role. The change is recorded under your agent's name.`,
    inputSchema: object(
      {
        noteId,
        baseRevision: { type: "integer", minimum: 0, description: "The revision your text is based on" },
        text: { type: "string", description: "The note's full new markdown" },
        writeId: { type: "string", maxLength: 64, description: "Any unique string, to make a retry safe" },
        linkTitles,
        mentionNames,
        on: day("The day it is for you, which a repeating todo checked off is completed on and filed under. Left out, it is today in the time zone your member's settings name, or in UTC"),
      },
      ["noteId", "baseRevision", "text"],
    ),
    renames: { noteId: "id" },
    op: "note.write",
    example: { noteId: NOTE, baseRevision: 3, text: "# Plan\n\nStep one\nStep two" },
  },
  {
    name: "edit_note",
    description:
      `Change lines of a note and leave the rest. Give the revision you read as baseRevision. Each edit replaces the lines from its from up to and not including its to, counted from 0 in the note at that revision: from equal to to inserts, and an empty text deletes. A newline after the note's last line is not a line of its own. Every range is counted in that revision, so one edit is not shifted by another, and two that overlap are refused. There may be 50 edits. Edits made since baseRevision are merged in, as write_note merges them, and a line you left out is left as it was. Send the same writeId again after a failed call and the edit is recorded once. ${LINKS} ${MENTIONS} Checking the box of a repeating todo here completes it as set_todo does: the answer has the line open again with its next due date, and filed says where the checked line went. Needs the editor or admin role. The change is recorded under your agent's name.`,
    inputSchema: object(
      {
        noteId,
        baseRevision: { type: "integer", minimum: 0, description: "The revision you read. Line numbers are counted in the note as it was then" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "The lines to change, each counted in the note at baseRevision",
          items: {
            type: "object",
            properties: {
              from: { type: "integer", minimum: 0, description: "The first line to replace, counted from 0. Equal to to inserts there" },
              to: { type: "integer", minimum: 0, description: "The line to stop before. One past the last line adds after it" },
              text: { type: "string", description: "The lines to put there. Empty deletes. A newline after the last of them is not kept" },
            },
            required: ["from", "to", "text"],
            additionalProperties: false,
          },
        },
        writeId: { type: "string", maxLength: 64, description: "Any unique string, to make a retry safe" },
        linkTitles,
        mentionNames,
        on: day("The day it is for you, which a repeating todo checked off is completed on and filed under. Left out, it is today in the time zone your member's settings name, or in UTC"),
      },
      ["noteId", "baseRevision", "edits"],
    ),
    renames: { noteId: "id" },
    op: "note.edit",
    example: { noteId: NOTE, baseRevision: 3, edits: [{ from: 1, to: 2, text: "Step one, revised" }] },
  },
  {
    name: "backlinks",
    description: "The notes whose text links to a note, latest change first, each as list_notes gives it. Only notes you can see are listed.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.backlinks",
    example: { noteId: NOTE },
  },
  {
    name: "rebuild_links",
    description: "Make what is derived from the notes' text again, for every note in the workspace: the record behind backlinks, and the index behind list_todos. Every write keeps them, so this is only for a record that was changed some other way. It covers so many notes a call: while the answer's done is false, call again. Needs the admin role.",
    inputSchema: object({}),
    op: "links.rebuild",
    example: {},
  },
  {
    name: "list_todos",
    description: `The todos in the notes you can see that query finds: with no query, every open one. Open ones come first, then the soonest due, then the highest priority, unless the query's sort: or sort says otherwise. Each has its note, the revision the note was at, its line counted from 0 and the line's text, which set_todo takes to find it, and its done, importance (its priority, 0 for None to 3 for High), due, assignees, the note's tags, and access. Due days are calendar dates. While next isn't null, pass it as offset for more. A query is filters and words, such as: due:<today priority:>=medium -tag:someday, assignee:@me, is:done, or: call folder:"Common Ink". query_syntax {"scope":"todos"} lists every form, and every token a todo's line can hold. The arguments beside query are from before it could say them, and narrow it further.`,
    inputSchema: object({
      query: { type: "string", maxLength: MAX_SEARCH_LENGTH, description: 'Which todos, such as: due:<today priority:>=medium -tag:someday, or: call folder:"Common Ink" is:open OR is:done' },
      ...queryDays,
      folderId: { type: "string", description: "Only todos in notes in this folder or in a folder under it, from list_folders. In the query: folder:" },
      tag: { type: "string", description: "Only todos in notes with this tag, without the #, ignoring case: a tag on the todo's own line, or anywhere else in its note. In the query: tag:" },
      dueFrom: day("Only todos due on or after this day. In the query: due:>="),
      dueTo: day("Only todos due on or before this day. In the query: due:<="),
      noDue: { type: "boolean", description: "True for only todos with no due date. In the query: no:due" },
      importance: { type: "array", items: { type: "integer", minimum: 0, maximum: 3 }, minItems: 1, description: "Only these priorities: 0 is None, 1 Low (!), 2 Medium (!!), 3 High (!!!). In the query: priority:" },
      assignee: { type: "string", description: "Only todos assigned to this person: a member's id from list_members, or anyone else's name as the todo writes it, ignoring case. In the query: assignee:" },
      assignedToMe: { type: "boolean", description: "True for only todos assigned to your member. In the query: assignee:@me" },
      includeCompleted: { type: "boolean", description: "True to list done todos too. In the query: is:open OR is:done" },
      includeArchived,
      noteId: { type: "string", description: "Only the todos in this note" },
      sort: { type: "string", enum: [...TODO_SORTS], description: "The order, when the query has no sort:, the done ones always after the open ones: due (the default) the soonest due, then the highest priority; priority the highest first, then the soonest due; changed those whose note changed last first; note by their note's title; text by their words, A to Z" },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "How many todos; default 100" },
      offset: { type: "integer", minimum: 0, description: "Where the page starts: next, from the page before" },
    }),
    op: "todo.list",
    example: { dueTo: "2026-10-14", sort: "priority" },
  },
  {
    name: "todo_filters",
    description: "What list_todos can be narrowed by: the tags of the notes that have todos and who todos are assigned to, among the notes you can see. The folders it can be narrowed by are list_folders'.",
    inputSchema: object({ includeArchived }),
    op: "todo.filters",
    example: {},
  },
  {
    name: "set_todo",
    description:
      "Check a todo off, skip it, or change its priority, due date, how it repeats, who it is assigned to or its words, by rewriting its line in its note. Checking off a todo that repeats leaves it open with its next due date and a done: mark, and files the checked line on your member's daily note for the day: the answer's filed says which day and note. A rule that ends (-times-N, -until-DAY) counts down, and its last time checks the todo off for good. skip moves a repeating todo to its next due date with nothing checked off, and is refused for one that doesn't repeat or is on its last time. Undoing or reverting that change takes the filed line off the daily note again. Pass id, revision, line and text as list_todos gave them. The line is followed through every change made to the note since that revision, so it is found where it has moved to and no other todo is taken for it, even one that reads the same. The call is refused as a conflict when that line was itself changed or deleted, so list again. Made twice, it changes nothing more. Whatever you leave out stays as written. Needs edit on the note. The change is recorded under your agent's name.",
    inputSchema: object(
      {
        noteId,
        revision: { type: "integer", minimum: 0, description: "The revision of the note the todo was listed at, from list_todos" },
        line: { type: "integer", minimum: 0, description: "The todo's line, from list_todos" },
        text: { type: "string", description: "The todo's line as written, from list_todos" },
        done: { type: "boolean", description: "True checks it off, false opens it again" },
        importance: { type: "integer", minimum: 0, maximum: 3, description: "Its priority: 0 for None, 1 Low (!), 2 Medium (!!), 3 High (!!!)" },
        due: { type: ["string", "null"], description: "The day it is due as YYYY-MM-DD, or null for no due date" },
        every: { type: ["string", "null"], description: 'How it repeats, as written after every:, such as 2w, mon,thu, last-fri or 1m-times-5, or null to stop it repeating. query_syntax {"scope":"todos"} lists every rule' },
        skip: { type: "boolean", description: "True moves a repeating todo's due date to its next one with nothing checked off or filed. It counts as one of a rule's -times-N. Not together with done" },
        assign: { type: "string", description: "Someone to assign it to, by writing a mention of them on the line: a member's id or name, or anyone else's name. Assigning gives nobody access and tells nobody." },
        unassign: { type: "string", description: "Someone to take it from: a member's id or name, or anyone else's name as the line writes it. Refused when the todo isn't assigned to them." },
        on: day("The day it is for you, which a repeating todo checked off is completed on and filed under. Left out, it is today in the time zone your member's settings name, or in UTC"),
        words: { type: "string", description: "What the todo says instead, as list_todos gives its words: everything but its checkbox, priority, due date, rule and done: mark, tags included, on one line. Its due date and how it repeats are written after them" },
      },
      ["noteId", "revision", "line", "text"],
    ),
    renames: { noteId: "id" },
    op: "todo.set",
    example: { noteId: NOTE, revision: 4, line: 2, text: "- [ ] Call the bank due:2026-10-14", done: true },
  },
  {
    name: "todo_history",
    description: "Each time a repeating todo was checked off, latest first: the day, who did it, and the daily note it was filed on when you can see that note. Pass id, revision, line and text as list_todos gave them.",
    inputSchema: object({ noteId, revision: { type: "integer", minimum: 0, description: "The revision of the note, from list_todos" }, line: { type: "integer", minimum: 0, description: "The todo's line, from list_todos" }, text: { type: "string", description: "The todo's line as written, from list_todos" } }, ["noteId", "revision", "line", "text"]),
    renames: { noteId: "id" },
    op: "todo.history",
    example: { noteId: NOTE, revision: 4, line: 2, text: "- [ ] Water the plants every:1w" },
  },
  {
    name: "daily_note",
    description: "Your member's daily note for a day: found, or made with the date as its heading in the folder their settings name. A member has one for each day, and it is where a repeating todo they or you check off is filed. Needs the editor or admin role.",
    inputSchema: object({ on: day("The day. Left out, it is today in the time zone your member's settings name, or in UTC") }),
    op: "daily.open",
    example: { on: "2026-10-15" },
  },
  {
    name: "find_daily_note",
    description: "Your member's daily note for a day, as list_notes gives it, when there is one: nothing is made. The answer's note is null when they have none for that day.",
    inputSchema: object({ on: day("The day. Left out, it is today in the time zone your member's settings name, or in UTC") }),
    op: "daily.find",
    example: { on: "2026-10-15" },
  },
  {
    name: "list_pins",
    description: "The notes your member pinned to their dashboard, earliest pinned first, each as list_notes gives it: the ones they can see now that are live, and the archived ones too with includeArchived, which stay pinned and are off the dashboard until unarchived. A pin on a note in Trash, or on one your member can't see now, is not listed and is back when the note is. A pin is the member's alone, and is not written in the note.",
    inputSchema: object({ includeArchived }),
    op: "pin.list",
    example: {},
  },
  {
    name: "pin_note",
    description: "Pin a note to your member's dashboard, or with pinned false take the pin away. Nobody else is told and the note doesn't change, so it isn't a change in history. Made twice, it changes nothing more. Needs only that your member can see the note. A read-only token is refused.",
    inputSchema: object({ noteId, pinned: { type: "boolean", description: "True pins it, false takes the pin away" } }, ["noteId", "pinned"]),
    renames: { noteId: "id" },
    op: "pin.set",
    example: { noteId: NOTE, pinned: true },
  },
  {
    name: "last_visit",
    description: "How far your member has read the changes in the workspace: readUntil is the time up to which they marked the changes on their dashboard read, or null when they never have, and now is the server's time. For what they haven't read, call history with from set to readUntil and notAuthors naming your member. Only the member marks changes read.",
    inputSchema: object({}),
    op: "visit.read",
    example: {},
    times: ["now"],
  },
  {
    name: "rebuild_todos",
    description: "The same as rebuild_links: makes the index behind list_todos and the record behind backlinks again from the notes' text, for every note in the workspace. Notes written before there was an index are indexed without it, the first time todos are listed. While the answer's done is false, call again. Needs the admin role.",
    inputSchema: object({}),
    op: "todos.rebuild",
    example: {},
  },
  {
    name: "move_note",
    description: "Put a note in another folder. Its id and text stay the same. Needs the editor or admin role.",
    inputSchema: object({ noteId, folderId: folderId("The folder to move it to, from list_folders") }, ["noteId", "folderId"]),
    renames: { noteId: "id" },
    op: "note.move",
    example: { noteId: NOTE, folderId: FOLDER },
  },
  {
    name: "search",
    description: `Find the notes you can see with a query: words, each matching the start of a word in the note, ignoring case and accents, and filters. Todos and tags are text like any other, so their words are found too. A query with no word and no filter finds nothing: list_notes lists. Notes whose title matches come first, then the latest changed, unless the query's sort: or else sort asks for another order. Each result has the note as list_notes gives it and the first lines that matched, with marks saying where in each line. Archived notes are left out unless the query says is:archived, and notes in Trash unless it says is:trashed. While next isn't null, pass it as offset for more. While indexing is true, some notes are still being read into the index and may be missing: ask again. A query is words and filters, such as: budget "second quarter" #money -is:archived, folder:"Common Ink" editor:@me updated:>=7d, or: has:open-todo OR has:backlink. query_syntax {"scope":"notes"} lists every form. The arguments beside query are from before it could say them, and narrow it further.`,
    inputSchema: object(
      {
        query: { type: "string", maxLength: MAX_SEARCH_LENGTH, description: 'What to find, such as: budget "second quarter" #money -is:archived, or: editor:@me updated:>=7d (has:open-todo OR has:backlink)' },
        ...queryDays,
        folderId: folderId("Only notes in this folder, not those of the folders inside it, from list_folders. In the query, folder: takes the folders inside too"),
        includeArchived: archivedToo,
        hasTodos: { type: "boolean", description: "True for only the notes with an open todo. In the query: has:open-todo" },
        sort: { enum: ["match", "recent", "created", "title"], description: "match, the default: title matches first, then the latest changed. recent: the latest changed. created: the latest made. title: by title. The query's sort: wins over it" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many notes; default 20" },
        offset: { type: "integer", minimum: 0, description: "Where the page starts: next, from the page before" },
      },
      ["query"],
    ),
    op: "search",
    example: { query: 'budget #money updated:>=7d', today: "2026-10-15" },
  },
  {
    name: "list_tags",
    description: "The tags of the notes you can see, each with how many of those notes have it. A #tag anywhere in a note tags the note. list_notes with tag lists the notes under one. While indexing is true, some notes are still being read in: ask again.",
    inputSchema: object({ includeArchived }),
    op: "tag.list",
    example: {},
  },
  {
    name: "archive_note",
    description: "Archive a note, or with archived false bring it back. An archived note keeps its folder, id and links, and is left out of listings, search and todos unless they are asked to include archived notes. Needs edit on the note.",
    inputSchema: object({ noteId, archived: { type: "boolean", description: "True to archive, false to unarchive" } }, ["noteId", "archived"]),
    renames: { noteId: "id" },
    op: "note.archive",
    example: { noteId: NOTE, archived: true },
  },
  {
    name: "trash_note",
    description: "Move a note to Trash. It waits there 30 days, listed by list_trash, and is then removed for good with its history. Until then restore_note brings it back as it was. A link shared on it opens nothing while it is there. Needs edit on the note.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.trash",
    example: { noteId: NOTE },
  },
  {
    name: "restore_note",
    description: "Bring a note back from Trash to the folder it was in, archived if it was. When that folder was deleted meanwhile it comes back to Unsorted and folderGone is true, which also needs edit on Unsorted. Needs edit on the note.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.restore",
    example: { noteId: NOTE },
  },
  {
    name: "list_trash",
    description: "The notes in Trash that you can see, latest trashed first: each as list_notes gives it, with who trashed it and when, and purgesAt, the time it is removed for good. An agent can't remove one sooner; a member does that in the app.",
    inputSchema: object({}),
    op: "trash.list",
    example: {},
  },
  {
    name: "list_uploads",
    description: `The uploads you can see that query finds, latest uploaded first unless its sort: says otherwise: with no query, every live one. Each has its id, name, type, which is what its bytes are served as, kind (image, video, audio or file), size in bytes, width and height for an image whose bytes say them, folder, who uploaded it, private, state, access, which is edit or view, and uses: how many notes you can see show it. An upload you can't see is never listed or counted, and reads as no such upload everywhere. Archived uploads are left out unless the query says is:archived, and those in Trash unless it says is:trashed. The answer is uploads, 50 at a time; pass next as offset for more, until it is null. ${UPLOADS} A query is filters and words, such as: type:image uploader:@me, size:>1mb used:no -type:video, or: name:report uploaded:>=7d. query_syntax {"scope":"uploads"} lists every form. The arguments beside query are from before it could say them, and narrow it further.`,
    inputSchema: object({
      query: { type: "string", maxLength: MAX_SEARCH_LENGTH, description: "Which uploads, such as: type:image uploader:@me, or: size:>1mb used:no -type:video" },
      ...queryDays,
      folderId: folderId("Only uploads in this folder, not those of the folders inside it, from list_folders. In the query, folder: takes the folders inside too"),
      includeArchived: { type: "boolean", description: "True to cover archived uploads too, which are left out otherwise. In the query: is:archived" },
      ...page("uploads"),
    }),
    op: "upload.list",
    defaults: { limit: 50 },
    pages: "uploads",
    example: { query: 'type:image uploader:@me' },
  },
  {
    name: "read_upload",
    description: `One upload as list_uploads gives it, and usedIn: the notes you can see that refer to it, each as list_notes gives it. An upload in Trash is read as any other, and its state says trashed. ${UPLOADS}`,
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.read",
    example: { uploadId: UPLOAD },
  },
  {
    name: "move_upload",
    description: "Put an upload in another folder. Its id stays the same, so the notes that refer to it still show it. Needs edit on the upload and on the folder.",
    inputSchema: object({ uploadId, folderId: folderId("The folder to move it to, from list_folders") }, ["uploadId", "folderId"]),
    renames: { uploadId: "id" },
    op: "upload.move",
    example: { uploadId: UPLOAD, folderId: FOLDER },
  },
  {
    name: "place_upload",
    description: "Put an upload you can see in a note, before you write its embed in the note's text with write_note: it writes nothing itself. An upload private to your member, seen by nobody else, is refused: only your member can let others see it, in the app. In a private note it stays private and is placed. An upload that isn't private is left where it is. Made twice, it changes nothing more. Needs edit on the upload and on the note. The answer is the upload as it now is.",
    inputSchema: object({ uploadId, noteId: { type: "string", description: "The note it is put in" } }, ["uploadId", "noteId"]),
    renames: { uploadId: "id" },
    op: "upload.place",
    example: { uploadId: UPLOAD, noteId: NOTE },
  },
  {
    name: "archive_upload",
    description: "Archive an upload, or with archived false bring it back. An archived upload keeps its folder and id, is left out of list_uploads unless includeArchived is true, and is still shown by the notes that refer to it. Needs edit on the upload.",
    inputSchema: object({ uploadId, archived: { type: "boolean", description: "True to archive, false to unarchive" } }, ["uploadId", "archived"]),
    renames: { uploadId: "id" },
    op: "upload.archive",
    example: { uploadId: UPLOAD, archived: true },
  },
  {
    name: "trash_upload",
    description: "Move an upload to Trash. It waits there 30 days, listed by list_trashed_uploads, and is then removed for good with its bytes. Until then restore_upload brings it back as it was. The answer's usedIn is how many notes you can see refer to it: each says the upload is in Trash until it is restored. Needs edit on the upload.",
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.trash",
    example: { uploadId: UPLOAD },
  },
  {
    name: "restore_upload",
    description: "Bring an upload back from Trash to the folder it was in, archived if it was, and to every note that refers to it. When that folder was deleted meanwhile it comes back to Unsorted and folderGone is true, which also needs edit on Unsorted. Needs edit on the upload.",
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.restore",
    example: { uploadId: UPLOAD },
  },
  {
    name: "start_upload",
    description: `Begin sending a file of size bytes, at most ${MAX_UPLOAD_BYTES / 1024 ** 3} GB, in parts that your own shell sends with curl, so the bytes never pass through you. The answer is id, partSize, partCount, address and expiresAt. Part n is the bytes from (n-1)*partSize, partSize of them (the last part what is left); send it with: dd if=FILE bs=1048576 skip=$(( (n-1)*${PART_BYTES / 1024 / 1024} )) count=${PART_BYTES / 1024 / 1024} status=none | curl -sS --fail-with-body -X PUT -H 'Content-Type: application/octet-stream' --data-binary @- "<address with {part} replaced by n>". Parts may go several at once, in any order. The address needs no token, takes each part once, and lapses at expiresAt (an hour). A part that fails, or an address that lapsed or answers 409, is no loss: resume_upload says which parts are stored and gives a fresh address for the rest. Then finish_upload. Until it is finished the file is seen by no one and listed nowhere; one nothing is sent to for a day is thrown away. Needs edit on the folder.`,
    inputSchema: object(
      {
        name: { type: "string", maxLength: 1000, description: "The file's name, with its ending, such as episode-12.mp3. What it is served as is read from the ending and its first bytes" },
        size: { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES, description: "How many bytes the file is, exactly: wc -c < FILE. A part of any other length is refused" },
        folderId: folderId("The folder to put it in, from list_folders. Left out, Unsorted"),
        private: { type: "boolean", description: "Leave it out: only a member makes an upload private, in the app, and an agent asking is refused" },
      },
      ["name", "size"],
    ),
    op: "upload.start",
    example: { name: "episode-12.mp3", size: 52428800, folderId: FOLDER },
    times: ["expiresAt"],
    told: (sending: SendingUpload, origin: string) => ({ ...sending, address: `${origin}${sending.address}` }),
  },
  {
    name: "resume_upload",
    description: "For a file start_upload began and you haven't finished: stored, the numbers of the parts that are there, and a fresh address and expiresAt for the rest, as start_upload answers. Only the one who started it can ask.",
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.resume",
    example: { uploadId: UPLOAD },
    times: ["expiresAt"],
    told: (sending: SendingUpload, origin: string) => ({ ...sending, address: `${origin}${sending.address}` }),
  },
  {
    name: "finish_upload",
    description: `Put a file's parts together once every one is stored, and make it an upload others can see, held to the size start_upload was told. The answer is the upload as list_uploads gives it, and line: the embed to write in a note on a line of its own. Asked again, it answers the same. ${UPLOADS}`,
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.finish",
    example: { uploadId: UPLOAD },
    told: withLine,
  },
  {
    name: "abort_upload",
    description: "Stop sending a file start_upload began, and throw away the parts sent. Only the one who started it can.",
    inputSchema: object({ uploadId }, ["uploadId"]),
    renames: { uploadId: "id" },
    op: "upload.abort",
    example: { uploadId: UPLOAD },
  },
  {
    name: "upload_file",
    description: `Upload a small file you hold, of at most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB, as base64. A larger one, or one on disk, goes with start_upload, whose bytes never pass through you. The answer is the upload and line, the embed to write in a note. Needs edit on the folder.`,
    inputSchema: object(
      {
        name: { type: "string", maxLength: 1000, description: "The file's name, with its ending" },
        base64: { type: "string", maxLength: Math.ceil(MAX_INLINE_UPLOAD_BYTES / 3) * 4, description: "The file's bytes, in base64" },
        folderId: folderId("The folder to put it in, from list_folders. Left out, Unsorted"),
      },
      ["name", "base64"],
    ),
    example: { name: "notes.txt", base64: "SGVsbG8=", folderId: FOLDER },
  },
  {
    name: "list_trashed_uploads",
    description: "The uploads in Trash that you can see, latest trashed first: each as list_uploads gives it, with who trashed it and when, and purgesAt, the time it is removed for good. An agent can't remove one sooner; a member does that in the app.",
    inputSchema: object({}),
    op: "upload.trashed",
    example: {},
  },
  {
    name: "list_folders",
    description:
      "The folders in a workspace: id, name, path (its name after those of the folders it is in, such as Projects/Skills), the folder each is inside (parentId), and how many notes and uploads are directly in it. unsortedId is the folder a note goes to when none is named.",
    inputSchema: object({}),
    op: "folder.list",
    example: { workspaceId: WORKSPACE },
  },
  {
    name: "find_folder",
    description:
      "The folder at a path, such as Projects/Skills: each folder's name after those of the folders it is in, from the top, as list_folders gives it. Names match ignoring case, and then ignoring accents too, so projects/skills finds Projects/Skills. Answers as list_folders lists a folder, or not_found: No such folder.",
    inputSchema: object({ path: { type: "string", maxLength: 1000, description: "The folder's path, its names separated by /" } }, ["path"]),
    op: "folder.find",
    example: { path: "Projects/Skills" },
  },
  {
    name: "create_folder",
    description:
      'Make a folder, inside another when parentId is given. No two folders in one place have names that differ only in case: when there is one already, the answer is that folder with created false, or with ifExists "error" a refusal. A folder made has created true. Needs the editor or admin role.',
    inputSchema: object(
      {
        name: folderName,
        parentId: folderId("The folder to make it inside, from list_folders or find_folder; default is the top level"),
        ifExists: { type: "string", enum: ["return", "error"], default: "return", description: 'When a folder of that name, ignoring case, is there already: "return", the default, answers with it; "error" refuses' },
      },
      ["name"],
    ),
    defaults: { ifExists: "return" },
    op: "folder.create",
    example: { name: "Skills", parentId: FOLDER },
  },
  {
    name: "rename_folder",
    description: "Give a folder another name. Unsorted can't be renamed, and a name another folder beside it has, ignoring case, is refused. Needs the editor or admin role.",
    inputSchema: object({ folderId: folderId("The folder id"), name: folderName }, ["folderId", "name"]),
    renames: { folderId: "id" },
    op: "folder.rename",
    example: { folderId: FOLDER, name: "Plans" },
  },
  {
    name: "move_folder",
    description:
      "Put a folder inside another, or at the top level with a null parentId. The notes and folders in it go with it and keep their ids. A folder can't go inside itself or a folder in it, and Unsorted stays where it is. Needs the editor or admin role, and edit on both folders.",
    inputSchema: object({ folderId: folderId("The folder to move"), parentId: { type: ["string", "null"], description: "The folder to put it inside, from list_folders, or null for the top level" } }, ["folderId", "parentId"]),
    renames: { folderId: "id" },
    op: "folder.move",
    example: { folderId: FOLDER, parentId: null },
  },
  {
    name: "delete_folder",
    description: "Delete a folder that has no notes and no folders in it. Archived notes count, and notes in Trash don't: those are restored to Unsorted afterwards. Needs the admin role.",
    inputSchema: object({ folderId: folderId("The folder id") }, ["folderId"]),
    renames: { folderId: "id" },
    op: "folder.delete",
    example: { folderId: FOLDER },
  },
  {
    name: "note_history",
    description:
      "A note's recorded changes, oldest first: revision, the revision it was based on, who made it (a member, or an agent by name), when, its label, the lines it added and removed, the changes it reverted (reverts) and the later change that reverted it (revertedBy).",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.history",
    example: { noteId: NOTE },
  },
  {
    name: "note_blame",
    description:
      "Who wrote each line of a note as it is now: the change that last wrote or edited the line. Answers the note's text and revision, lines as runs { from, to, revision } counted from 1, the changes those name (each with its author, a member or an agent by name, and when), and for a member who sees the whole workspace the name of each member whose agent wrote a line (owners, by person id). Lines put in or taken out around a line don't change it; a word taken out of it does. A line a revert brought back is named by the change that wrote it, not the revert.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.blame",
    example: { noteId: NOTE },
  },
  {
    name: "change_diff",
    description: "What one change did to its note, as a line diff: hunks of added, removed and unchanged lines, with the lines it added and removed counted.",
    inputSchema: object({ noteId, revision: { type: "integer", minimum: 1, description: "The change, by the revision it made" } }, ["noteId", "revision"]),
    renames: { noteId: "id" },
    op: "note.diff",
    example: { noteId: NOTE, revision: 2 },
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
    example: { from: "2026-10-01T00:00:00Z", by: "agents" },
  },
  {
    name: "history",
    description:
      "Changes across the workspace, newest first, each with its note, author, the lines it added and removed, and a line diff. Narrow it by noteIds (one note, several, or all when left out), authors (from history_authors), notAuthors to leave some out, and a time range. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: noteIds("Only these notes"),
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
      notAuthors: { type: "array", items: author, minItems: 1, description: "Leave out changes by these members or agents" },
      by,
      from: time("Changes made at or after this time"),
      to: time("Changes made before this time"),
      before: { type: "object", description: "The next of the page before" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many changes; default 50" },
      diffs: { type: "boolean", description: "False leaves the diffs out" },
    }),
    op: "history.list",
    example: { noteIds: [NOTE], limit: 10 },
  },
  {
    name: "history_authors",
    description: "Everyone who has changed a note in the workspace: members by person id and agents by agent id, each with a name.",
    inputSchema: object({}),
    op: "history.authors",
    example: {},
  },
  {
    name: "history_diff",
    description:
      "What a selection of changes did, note by note, across up to 40 notes. A note's selected changes that follow one another are one run with one line diff, from the note before the first of them to the note after the last, so a line written and taken out again within a run shows in neither. A change left out in between starts a new run, which says how many were skipped. Each run has its revisions (from, to), how many changes it is (saves), who made them, when, and the lines it added and removed. An answer holds about 2000 diff lines: a run past them has diff null, and asking for its note alone returns it. A run's diff shows at most 200 lines and counts the rest in omitted.",
    inputSchema: object({ changes: selected({ revisions }, ["revisions"], "The selection: each note once, with the revisions of its changes") }, ["changes"]),
    op: "history.diff",
    example: { changes: [{ noteId: NOTE, revisions: [2, 3] }] },
  },
  {
    name: "preview_reverts",
    description:
      "What revert_many would do to each note, with nothing written: for each, the note's revision it was worked out at (pass it back as at), the changes that would be reverted (revisions), the ones left out because something already reverted them (already), the diff from the note as it is to the note after, and its conflicts as preview_revert lists them. A change selected together with the change that reverted it stays reverted and that revert goes too. An empty diff means the note would not change.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: "history.previewRevert",
    example: { changes: [{ noteId: NOTE, revisions: [2] }] },
  },
  {
    name: "revert_many",
    description:
      "Revert changes of up to 40 notes at once, each note as one new change under your agent's name. Each note is reverted or skipped whole, by itself: the answer lists reverted (each with the revision the revert made and the changes it reverted) and skipped (each with why: changed, when the note is no longer at the revision passed as at; nothing, when the revert would change nothing; refused, with the reason). Call preview_reverts first and pass each note's revision back as at. To undo a revert, revert the revision it made, with at set to that revision: the note is skipped if it has been changed since. Needs the editor or admin role.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: "history.revert",
    example: { changes: [{ noteId: NOTE, revisions: [2], at: 5 }] },
  },
  {
    name: "label_revision",
    description: "Name one revision of a note, so it can be found and reverted to. A null name takes the label away. Needs the editor or admin role.",
    inputSchema: object({ noteId, revision: { type: "integer", minimum: 1 }, name: { type: ["string", "null"], maxLength: 60 } }, ["noteId", "revision", "name"]),
    renames: { noteId: "id" },
    op: "note.label",
    example: { noteId: NOTE, revision: 2, name: "Draft" },
  },
  {
    name: "revert_note",
    description:
      "Put a note back to how it was at a revision. This is recorded as a new change under your agent's name; nothing is erased. Call preview_revert first; if it lists conflicts, pass resolve to settle them. Needs the editor or admin role.",
    inputSchema: object({ noteId, revision: { type: "integer", minimum: 0, description: "The revision to return to" }, resolve }, ["noteId", "revision"]),
    renames: { noteId: "id" },
    op: "note.revert",
    example: { noteId: NOTE, revision: 2 },
  },
  {
    name: "revert_changes",
    description:
      "Revert chosen changes of a note and keep every other change, recorded as one new change under your agent's name. History only goes forward: to have a reverted change again, revert the change that reverted it (its revertedBy). Call preview_revert first; if it lists conflicts, pass resolve to settle them, or the later edits are kept. Needs the editor or admin role.",
    inputSchema: object({ noteId, revisions, resolve }, ["noteId", "revisions"]),
    renames: { noteId: "id" },
    op: "note.revertChanges",
    example: { noteId: NOTE, revisions: [3] },
  },
  {
    name: "revert_author",
    description:
      "Revert every change one author made that still stands, in every note or in noteIds, and keep everyone else's. Each note gets one new change under your agent's name. It covers ten notes a call: while the answer's next isn't null, call again with it as after. A note that refuses the change is left as it was and named in failed. To settle a note's conflicts, preview_revert it with author first and pass resolve; without it the later edits are kept. A note left with no text, such as one the author created, is named in emptied, and with trashEmptied it is moved to Trash, where restore_note finds it. Notes in Trash are not reverted. Needs the editor or admin role.",
    inputSchema: object({ author: { ...author, description: "Whose changes, from history_authors" }, noteIds: noteIds("Only in these notes"), after: { type: "string", description: "The next of the call before" }, resolve: resolveByNote, trashEmptied: { type: "boolean", description: "True to move each note this leaves with no text to Trash" } }, ["author"]),
    op: "history.revertAuthor",
    example: { author: { kind: "agent", id: AGENT } },
  },
  {
    name: "preview_revert",
    description:
      "What a revert would do to a note, with nothing written. Pass one of: revisions to preview revert_changes of those changes, to to preview revert_note to that revision, or author to preview what revert_author would do to this note. Returns the note's revision it was worked out at, the changes that would be reverted (revisions), the diff from the note as it is to the note after (diff), overlaps: later changes that still stand and edited the same lines, and conflicts: each place they did, top of the note first, with the lines as they were before the reverted changes (before), as they are now (now), as the revert leaves them with the later edits kept (kept), the line of the result kept starts at (line), and the later changes that edited them with their authors (later). Settle each conflict with resolve on the revert; pass the same resolve here to see the diff of the revert settled that way. A read-only token can use it.",
    inputSchema: object({ noteId, revisions, to: { type: "integer", minimum: 0, description: "The revision to return to" }, author: { ...author, description: "Whose changes, from history_authors" }, resolve }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.previewRevert",
    example: { noteId: NOTE, revisions: [3] },
  },
  {
    name: "undo",
    description: "Take back your own latest change to a note that still stands, as a new change. Other authors' changes are kept. Needs the editor or admin role.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.undo",
    example: { noteId: NOTE },
  },
  {
    name: "redo",
    description: "Revert your latest undo on a note, as a new change, so what it undid stands again. Needs the editor or admin role.",
    inputSchema: object({ noteId }, ["noteId"]),
    renames: { noteId: "id" },
    op: "note.redo",
    example: { noteId: NOTE },
  },
  {
    name: "list_sources",
    description:
      `Your member's data sources: their calendar and their contacts, each with its id, kind (calendar or contacts), state (connected, needs_reconnect or not_connected) and writable, which is false for a read-only data source. ${SOURCES} You can't connect or disconnect one: the member does that in the app, on the Calendar or Contacts page.`,
    inputSchema: object({}),
    op: "source.list",
    example: {},
  },
  {
    name: "list_events",
    description:
      `Your member's calendar events in a span of time of at most 400 days, soonest first, each occurrence of a recurring event on its own. An event's when is either two instants in milliseconds since 1970 (allDay false) or its first and last day as YYYY-MM-DD (allDay true), which has no time and no zone. An all-day event is in the span when one of its days is a day the span covers in timeZone. Each event's calendarId is the calendar it is in. sources says whether each calendar data source answered: one in needs_reconnect has no events here until the member reconnects it. calendars is every calendar in the connected ones, with or without events in the span, each with its sourceId, id, name, color and writable; create_event adds to one whose writable is true. ${SOURCES}`,
    inputSchema: object({ from: time("The start of the span"), to: time("The end of the span"), timeZone: { type: "string", description: 'The IANA zone whose days all-day events are matched by, such as "America/Chicago"' } }, ["from", "to", "timeZone"]),
    op: "event.list",
    example: { from: "2026-10-12T00:00:00-07:00", to: "2026-10-19T00:00:00-07:00", timeZone: "America/Los_Angeles" },
  },
  {
    name: "update_event",
    description:
      `Change one of your member's events where it is kept, such as in Google Calendar, as your member. Pass the event's sourceId, id and etag from list_events: the change is refused if the event has changed there since, and you read it again. Only the fields you pass change. For one occurrence of a recurring event, only that occurrence changes. An event whose editable is false, and any event in a data source whose writable is false, is refused. This changes the member's real calendar and is not in Common Ink's history, so it can't be reverted from here. ${SOURCES}`,
    inputSchema: object(
      {
        sourceId: { type: "string", description: "The data source the event is in, from list_events" },
        id: { type: "string", description: "The event's id, from list_events" },
        etag: { type: "string", description: "The event's etag as you read it" },
        title: { type: "string", maxLength: 1000 },
        location: { type: "string", maxLength: 1000 },
        description: { type: "string", maxLength: 8000 },
        when,
      },
      ["sourceId", "id", "etag"],
    ),
    op: "event.update",
    example: { sourceId: "google", id: "evt123", etag: '"3341"', title: "Lunch with Sam" },
  },
  {
    name: "create_event",
    description:
      `Add an event to one of your member's calendars where it is kept, such as in Google Calendar, as your member. Pass the calendar's sourceId and id from the calendars list_events answers: one whose writable is false is refused. Pass neither to add it to your member's default calendar, the one they chose on the Calendar page; when they chose none, or can no longer add to it, it goes in the first calendar they can add to and haven't hidden. Answers the event as it was made, with the calendarId and calendar it went in. This changes the member's real calendar and is not in Common Ink's history, so it can't be reverted from here. ${SOURCES}`,
    inputSchema: object(
      {
        sourceId: { type: "string", description: "The data source the calendar is in, from list_events' calendars. Leave it out, with calendarId, for your member's default calendar" },
        calendarId: { type: "string", description: "The calendar's id, from list_events' calendars. Leave it out, with sourceId, for your member's default calendar" },
        title: { type: "string", maxLength: 1000 },
        when,
        location: { type: "string", maxLength: 1000 },
        description: { type: "string", maxLength: 8000 },
      },
      ["title", "when"],
    ),
    op: "event.create",
    example: { sourceId: "google", calendarId: "primary", title: "Lunch", when: { allDay: true, from: "2026-10-14", to: "2026-10-14" } },
  },
  {
    name: "list_contacts",
    description: `Your member's contacts by name: id, name, emails, phones and organization. Each email, phone, address and website is { value, type }: type is the label, Google's own (an email's home, work or other; a phone's mobile, home, work, main, homeFax, workFax, pager or other; an address's home, work or other; a website's homePage, work, blog, profile or other), one your member wrote, as written, or null for none. query keeps those with every word of it at the start of a word of their name, email or organization. Contacts are read-only. more is true when a data source has more than it lists. ${SOURCES}`,
    inputSchema: object({ query: { type: "string", maxLength: 100, description: "Words a contact's name, email or organization must have" } }),
    op: "contact.list",
    example: { query: "sam" },
  },
  {
    name: "read_person",
    description:
      "A person, as a mention names them: their page. who is a member's id from list_members, or a name. A name one member has is that member. It answers the member they are (when your token is told who the members are), your member's own contacts that are them with all those contacts hold (each email, phone, address and website as { value, type }, as list_contacts says), the open todos assigned to them, and each line that mentions them in the notes you can see, the note changed latest first. query is what search_notes takes to find the notes that mention them; add words to it to search among those. Write nothing a contact told you into a note: every reader of the note sees it.",
    inputSchema: object({ who: { type: "string", maxLength: 200, description: "A member's id, or a name as a mention writes it" }, limit: { type: "integer", minimum: 1, maximum: 200, description: "How many lines that mention them, at most. Default 50" } }, ["who"]),
    op: "person.read",
    example: { who: "Ada Lovelace" },
  },
  {
    name: "refer_record",
    description:
      `What a note writes to reference one of your member's events or contacts without copying it: ref, and text, an embed such as ::event{ref Lunch with Sam} or ::contact{ref Sam Okafor} to put in the note. The app draws it for your member with the record's details as they are now. The words after the ref are plain text in the note, which every reader of the note sees, so change or drop them if the title shouldn't be shared; the rest of the record is never in the note. ${SOURCES}`,
    inputSchema: object({ sourceId: { type: "string", description: "The data source the record is in" }, id: { type: "string", description: "The event's or contact's id, from list_events or list_contacts" } }, ["sourceId", "id"]),
    op: "record.refer",
    example: { sourceId: "google", id: "evt123" },
  },
  {
    name: "read_record",
    description: `The event or contact a reference in a note stands for, as it is now. ref is the first word inside ::event{...} or ::contact{...}. A reference another member made reads as no such record: its details are theirs alone. ${SOURCES}`,
    inputSchema: object({ ref: { type: "string", description: "The reference, from the note" } }, ["ref"]),
    op: "record.read",
    example: { ref: "r8m2k4q9x1cd" },
  },
  {
    name: "notes_about_record",
    description: `The notes that reference one of your member's events or contacts with your member's own reference (the one refer_record answers), and for an event your member's calendar has now, another member's reference to the same event (a teammate's notes about a meeting on a shared calendar), among the notes your member can see and not in Trash, latest change first: id, title, updatedAt, and audience, who sees the note: private (only its owner), shared (its owner and the people it is shared with) or workspace (every member). ${SOURCES}`,
    inputSchema: object({ sourceId: { type: "string", description: "The data source the record is in" }, id: { type: "string", description: "The event's or contact's id, from list_events or list_contacts" } }, ["sourceId", "id"]),
    op: "record.notes",
    example: { sourceId: "google", id: "evt123" },
  },
  {
    name: "list_plugins",
    description:
      `The workspace's plugins: each third-party plugin installed, with the commands, views, embeds and options its manifest declares, and each capability it asks for with its reason, whether it is allowed, locked, or voided by a change to the plugin, who decided it, and who is waiting on an admin for it. HTML embeds are listed too, with the sites their network is allowed. A plugin's changes are in history under its id, as author plugin:<id>. ${ROLE}`,
    inputSchema: object({}),
    op: "plugin.list",
    times: ["installedAt"],
    example: {},
  },
  {
    name: "scaffold_plugin",
    description: `A new plugin's two files to start from, its manifest and its code, named name: it asks for nothing, adds one command and one view in the inspector, and runs shut off from the app. Nothing is kept: change them, check them with validate_plugin, then install_plugin (an admin's agent) or save_draft (anyone's, beside a plugin that is installed). ${PLUGIN_DOCS}`,
    inputSchema: object({ name: { type: "string", maxLength: 60, description: "The plugin's name, which isn't Common Ink's own or one that reads as one" } }, ["name"]),
    op: "plugin.scaffold",
    example: { name: "Word count" },
  },
  {
    name: "validate_plugin",
    description: `What installing a manifest and code would make of them, without installing or keeping anything: ok with the manifest as it would be kept, the codeHash permit_plugin takes and whether it asks for full trust, or ok false with why it would be refused. The code is not run or parsed here: it is run shut off, in each member's browser. ${PLUGIN_DOCS}`,
    inputSchema: object({ manifest, code }, ["manifest", "code"]),
    op: "plugin.validate",
    example: { manifest: MANIFEST, code: CODE },
  },
  {
    name: "read_plugin",
    description: "An installed plugin's code and its codeHash, to read before permitting it anything or to change it for an update. list_plugins lists what each declares.",
    inputSchema: object({ pluginId }, ["pluginId"]),
    renames: { pluginId: "id" },
    op: "plugin.read",
    example: { pluginId: PLUGIN },
  },
  {
    name: "install_plugin",
    description: `Installs a plugin for the whole workspace from its manifest and code, or with pluginId puts them in an installed plugin's place (an update, which voids what it was permitted until it is permitted again). Only an admin's agent may. Nothing is permitted by installing, and the plugin's page says it was installed by you for your member. ${ROLE} ${PLUGIN_DOCS}`,
    inputSchema: object({ manifest, code, pluginId: { ...pluginId, description: "The installed plugin this takes the place of, from list_plugins; left out, this is a new plugin" } }, ["manifest", "code"]),
    renames: { pluginId: "replaces" },
    op: "plugin.install",
    times: ["installedAt"],
    example: { manifest: MANIFEST, code: CODE },
  },
  {
    name: "uninstall_plugin",
    description: `Takes a plugin out of the workspace, and with it everything it was permitted, every request for it and every member's draft of it. What it wrote stays in history. Only an admin's agent may. ${ROLE}`,
    inputSchema: object({ pluginId }, ["pluginId"]),
    renames: { pluginId: "id" },
    op: "plugin.uninstall",
    times: ["installedAt"],
    example: { pluginId: PLUGIN },
  },
  {
    name: "permit_plugin",
    description: `An admin's decision on one capability a plugin asks for: allowed or not, and locked or not (a locked one takes no requests). Allowing names the code you read, codeHash from list_plugins or read_plugin, and is refused when the plugin changed since. For HTML embeds (pluginId html, capability network) origins lists the sites they may reach. Granting full-trust is allowed to an admin's agent like any other decision, but it runs nobody's code: each member turns it on for themself in the app, and no agent can. Only an admin's agent may. ${ROLE}`,
    inputSchema: object(
      {
        pluginId: { type: "string", description: "The plugin's id, or html for HTML embeds" },
        capability,
        allowed: { type: "boolean" },
        locked: { type: "boolean" },
        origins: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "For HTML embeds alone: the sites, such as https://example.com" },
        codeHash: { type: "string", description: "The plugin's code as you read it, from list_plugins or read_plugin. Needed to allow" },
      },
      ["pluginId", "capability", "allowed"],
    ),
    renames: { pluginId: "id" },
    op: "plugin.permit",
    times: ["installedAt"],
    example: { pluginId: PLUGIN, capability: "notes.read", allowed: true, codeHash: CODE_HASH },
  },
  {
    name: "request_plugin_permission",
    description: `Your member asking an admin to allow a plugin one capability it asks for. It allows nothing: an admin decides, and sees who asked. Not for an admin, who decides with permit_plugin. ${ROLE}`,
    inputSchema: object({ pluginId: { type: "string", description: "The plugin's id, or html for HTML embeds" }, capability, origins: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "For HTML embeds alone: the sites" } }, ["pluginId", "capability"]),
    renames: { pluginId: "id" },
    op: "plugin.request",
    times: ["installedAt"],
    example: { pluginId: PLUGIN, capability: "notes.read" },
  },
  {
    name: "list_drafts",
    description: `Your member's own drafts of plugins: copies of an installed plugin's source (or of one of Common Ink's own that runs shut off), each with its manifest, its codeHash, the original's code when it was copied, and whether it runs for your member in the original's place. Nobody else's. ${DRAFT_WORDS}`,
    inputSchema: object({}),
    op: "draft.list",
    example: {},
  },
  {
    name: "read_draft",
    description: `One of your member's drafts, with its code. ${DRAFT_WORDS}`,
    inputSchema: object({ pluginId: draftId }, ["pluginId"]),
    renames: { pluginId: "id" },
    op: "draft.read",
    example: { pluginId: PLUGIN },
  },
  {
    name: "save_draft",
    description: `Keeps your member's draft of a plugin as given, making it if there is none. running makes it run in the original's place for your member alone, in their browser, shut off from the app and with what the original is permitted and never more; a draft that asks for full trust never runs. baseHash is the original's codeHash when the copy was made. ${DRAFT_WORDS}`,
    inputSchema: object({ pluginId: draftId, manifest, code, baseHash: { type: ["string", "null"], description: "The original's codeHash when the copy was made, or null" }, running: { type: "boolean" } }, ["pluginId", "manifest", "code", "running"]),
    renames: { pluginId: "id" },
    op: "draft.save",
    example: { pluginId: PLUGIN, manifest: MANIFEST, code: CODE, baseHash: CODE_HASH, running: false },
  },
  {
    name: "discard_draft",
    description: `Removes your member's draft of a plugin for good. The plugin itself stays as it is. ${DRAFT_WORDS}`,
    inputSchema: object({ pluginId: draftId }, ["pluginId"]),
    renames: { pluginId: "id" },
    op: "draft.discard",
    example: { pluginId: PLUGIN },
  },
  {
    name: "list_members",
    description: "Everyone in the workspace: person id, name and role (admin, editor or viewer), and no email, which only an admin is shown in the app. Members are the authors history names by person id. An agent can't invite, remove, or change anyone's role; a member does that in the app, on the Members page.",
    inputSchema: object({}),
    op: "member.list",
    example: {},
  },
];

const MAX_WRITE_ID = 64;
const CLIPPER_WRITE = "clipper:";

/** Who calls a tool: an agent, or the clipper as its member, which reaches only `CLIPPER_TOOLS`. */
export type Caller = ConnectedAgent & { clipper?: true };

const reaches = (caller: Caller | undefined, name: string) => !caller?.clipper || CLIPPER_TOOLS.has(name);

/** The tools that change something and only add to what there is, so a client can tell them from those that change or remove. */
export const ADDITIVE = new Set(["create_note", "create_folder", "daily_note", "upload_file", "start_upload", "resume_upload", "finish_upload", "refer_record", "create_event", "request_plugin_permission", "rebuild_links", "rebuild_todos"]);
/** The tools that reach the member's data sources, outside Common Ink. */
export const OPEN_WORLD = new Set(["list_events", "update_event", "create_event", "list_contacts", "read_record", "refer_record", "read_person", "notes_about_record"]);

/** Whether a tool changes nothing, by its operation as a read-only token is refused. Of the tools with no operation, only upload_file writes. */
export const readsOnly = (tool: Tool) => (tool.op ? isReadOnlyOp(tool.op) : tool.name !== "upload_file");

/** A tool as an agent is shown it: its description ends with its example. */
export const toolList = (caller?: Caller) =>
  TOOLS.filter((tool) => reaches(caller, tool.name)).map((tool) => ({
    name: tool.name,
    title: `${tool.name[0]!.toUpperCase()}${tool.name.slice(1).replaceAll("_", " ")}`,
    description: `${tool.description}\n\nExample: ${JSON.stringify(tool.example)}`,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: readsOnly(tool), destructiveHint: !readsOnly(tool) && !ADDITIVE.has(tool.name), openWorldHint: OPEN_WORLD.has(tool.name) },
  }));

/** How near two names are, for a guess at the one meant: the same once case, _ and - are set aside. */
const loosely = (name: string) => name.toLowerCase().replace(/[_-]/g, "");

/**
 * A tool's arguments as its operation takes them: an old name read as the name it has now, an
 * argument left out given the tool's default, a time as milliseconds, and each renamed argument
 * under its operation's field. `workspaceId` is apart, since it says where and isn't the operation's.
 * An argument the tool doesn't take is refused by name, since the core would leave it out and a
 * misspelt argument would turn into a different request.
 */
export function opArguments(tool: Tool, args: Record<string, unknown>): { workspaceId: unknown; fields: Record<string, unknown> } {
  const properties = (tool.inputSchema as { properties: Record<string, object> }).properties;
  const takes = Object.keys(properties);
  const old = oldNames(tool);
  const named: Record<string, unknown> = {};
  for (const [given, value] of Object.entries(args)) {
    const name = old[given] ?? given;
    if (!takes.includes(name)) {
      const meant = takes.find((taken) => loosely(taken) === loosely(given));
      throw new OpError("invalid", `${tool.name} takes no "${given}"${meant ? `: did you mean "${meant}"?` : "."} It takes ${takes.join(", ") || "no arguments"}.`);
    }
    if (name in named && JSON.stringify(named[name]) !== JSON.stringify(value)) throw new OpError("invalid", `Pass ${name} once: "${Object.keys(old).find((was) => old[was] === name)}" is its old name, and they differ`);
    named[name] = value;
  }
  const { workspaceId, ...rest } = { ...tool.defaults, ...named };
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    let taken = value;
    if (TIMES.has(properties[name]!) && typeof value === "string") {
      taken = Date.parse(value);
      if (Number.isNaN(taken)) throw new OpError("invalid", `${name} must be a time: ISO 8601, such as 2026-10-15T09:30:00-07:00, or milliseconds since 1970`);
    }
    fields[tool.renames?.[name] ?? name] = taken;
  }
  return { workspaceId, fields };
}

/** The keys of an answer that hold a time, which the operations give in milliseconds. */
const TIME_KEYS = new Set(["createdAt", "updatedAt", "firstAt", "lastAt", "at", "stateAt", "trashedAt", "purgesAt", "readUntil"]);
/** What an agent passes back as given, so it stays as the operation wrote it. */
const PASSED_BACK = new Set(["next", "before"]);

/** An answer with each time written in ISO 8601 with its offset, in the member's time zone. */
function withTimes(value: unknown, written: (time: number) => string, times: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withTimes(item, written, times));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, PASSED_BACK.has(key) ? item : times.has(key) && typeof item === "number" ? written(item) : withTimes(item, written, times)]),
  );
}

/** Where a tool call came to: the server's own address, and the bucket a file sent with upload_file goes to. */
export interface Reached {
  origin: string;
  bucket: R2Bucket | null;
}

/** A small file's bytes from base64, or null for what isn't base64. */
function fromBase64(given: unknown): Uint8Array | null {
  if (typeof given !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(given.replace(/\s+/g, ""))) return null;
  try {
    return Uint8Array.from(atob(given.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Runs a tool as `agent`. Failures the agent can act on come back as an error result, not a protocol error. */
export async function callTool(db: D1Database, agent: Caller, name: string, args: Record<string, unknown>, sources?: Sources, reached: Reached = { origin: "", bucket: null }): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  if (!reaches(agent, name)) return text(`forbidden: The clipper can only list workspaces and folders and create notes. ${name} is for agents`, true);
  try {
    const { workspaceId: workspace, fields } = opArguments(tool, args);
    if (name === "note_syntax") return text(noteSyntaxText());
    if (name === "query_syntax") {
      if (!SCOPES.includes(fields.scope as Scope)) throw new OpError("invalid", `scope is ${SCOPES.join(", ")}`);
      return text(queryLanguage(fields.scope as Scope));
    }
    const me = await whoAmI(db, agent.personId);
    // A token pinned to one workspace sees only that one, as if the member belonged to no other.
    if (agent.workspaceId) me.workspaces = me.workspaces.filter((w) => w.id === agent.workspaceId);
    if (name === "list_workspaces") return text({ person: me.person, workspaces: me.workspaces, readOnly: agent.readOnly, folderIds: agent.folderIds });

    let workspaceId: string;
    if (workspace === undefined) {
      if (me.workspaces.length !== 1) throw new OpError("invalid", `Pass workspaceId: you can reach ${me.workspaces.length} (${me.workspaces.map((w) => w.id).join(", ")})`);
      workspaceId = me.workspaces[0]!.id;
    } else {
      if (typeof workspace !== "string" || !me.workspaces.some((w) => w.id === workspace)) throw new OpError("not_found", NO_SUCH_WORKSPACE);
      workspaceId = workspace;
    }
    const actor: Actor = agent.clipper ? { kind: "member", personId: agent.personId, workspaceId } : agentActor(agent, workspaceId);
    const written = async (answer: unknown) => text(withTimes(answer, timeIn((await timeZoneOf(db, workspaceId, agent.personId)) ?? "UTC"), tool.times ? new Set([...TIME_KEYS, ...tool.times]) : TIME_KEYS));
    if (name === "upload_file") {
      const { name: fileName, base64, folderId } = fields;
      const bytes = fromBase64(base64);
      if (!bytes?.byteLength) throw new OpError("invalid", "base64 isn't a file's bytes in base64");
      if (bytes.byteLength > MAX_INLINE_UPLOAD_BYTES) throw new OpError("invalid", `upload_file takes at most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB. Send a larger file with start_upload`);
      const upload = await perform(db, actor, { type: "upload.create", name: fileName as string, size: bytes.byteLength, ...(folderId === undefined ? {} : { folderId: folderId as string }) }, Date.now(), sources, { bucket: reached.bucket, body: new Response(bytes).body });
      return written(withLine(upload));
    }
    if (agent.clipper && name === "create_note" && typeof fields.writeId === "string") {
      // The clipper writes as its member, so its write ids are its own, and a replay finds only a note it made. It can't read notes, so it is told the id alone.
      if (fields.writeId.length > MAX_WRITE_ID - CLIPPER_WRITE.length) throw new OpError("invalid", `The clipper's writeId is at most ${MAX_WRITE_ID - CLIPPER_WRITE.length} characters`);
      fields.writeId = CLIPPER_WRITE + fields.writeId;
      const prior = await db.prepare(PRIOR_WRITE).bind(fields.writeId, workspaceId, "member", agent.personId).first<{ id: string }>();
      if (prior) return text({ id: prior.id });
    }
    if (tool.pages) {
      const { limit, offset = 0 } = fields as { limit: unknown; offset?: number };
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new OpError("invalid", `limit is a whole number from 1 to ${MAX_PAGE}`);
      const listed = (await perform(db, actor, { ...fields, limit: limit + 1, type: tool.op! } as OpInput, Date.now(), sources, { bucket: reached.bucket })) as unknown[];
      return written({ [tool.pages]: listed.slice(0, limit), next: listed.length > limit ? offset + limit : null });
    }
    const answer = await perform(db, actor, { ...fields, type: tool.op! } as OpInput, Date.now(), sources, { bucket: reached.bucket });
    return written(tool.told ? tool.told(answer as never, reached.origin) : answer);
  } catch (err) {
    if (err instanceof OpError) return text(`${err.code}: ${namedAsTold(tool, err.message)}`, true);
    throw err;
  }
}

/** A refusal of an operation's field, such as "→ at id", said of the argument the agent passed for it. */
const namedAsTold = (tool: Tool, message: string) =>
  message.replace(/→ at (\w+)/g, (said, field: string) => {
    const name = Object.entries(tool.renames ?? {}).find(([, renamed]) => renamed === field)?.[0];
    return name ? `→ at ${name}` : said;
  });
