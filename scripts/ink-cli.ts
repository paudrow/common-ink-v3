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
  notes                               the notes in a workspace
  read ID [--revision N]              a note's markdown
  create [--text TEXT]                a new note (text from stdin if --text is left out)
  write ID --base N [--text TEXT]     replace a note's text (from stdin if --text is left out)
  history ID                          a note's changes and who made them
  diff ID --change N                  what one change did to its note, as a line diff
  changed [--note ID,ID] [--author KIND:ID] [--by people|agents] [--from TIME] [--to TIME] [--limit N]
                                      the notes that changed, latest first, with the lines added and removed in each
  changes [--note ID,ID] [--author KIND:ID] [--by people|agents] [--from TIME] [--to TIME]
                                      changes across the workspace, newest first, with diffs
  authors                             everyone who has changed a note
  diffs ID:N,N [ID:N,N ...]           what a selection of changes did, note by note: changes that follow one another as one diff
  revert-many ID:N,N[@AT] [ID:N,N[@AT] ...] [--preview] [--resolve keep|back]
                                      revert changes of several notes, each note as one new change. --preview writes nothing and
                                      prints each note's revision: pass it back as @AT and a note changed since is skipped, not reverted
  label ID --revision N [--name NAME] name a revision, or take its name away without --name
  revert ID --revision N              put a note back to a revision, as a new change
  revert ID --changes N,N             revert chosen changes, as one new change; revert a revert to have its changes again
  revert ID ... --preview             what either revert would do, and each conflict with later changes to the same lines, with nothing written
  revert ID ... --resolve keep|back|JSON --at N
                                      settle the conflicts the preview listed at revision N: keep the later edits, go back to the
                                      lines as they were, or a JSON list with "keep", "back" or {"text": "..."} for each conflict
  undo ID                             take back your latest change to a note
  redo ID                             revert your latest undo, so what it undid stands again

TIME is anything a date parses, such as 2026-10-09 or 2026-10-09T14:00:00Z.

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

/** How a revert's conflicts are settled: one word for all of them, or a JSON list with a choice for each. The server checks the choices. */
function choices(value: string): unknown {
  if (value === "keep" || value === "back") return value;
  try {
    const list: unknown = JSON.parse(value);
    if (Array.isArray(list)) return list;
  } catch {
    // Said below.
  }
  throw new UsageError('--resolve must be keep, back, or a JSON list with "keep", "back" or {"text": "..."} for each conflict');
}

/** One note's changes of a selection, written ID:N,N, with @AT for the revision its revert was previewed at. */
function selected(value: string, resolve?: string): Record<string, unknown> {
  const found = /^([^:@]+):([\d,]+)(?:@(\d+))?$/.exec(value);
  if (!found) throw new UsageError(`${value} isn't a note's changes: write ID:N,N, or ID:N,N@AT`);
  const at = found[3] === undefined ? {} : { at: Number(found[3]) };
  return { noteId: found[1], revisions: integers("a change", found[2]!), ...at, ...(resolve !== undefined && found[3] !== undefined ? { choices: resolve } : {}) };
}

const time = (name: string, value: string): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new UsageError(`${name} must be a date or a time`);
  return parsed;
};

function authorRef(value: string): { kind: string; id: string } {
  const [kind, id] = value.split(":");
  if (!kind || !id) throw new UsageError("--author is KIND:ID, such as agent:abc123def456");
  return { kind, id };
}

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
    const needId = () => id ?? (() => { throw new UsageError(`${command} needs a note id`); })();

    let tool: string;
    let args: Record<string, unknown> = {};
    switch (command) {
      case "workspaces":
        tool = "list_workspaces";
        break;
      case "notes":
        tool = "list_notes";
        break;
      case "read":
        tool = "read_note";
        args = { id: needId(), ...(flags.has("revision") ? { revision: integer("--revision", flags.get("revision")!) } : {}) };
        break;
      case "create":
        tool = "create_note";
        args = { text: flags.get("text") ?? (await io.stdin()) };
        break;
      case "write":
        if (!flags.has("base")) throw new UsageError("write needs --base, the revision you read");
        tool = "write_note";
        args = { id: needId(), baseRevision: integer("--base", flags.get("base")!), text: flags.get("text") ?? (await io.stdin()) };
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
      case "changes":
        tool = command === "changed" ? "history_summary" : "history";
        args = {
          ...(flags.has("note") ? { noteIds: flags.get("note")!.split(",") } : {}),
          ...(flags.has("author") ? { authors: [authorRef(flags.get("author")!)] } : {}),
          ...(flags.has("by") ? { by: flags.get("by") } : {}),
          ...(flags.has("from") ? { from: time("--from", flags.get("from")!) } : {}),
          ...(flags.has("to") ? { to: time("--to", flags.get("to")!) } : {}),
          ...(command === "changed" && flags.has("limit") ? { limit: integer("--limit", flags.get("limit")!) } : {}),
        };
        break;
      case "authors":
        tool = "history_authors";
        break;
      case "diffs":
        if (!id) throw new UsageError("diffs needs a note's changes, as ID:N,N");
        tool = "history_diff";
        args = { changes: positional.map((value) => selected(value)) };
        break;
      case "revert-many": {
        if (!id) throw new UsageError("revert-many needs a note's changes, as ID:N,N");
        const resolve = flags.get("resolve");
        if (resolve !== undefined && resolve !== "keep" && resolve !== "back") throw new UsageError("revert-many takes --resolve keep or --resolve back, for the notes given with @AT");
        tool = flags.has("preview") ? "preview_reverts" : "revert_many";
        args = { changes: positional.map((value) => selected(value, resolve)) };
        break;
      }
      case "label":
        if (!flags.has("revision")) throw new UsageError("label needs --revision");
        tool = "label_revision";
        args = { id: needId(), revision: integer("--revision", flags.get("revision")!), name: flags.get("name") ?? null };
        break;
      case "revert":
        if (flags.has("revision") === flags.has("changes")) throw new UsageError("revert needs --revision, to return to it, or --changes, to revert those");
        if (flags.has("resolve") !== flags.has("at")) throw new UsageError("revert needs --resolve and --at together: how to settle the conflicts, and the revision the preview was of");
        if (flags.has("preview")) {
          tool = "preview_revert";
          args = flags.has("revision") ? { id: needId(), to: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        } else {
          tool = flags.has("revision") ? "revert_note" : "revert_changes";
          args = flags.has("revision") ? { id: needId(), revision: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        }
        if (flags.has("resolve")) args.resolve = { at: integer("--at", flags.get("at")!), choices: choices(flags.get("resolve")!) };
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
    const res = await io.fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    if (res.status === 401) throw new UsageError("Common Ink doesn't know that token: it was mistyped or the agent was disconnected");
    const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
    if (body.error) throw new UsageError(body.error.message);
    io.out((body.result?.content ?? []).map((c) => c.text).join("\n"));
    return body.result?.isError ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.out(`ink: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
