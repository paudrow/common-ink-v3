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
const author = {
  type: "object",
  properties: { kind: { type: "string", enum: ["member", "agent", "plugin"] }, id: { type: "string" } },
  required: ["kind", "id"],
  additionalProperties: false,
};
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
      "A note's recorded changes, oldest first: revision, the revision it was based on, who made it (a member, or an agent by name), when, its label, the changes it took back out (reverts) and the later change that took it back out (revertedBy).",
    inputSchema: object({ id: { type: "string", description: "The note id" } }, ["id"]),
    op: (a) => ({ type: "note.history", ...Args.history.parse(a) }),
  },
  {
    name: "history",
    description:
      "Changes across the workspace, newest first, each with its note, author and a line diff. Narrow it by noteIds (one note, several, or all when left out), authors (from history_authors) and a time range. Pass the answer's next as before for the page after.",
    inputSchema: object({
      noteIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Only these notes" },
      authors: { type: "array", items: author, minItems: 1, description: "Only changes by these members or agents" },
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
    name: "activity",
    description: "How many changes an author made on each day, counted in a time zone. Counts your own changes unless you name another author. An agent's changes are the agent's, not its member's.",
    inputSchema: object({ timeZone: { type: "string", description: 'An IANA zone, such as "America/Chicago"' }, author, from: time("From this time"), to: time("Before this time") }, ["timeZone"]),
    op: as("history.activity"),
  },
  {
    name: "label_revision",
    description: "Name one revision of a note, so it can be found and reverted to. A null name takes the label away. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 1 }, name: { type: ["string", "null"], maxLength: 60 } }, ["id", "revision", "name"]),
    op: as("note.label"),
  },
  {
    name: "revert_note",
    description: "Put a note back to how it was at a revision. This is recorded as a new change under your agent's name; nothing is erased. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revision: { type: "integer", minimum: 0, description: "The revision to return to" } }, ["id", "revision"]),
    op: as("note.revert"),
  },
  {
    name: "revert_changes",
    description: "Take chosen changes back out of a note and keep every other change, recorded as one new change. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revisions }, ["id", "revisions"]),
    op: as("note.revertChanges"),
  },
  {
    name: "reapply_changes",
    description: "Put back chosen changes that were taken out of a note, recorded as one new change. Changes that one change took out together go back together. Needs the editor or admin role.",
    inputSchema: object({ id: noteId, revisions }, ["id", "revisions"]),
    op: as("note.reapplyChanges"),
  },
  {
    name: "undo",
    description: "Take back your own latest change to a note that still stands, as a new change. Other authors' changes are kept. Needs the editor or admin role.",
    inputSchema: object({ id: noteId }, ["id"]),
    op: as("note.undo"),
  },
  {
    name: "redo",
    description: "Put back what your latest undo on a note took out, as a new change. Needs the editor or admin role.",
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
