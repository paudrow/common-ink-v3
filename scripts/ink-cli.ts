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
  members                             everyone in a workspace, with their role
  notes [--folder ID] [--since TIME]  the notes in a workspace, in one folder, or changed since a time
  read ID [--revision N]              a note's markdown, and the titles of the notes it links to
  create [--text TEXT] [--folder ID] [--link-titles keep]
                                      a new note (text from stdin if --text is left out)
  write ID --base N [--text TEXT] [--write-id ANY] [--link-titles keep] [--on DAY]
                                      replace a note's text (from stdin if --text is left out)
  backlinks ID                        the notes that link to a note
  links-rebuild                       make backlinks and the index of todos again from the notes' text
  todos [--folder ID] [--tag NAME] [--due-from DAY] [--due-to DAY] [--no-due true] [--importance N,N]
        [--completed true] [--note ID] [--limit N] [--offset N]
                                      the todos in the notes you can see, open ones unless --completed
  todo-filters                        the tags that todos can be narrowed by
  todo ID --revision N --line N --text LINE [--done true|false] [--importance N] [--due DAY|none]
        [--every RULE|none] [--on DAY]
                                      check a todo off or change it; ID, both Ns and LINE are from todos
  todo-history ID --revision N --line N --text LINE
                                      each time a recurring todo was checked off, and by whom
  daily [--on DAY]                    your daily note for a day, made if it isn't there
  todos-rebuild                       the same as links-rebuild
  move ID --folder ID                 put a note in another folder
  folders                             the folders in a workspace
  folder-create NAME [--parent ID]    a new folder
  folder-rename ID --name NAME        give a folder another name
  folder-delete ID                    delete an empty folder
  history ID                          a note's changes and who made them
  diff ID --change N                  what one change did to its note, as a line diff
  changed [--note ID,ID] [--author KIND:ID] [--by people|agents] [--from TIME] [--to TIME] [--limit N] [--before NEXT]
                                      the notes that changed, latest first, with the lines added and removed in each
  changes [--note ID,ID] [--author KIND:ID] [--by people|agents] [--from TIME] [--to TIME] [--limit N] [--before NEXT] [--diffs false]
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
  revert ID --author KIND:ID --preview [--resolve keep|back|JSON --at N]
                                      what revert-author would do to this one note, with nothing written
  revert-author KIND:ID [--note ID,ID] [--after ID] [--resolve JSON]
                                      revert every change an author made that still stands; --resolve settles the conflicts of the
                                      notes it names, as {"NOTE ID": {"at": N, "choices": "keep"|"back"|[...]}}
  undo ID                             take back your latest change to a note
  redo ID                             revert your latest undo, so what it undid stands again

TIME is anything a date parses, such as 2026-10-09 or 2026-10-09T14:00:00Z. KIND:ID is an author
from authors, such as agent:abc123def456. NEXT is the next of the page before, as JSON.

A link to a note is [[ID]] or [[ID|display text]]. Write [[Title]] and create and write store it by
the id of the one note with that title, or refuse when none or several have it. --link-titles keep
leaves such text as it is.

A todo is a checkbox line in a note, with its options on the line: - [ ] !! Call the bank due:2026-10-14
DAY is a calendar date, YYYY-MM-DD. Importance is 0 for normal and 1 to 3 for !, !! and !!!.
RULE is how a todo recurs, written every:RULE on its line: 2w (d, w, m or y), mon,thu, 3d-after-done,
3rd-day, last-day, 2nd-tue, last-fri. Checking off a todo that recurs leaves it open with
its next due date and files the checked line on your daily note for --on, or for today when left out.

Set INK_URL (default https://commonink.app) and INK_TOKEN (an agent token from Common Ink).`;

export class UsageError extends Error {}

/** Flags that take no value. */
const SWITCHES = new Set(["--preview"]);

/** The flags a command was given, which remembers the ones it looked for: one it never looked for is not its flag. */
class Flags extends Map<string, string> {
  readonly asked = new Set<string>();
  override get(name: string) {
    this.asked.add(name);
    return super.get(name);
  }
  override has(name: string) {
    this.asked.add(name);
    return super.has(name);
  }
}

function parse(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags = new Flags();
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

const read = (answer: string): { next?: string | null; done?: boolean } => {
  try {
    return JSON.parse(answer) as { next?: string | null; done?: boolean };
  } catch {
    return {};
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
    const truth = (_: string, value: string) => value !== "false";

    let tool: string;
    let args: Record<string, unknown> = {};
    switch (command) {
      case "workspaces":
        tool = "list_workspaces";
        break;
      case "members":
        tool = "list_members";
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
        args = { text: flags.get("text") ?? (await io.stdin()), ...given({ folderId: ["folder"], linkTitles: ["link-titles"] }) };
        break;
      case "write":
        if (!flags.has("base")) throw new UsageError("write needs --base, the revision you read");
        tool = "write_note";
        args = { id: needId(), baseRevision: integer("--base", flags.get("base")!), text: flags.get("text") ?? (await io.stdin()), ...given({ writeId: ["write-id"], linkTitles: ["link-titles"], on: ["on"] }) };
        break;
      case "backlinks":
        tool = "backlinks";
        args = { id: needId() };
        break;
      case "links-rebuild":
        tool = "rebuild_links";
        break;
      case "todos":
        tool = "list_todos";
        args = given({
          folderId: ["folder"],
          tag: ["tag"],
          dueFrom: ["due-from"],
          dueTo: ["due-to"],
          noDue: ["no-due", truth],
          importance: ["importance", integers],
          includeCompleted: ["completed", truth],
          noteId: ["note"],
          limit: ["limit", integer],
          offset: ["offset", integer],
        });
        break;
      case "todo-filters":
        tool = "todo_filters";
        break;
      case "todo":
        if (!flags.has("revision") || !flags.has("line") || !flags.has("text")) throw new UsageError("todo needs --revision, --line and --text, as todos gave them");
        tool = "set_todo";
        args = {
          id: needId(),
          revision: integer("--revision", flags.get("revision")!),
          line: integer("--line", flags.get("line")!),
          text: flags.get("text")!,
          ...given({ done: ["done", truth], importance: ["importance", integer], due: ["due", (_, value) => (value === "none" ? null : value)], every: ["every", (_, value) => (value === "none" ? null : value)], on: ["on"] }),
        };
        break;
      case "todo-history":
        if (!flags.has("revision") || !flags.has("line") || !flags.has("text")) throw new UsageError("todo-history needs --revision, --line and --text, as todos gave them");
        tool = "todo_history";
        args = { id: needId(), revision: integer("--revision", flags.get("revision")!), line: integer("--line", flags.get("line")!), text: flags.get("text")! };
        break;
      case "daily":
        tool = "daily_note";
        args = given({ on: ["on"] });
        break;
      case "todos-rebuild":
        tool = "rebuild_todos";
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
        args = given({ noteIds: ["note", ids], authors: ["author", (_, value) => [authorRef(value)]], by: ["by"], from: ["from", time], to: ["to", time], limit: ["limit", integer], before: ["before", json] });
        break;
      case "changes":
        tool = "history";
        args = given({
          noteIds: ["note", ids],
          authors: ["author", (_, value) => [authorRef(value)]],
          by: ["by"],
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
        if (flags.has("author")) {
          if (!flags.has("preview") || flags.has("revision") || flags.has("changes")) throw new UsageError("revert --author takes --preview, and --resolve with --at to preview it settled: revert-author is what reverts an author's changes");
        } else if (flags.has("revision") === flags.has("changes")) throw new UsageError("revert needs --revision, to return to it, or --changes, to revert those");
        if (flags.has("resolve") !== flags.has("at")) throw new UsageError("revert needs --resolve and --at together: how to settle the conflicts, and the revision the preview was of");
        if (flags.has("author")) {
          tool = "preview_revert";
          args = { id: needId(), author: authorRef(flags.get("author")!) };
        } else if (flags.has("preview")) {
          tool = "preview_revert";
          args = flags.has("revision") ? { id: needId(), to: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        } else {
          tool = flags.has("revision") ? "revert_note" : "revert_changes";
          args = flags.has("revision") ? { id: needId(), revision: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        }
        if (flags.has("resolve")) args.resolve = { at: integer("--at", flags.get("at")!), choices: choices(flags.get("resolve")!) };
        break;
      case "revert-author":
        tool = "revert_author";
        args = { author: authorRef(need("an author, as KIND:ID")), ...given({ noteIds: ["note", ids], after: ["after"], resolve: ["resolve", json] }) };
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
    // A flag the command doesn't take is refused, and never dropped: a filter that is left out lists everything.
    const stray = [...flags.keys()].filter((name) => !flags.asked.has(name));
    if (stray.length) throw new UsageError(`${command} doesn't take ${stray.map((name) => `--${name}`).join(" or ")}`);

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
      // These cover a few notes a call, so the command carries on until every note is covered.
      if (tool === "rebuild_links" || tool === "rebuild_todos") {
        if (read(answer).done !== false) return 0;
        continue;
      }
      const next = tool === "revert_author" ? (read(answer).next ?? null) : null;
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
