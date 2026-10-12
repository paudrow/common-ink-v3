import { z } from "zod";
import { whoAmI } from "../../core/accounts.ts";
import { perform, type Actor } from "../../core/operations.ts";
import { Id, MAX_NOTE_LENGTH, OpError, type OpInput } from "../../core/protocol.ts";
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
  /** The operation this tool performs, from its arguments. Null for tools that aren't a workspace operation. */
  op?: (args: Record<string, unknown>) => OpInput;
}

const Args = {
  read: z.object({ id: Id, revision: z.number().int().min(0).optional() }),
  create: z.object({ text: z.string().max(MAX_NOTE_LENGTH).optional() }),
  write: z.object({ id: Id, baseRevision: z.number().int().min(0), text: z.string().max(MAX_NOTE_LENGTH), writeId: z.string().min(1).max(64).optional() }),
  history: z.object({ id: Id }),
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { workspace: workspaceProp, ...properties },
  required,
  additionalProperties: false,
});

/** A tool whose arguments are the operation's own; the core checks them. */
const as = (type: OpInput["type"]) => (args: Record<string, unknown>) => ({ ...args, type }) as OpInput;

const noteId = { type: "string", description: "The note id" };
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
const author = {
  type: "object",
  properties: { kind: { type: "string", enum: ["member", "agent", "plugin"] }, id: { type: "string" } },
  required: ["kind", "id"],
  additionalProperties: false,
};
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
    at: { type: "integer", minimum: 0, description: "The note's revision that preview_reverts answered with. The note is skipped when it has changed since" },
    choices: { ...choices, description: "How to settle this note's conflicts, as resolve.choices of revert_changes does. Needs at" },
  },
  [],
  "The notes to revert, each named once: up to 40, each with revisions (its changes to revert) or to (the revision to return to)",
);
const time = (description: string) => ({ type: "integer", minimum: 0, description: `${description}, in milliseconds since 1970` });

export const TOOLS: Tool[] = [
  {
    name: "list_workspaces",
    description: "The workspaces you can reach, each with your role in it (admin, editor or viewer). You act with your member's role.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_notes",
    description: "The notes in a workspace, newest change first: id, title, folder, revision and when it last changed.",
    inputSchema: object({}),
    op: () => ({ type: "note.list" }),
  },
  {
    name: "read_note",
    description: "A note's markdown text. Pass revision to read an earlier version.",
    inputSchema: object({ id: { type: "string", description: "The note id" }, revision: { type: "integer", minimum: 0, description: "An earlier revision; default is the latest" } }, ["id"]),
    op: (a) => ({ type: "note.read", ...Args.read.parse(a) }),
  },
  {
    name: "create_note",
    description: "Make a note in the workspace's Unsorted folder, with markdown text whose first # heading is its title. Needs the editor or admin role.",
    inputSchema: object({ text: { type: "string", description: "The note's markdown" } }),
    op: (a) => ({ type: "note.create", ...Args.create.parse(a) }),
  },
  {
    name: "write_note",
    description:
      "Replace a note's text. Give the revision you read as baseRevision: edits made since then are merged in, not overwritten. Send the same writeId again after a failed call and the write is recorded once. Needs the editor or admin role. The change is recorded under your agent's name.",
    inputSchema: object(
      {
        id: { type: "string", description: "The note id" },
        baseRevision: { type: "integer", minimum: 0, description: "The revision your text is based on" },
        text: { type: "string", description: "The note's full new markdown" },
        writeId: { type: "string", maxLength: 64, description: "Any unique string, to make a retry safe" },
      },
      ["id", "baseRevision", "text"],
    ),
    op: (a) => ({ type: "note.write", ...Args.write.parse(a) }),
  },
  {
    name: "note_history",
    description:
      "A note's recorded changes, oldest first: revision, the revision it was based on, who made it (a member, or an agent by name), when, its label, the lines it added and removed, the changes it reverted (reverts) and the later change that reverted it (revertedBy).",
    inputSchema: object({ id: { type: "string", description: "The note id" } }, ["id"]),
    op: (a) => ({ type: "note.history", ...Args.history.parse(a) }),
  },
  {
    name: "change_diff",
    description: "What one change did to its note, as a line diff: hunks of added, removed and unchanged lines, with the lines it added and removed counted.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 1, description: "The change, by the revision it made" } }, ["id", "revision"]),
    op: as("note.diff"),
  },
  {
    name: "history_summary",
    description:
      "The notes that changed, latest change first, each with how many changes it had, the lines they added and removed, when the first and last were made, and who made them. Start here, then read one note's changes with history and one change with change_diff. Narrow it by noteIds, authors (from history_authors) and a time range, which then count only the changes that match. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Only these notes" },
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
      by,
      from: time("Changes made at or after this time"),
      to: time("Changes made before this time"),
      before: { type: "object", description: "The next of the page before" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many notes; default 30" },
    }),
    op: as("history.summary"),
  },
  {
    name: "history",
    description:
      "Changes across the workspace, newest first, each with its note, author, the lines it added and removed, and a line diff. Narrow it by noteIds (one note, several, or all when left out), authors (from history_authors) and a time range. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Only these notes" },
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
      by,
      from: time("Changes made at or after this time"),
      to: time("Changes made before this time"),
      before: { type: "object", description: "The next of the page before" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many changes; default 50" },
      diffs: { type: "boolean", description: "False leaves the diffs out" },
    }),
    op: as("history.list"),
  },
  {
    name: "history_authors",
    description: "Everyone who has changed a note in the workspace: members by person id and agents by agent id, each with a name.",
    inputSchema: object({}),
    op: as("history.authors"),
  },
  {
    name: "history_diff",
    description:
      "What a selection of changes did, note by note, across up to 40 notes. A note's selected changes that follow one another are one run with one line diff, from the note before the first of them to the note after the last, so a line written and taken out again within a run shows in neither. A change left out in between starts a new run, which says how many were skipped. Each run has its revisions (from, to), how many changes it is (saves), who made them, when, and the lines it added and removed. An answer holds about 2000 diff lines: a run past them has diff null, and asking for its note alone returns it. A run's diff shows at most 200 lines and counts the rest in omitted.",
    inputSchema: object({ changes: selected({ revisions }, ["revisions"], "The selection: each note once, with the revisions of its changes") }, ["changes"]),
    op: as("history.diff"),
  },
  {
    name: "preview_reverts",
    description:
      "What revert_many would do to each note, with nothing written: for each, the note's revision it was worked out at (pass it back as at), the changes that would be reverted (revisions), the ones left out because something already reverted them (already), the diff from the note as it is to the note after, and its conflicts as preview_revert lists them. A change selected together with the change that reverted it stays reverted and that revert goes too. An empty diff means the note would not change.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: as("history.previewRevert"),
  },
  {
    name: "revert_many",
    description:
      "Revert changes of up to 40 notes at once, each note as one new change under your agent's name. Each note is reverted or skipped whole, by itself: the answer lists reverted (each with the revision the revert made and the changes it reverted) and skipped (each with why: changed, when the note is no longer at the revision passed as at; nothing, when the revert would change nothing; refused, with the reason). Call preview_reverts first and pass each note's revision back as at. To undo a revert, revert the revision it made, with at set to that revision: the note is skipped if it has been changed since. Needs the editor or admin role.",
    inputSchema: object({ changes: reverted }, ["changes"]),
    op: as("history.revert"),
  },
  {
    name: "label_revision",
    description: "Name one revision of a note, so it can be found and reverted to. A null name takes the label away. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 1 }, name: { type: ["string", "null"], maxLength: 60 } }, ["id", "revision", "name"]),
    op: as("note.label"),
  },
  {
    name: "revert_note",
    description:
      "Put a note back to how it was at a revision. This is recorded as a new change under your agent's name; nothing is erased. Call preview_revert first; if it lists conflicts, pass resolve to settle them. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 0, description: "The revision to return to" }, resolve }, ["id", "revision"]),
    op: as("note.revert"),
  },
  {
    name: "revert_changes",
    description:
      "Revert chosen changes of a note and keep every other change, recorded as one new change under your agent's name. History only goes forward: to have a reverted change again, revert the change that reverted it (its revertedBy). Call preview_revert first; if it lists conflicts, pass resolve to settle them, or the later edits are kept. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revisions, resolve }, ["id", "revisions"]),
    op: as("note.revertChanges"),
  },
  {
    name: "preview_revert",
    description:
      "What a revert would do to a note, with nothing written. Pass revisions to preview revert_changes of those changes, or to to preview revert_note to that revision. Returns the note's revision it was worked out at, the changes that would be reverted (revisions), the diff from the note as it is to the note after (diff), overlaps: later changes that still stand and edited the same lines, and conflicts: each place they did, top of the note first, with the lines as they were before the reverted changes (before), as they are now (now), as the revert leaves them with the later edits kept (kept), the line of the result kept starts at (line), and the later changes that edited them with their authors (later). Settle each conflict with resolve on the revert; pass the same resolve here to see the diff of the revert settled that way. A read-only token can use it.",
    inputSchema: object({ id: noteId, revisions, to: { type: "integer", minimum: 0, description: "The revision to return to" }, resolve }, ["id"]),
    op: as("note.previewRevert"),
  },
  {
    name: "undo",
    description: "Take back your own latest change to a note that still stands, as a new change. Other authors' changes are kept. Needs the editor or admin role.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: as("note.undo"),
  },
  {
    name: "redo",
    description: "Revert your latest undo on a note, as a new change, so what it undid stands again. Needs the editor or admin role.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: as("note.redo"),
  },
];

export const toolList = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/** Runs a tool as `agent`. Failures the agent can act on come back as an error result, not a protocol error. */
export async function callTool(db: D1Database, agent: ConnectedAgent, name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    const me = await whoAmI(db, agent.personId);
    // A token pinned to one workspace sees only that one, as if the member belonged to no other.
    if (agent.workspaceId) me.workspaces = me.workspaces.filter((w) => w.id === agent.workspaceId);
    if (name === "list_workspaces") return text({ person: me.person, workspaces: me.workspaces, readOnly: agent.readOnly });

    const { workspace, ...rest } = args;
    let workspaceId: string;
    if (workspace === undefined) {
      if (me.workspaces.length !== 1) throw new OpError("invalid", `Pass workspace: you can reach ${me.workspaces.length} (${me.workspaces.map((w) => w.id).join(", ")})`);
      workspaceId = me.workspaces[0]!.id;
    } else {
      if (typeof workspace !== "string" || !me.workspaces.some((w) => w.id === workspace)) throw new OpError("not_found", "No such workspace");
      workspaceId = workspace;
    }
    const actor: Actor = { kind: "agent", agentId: agent.agentId, personId: agent.personId, workspaceId, scope: { pinnedWorkspaceId: agent.workspaceId, readOnly: agent.readOnly } };
    return text(await perform(db, actor, tool.op!(rest)));
  } catch (err) {
    if (err instanceof OpError) return text(`${err.code}: ${err.message}`, true);
    if (err instanceof z.ZodError) return text(`invalid: ${z.prettifyError(err)}`, true);
    throw err;
  }
}
