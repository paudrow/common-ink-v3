// The `ink` command's logic, for an agent working from a shell. It is a thin client of the /mcp endpoint,
// so it does what the MCP tools do and nothing more. scripts/ink.ts runs it on this machine.
export interface Io {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** The text piped in, when there is any. */
  stdin: () => Promise<string>;
  out: (line: string) => void;
}

export const USAGE = `Usage: ink [--workspace ID] <command>

  workspaces                          the workspaces you can reach
  notes [--folder ID] [--since TIME]  the notes in a workspace, in one folder, or changed since a time
  read ID [--revision N]              a note's markdown
  create [--text TEXT] [--folder ID]  a new note (text from stdin if --text is left out)
  write ID --base N [--text TEXT] [--write-id ANY]
                                      replace a note's text (from stdin if --text is left out)
  move ID --folder ID                 put a note in another folder
  folders                             the folders in a workspace
  folder-create NAME [--parent ID]    a new folder
  folder-rename ID --name NAME        give a folder another name
  folder-delete ID                    delete an empty folder
  history ID                          a note's changes and who made them
  diff ID --change N                  what one change did to its note, as a line diff
  changed [--note ID,ID] [--author KIND:ID] [--from TIME] [--to TIME] [--limit N] [--before NEXT]
                                      the notes that changed, latest first, with the lines added and removed in each
  changes [--note ID,ID] [--author KIND:ID] [--from TIME] [--to TIME] [--limit N] [--before NEXT] [--diffs false]
                                      changes across the workspace, newest first, with diffs
  authors                             everyone who has changed a note
  label ID --revision N [--name NAME] name a revision, or take its name away without --name
  revert ID --revision N              put a note back to a revision, as a new change
  revert ID --changes N,N             revert chosen changes, as one new change; revert a revert to have its changes again
  revert ID ... --preview             what either revert would do, and the later changes to the same lines, with nothing written
  revert-author KIND:ID [--note ID,ID] [--after ID]
                                      revert every change an author made that still stands
  undo ID                             take back your latest change to a note
  redo ID                             revert your latest undo, so what it undid stands again

TIME is anything a date parses, such as 2026-10-09 or 2026-10-09T14:00:00Z. KIND:ID is an author
from authors, such as agent:abc123def456. NEXT is the next of the page before, as JSON.

Set INK_URL (default https://commonink.app) and INK_TOKEN (an agent token from Common Ink).`;

export class UsageError extends Error {}

/** Flags that take no value. */
const SWITCHES = new Set(["--preview"]);

function parse(argv: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (SWITCHES.has(arg)) flags.set(arg.slice(2), "");
    else if (arg.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      flags.set(arg.slice(2), value);
    } else positional.push(arg);
  }
  const [command = "", ...rest] = positional;
  return { command, positional: rest, flags };
}

const integer = (name: string, value: string): number => {
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number`);
  return Number(value);
};

const integers = (name: string, value: string) => value.split(",").map((part) => integer(name, part));

const time = (name: string, value: string): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new UsageError(`${name} must be a date or a time`);
  return parsed;
};

function authorRef(value: string): { kind: string; id: string } {
  const [kind, id] = value.split(":");
  if (!kind || !id) throw new UsageError("An author is KIND:ID, such as agent:abc123def456");
  return { kind, id };
}

function json(name: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${name} must be JSON`);
  }
}

const nextOf = (answer: string): string | null => {
  try {
    return (JSON.parse(answer) as { next?: string | null }).next ?? null;
  } catch {
    return null;
  }
};

/** Runs one command. Returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { command, positional, flags } = parse(argv);
    const token = io.env.INK_TOKEN;
    if (!command || command === "help") {
      io.out(USAGE);
      return command ? 0 : 1;
    }
    if (!token) throw new UsageError("Set INK_TOKEN to an agent token from Common Ink");
    const id = positional[0];
    const need = (what: string) => id ?? (() => { throw new UsageError(`${command} needs ${what}`); })();
    const needId = () => need("a note id");
    const needFlag = (name: string) => flags.get(name) ?? (() => { throw new UsageError(`${command} needs --${name}`); })();
    /** The flags given, each as the argument it sets. */
    const given = (as: Record<string, [flag: string, read?: (name: string, value: string) => unknown]>) =>
      Object.fromEntries(Object.entries(as).flatMap(([arg, [flag, read]]) => (flags.has(flag) ? [[arg, read ? read(`--${flag}`, flags.get(flag)!) : flags.get(flag)!]] : [])));
    const ids = (_: string, value: string) => value.split(",");
    const author = (_: string, value: string) => authorRef(value);

    let tool: string;
    let args: Record<string, unknown> = {};
    switch (command) {
      case "workspaces":
        tool = "list_workspaces";
        break;
      case "notes":
        tool = "list_notes";
        args = given({ folderId: ["folder"], updatedSince: ["since", time] });
        break;
      case "read":
        tool = "read_note";
        args = { id: needId(), ...(flags.has("revision") ? { revision: integer("--revision", flags.get("revision")!) } : {}) };
        break;
      case "create":
        tool = "create_note";
        args = { text: flags.get("text") ?? (await io.stdin()), ...given({ folderId: ["folder"] }) };
        break;
      case "write":
        if (!flags.has("base")) throw new UsageError("write needs --base, the revision you read");
        tool = "write_note";
        args = { id: needId(), baseRevision: integer("--base", flags.get("base")!), text: flags.get("text") ?? (await io.stdin()), ...given({ writeId: ["write-id"] }) };
        break;
      case "move":
        tool = "move_note";
        args = { id: needId(), folderId: needFlag("folder") };
        break;
      case "folders":
        tool = "list_folders";
        break;
      case "folder-create":
        tool = "create_folder";
        args = { name: need("a name"), ...given({ parentId: ["parent"] }) };
        break;
      case "folder-rename":
        tool = "rename_folder";
        args = { id: need("a folder id"), name: needFlag("name") };
        break;
      case "folder-delete":
        tool = "delete_folder";
        args = { id: need("a folder id") };
        break;
      case "history":
        tool = "note_history";
        args = { id: needId() };
        break;
      case "diff":
        if (!flags.has("change")) throw new UsageError("diff needs --change");
        tool = "change_diff";
        args = { id: needId(), revision: integer("--change", flags.get("change")!) };
        break;
      case "changed":
        tool = "history_summary";
        args = given({ noteIds: ["note", ids], authors: ["author", (_, value) => [authorRef(value)]], from: ["from", time], to: ["to", time], limit: ["limit", integer], before: ["before", json] });
        break;
      case "changes":
        tool = "history";
        args = given({
          noteIds: ["note", ids],
          authors: ["author", (_, value) => [authorRef(value)]],
          from: ["from", time],
          to: ["to", time],
          limit: ["limit", integer],
          before: ["before", json],
          diffs: ["diffs", (_, value) => value !== "false"],
        });
        break;
      case "authors":
        tool = "history_authors";
        break;
      case "label":
        if (!flags.has("revision")) throw new UsageError("label needs --revision");
        tool = "label_revision";
        args = { id: needId(), revision: integer("--revision", flags.get("revision")!), name: flags.get("name") ?? null };
        break;
      case "revert":
        if (flags.has("revision") === flags.has("changes")) throw new UsageError("revert needs --revision, to return to it, or --changes, to revert those");
        if (flags.has("preview")) {
          tool = "preview_revert";
          args = flags.has("revision") ? { id: needId(), to: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
          break;
        }
        tool = flags.has("revision") ? "revert_note" : "revert_changes";
        args = flags.has("revision") ? { id: needId(), revision: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        break;
      case "revert-author":
        tool = "revert_author";
        args = { author: authorRef(need("an author, as KIND:ID")), ...given({ noteIds: ["note", ids], after: ["after"] }) };
        break;
      case "undo":
      case "redo":
        tool = command;
        args = { id: needId() };
        break;
      default:
        throw new UsageError(`No such command: ${command}`);
    }
    if (flags.has("workspace")) args = { ...args, workspace: flags.get("workspace") };

    const base = (io.env.INK_URL ?? "https://commonink.app").replace(/\/+$/, "");
    for (;;) {
      const res = await io.fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      if (res.status === 401) throw new UsageError("Common Ink doesn't know that token: it was mistyped or the agent was disconnected");
      const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
      if (body.error) throw new UsageError(body.error.message);
      const answer = (body.result?.content ?? []).map((c) => c.text).join("\n");
      io.out(answer);
      if (body.result?.isError) return 1;
      // Reverting an author covers a few notes a call, so the command carries on until every note is covered.
      const next = tool === "revert_author" ? nextOf(answer) : null;
      if (!next) return 0;
      args = { ...args, after: next };
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.out(`ink: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
