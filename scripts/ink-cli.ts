// The `ink` command's logic, for an agent working from a shell. It is a thin client of the /mcp endpoint,
// so it does what the MCP tools do and nothing more. scripts/ink.ts runs it on this machine.
import { writtenUpload, type UploadEmbed } from "../src/core/uploadRefs.ts";

export interface Io {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** The text piped in, when there is any. */
  stdin: () => Promise<string>;
  out: (line: string) => void;
  /** The bytes of a file on this machine, for upload. */
  readFile?: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  /** Writes a file on this machine, for download. Answers false, and writes nothing, when there is one at `path` and `replace` is false. */
  writeFile?: (path: string, bytes: Uint8Array, replace: boolean) => Promise<boolean>;
}

export const USAGE = `Usage: ink [--workspace ID] <command>

  workspaces                          the workspaces you can reach
  members                             everyone in a workspace, with their role
  plugins                             the plugins installed in a workspace, and what each is permitted
  notes [--folder ID] [--since TIME] [--tag NAME] [--archived true|only]
                                      the notes in a workspace, in one folder, with a tag, or changed since a time
  search QUERY [--folder ID] [--archived true|only] [--has-todos true] [--sort match|recent|created|title] [--limit N] [--offset N]
                                      the notes whose text has every word; "a phrase", #tag and +project narrow it
  tags [--archived true]              the tags of the notes you can see, and how many notes have each
  archive ID                          archive a note: kept, and left out of listings
  unarchive ID                        bring an archived note back
  trash ID                            move a note to Trash, where it waits 30 days
  restore ID                          bring a note back from Trash, to the folder it was in
  trashed                             the notes in Trash, and when each is removed for good
  read ID [--revision N]              a note's markdown, and the titles of the notes it links to
  create [--text TEXT] [--folder ID] [--link-titles keep] [--mention-names keep]
                                      a new note (text from stdin if --text is left out)
  write ID --base N [--text TEXT] [--write-id ANY] [--link-titles keep] [--mention-names keep] [--on DAY]
                                      replace a note's text (from stdin if --text is left out)
  backlinks ID                        the notes that link to a note
  links-rebuild                       make backlinks and the index of todos again from the notes' text
  todos [--project NAME] [--tag NAME] [--due-from DAY] [--due-to DAY] [--no-due true] [--importance N,N]
        [--assignee WHO] [--assigned-to-me true] [--completed true] [--archived true] [--note ID]
        [--limit N] [--offset N]
                                      the todos in the notes you can see, open ones unless --completed
  todo-filters [--archived true]      the projects, assignees and tags that todos can be narrowed by
  todo ID --revision N --line N --text LINE [--done true|false] [--importance N] [--due DAY|none]
        [--add-project NAME] [--remove-project NAME] [--every RULE|none] [--assign WHO]
        [--unassign WHO] [--on DAY]
                                      check a todo off or change it; ID, both Ns and LINE are from todos
  todo-history ID --revision N --line N --text LINE
                                      each time a recurring todo was checked off, and by whom
  daily [--on DAY]                    your daily note for a day, made if it isn't there
  daily-find [--on DAY]               your daily note for a day when there is one; nothing is made
  pins [--archived true]              the notes pinned to your member's dashboard
  pin ID                              pin a note to your member's dashboard
  unpin ID                            take the pin away
  visit                               how far your member has read the changes in the workspace
  todos-rebuild                       the same as links-rebuild
  move ID --folder ID                 put a note in another folder
  uploads [--folder ID] [--archived true]
                                      the uploads in a workspace, or in one folder
  upload FILE [--folder ID] [--name NAME]
                                      put a file in a folder, or in Unsorted, and say how a note shows it
  download ID [--out PATH] [--force true]
                                      save an upload's bytes under its name here, or at PATH
  upload-info ID                      one upload, and the notes that refer to it
  upload-move ID --folder ID          put an upload in another folder
  upload-archive ID                   archive an upload: kept, and left out of listings
  upload-unarchive ID                 bring an archived upload back
  upload-trash ID                     move an upload to Trash, where it waits 30 days
  upload-restore ID                   bring an upload back from Trash, to the folder it was in
  uploads-trashed                     the uploads in Trash, and when each is removed for good
  folders                             the folders in a workspace
  folder-create NAME [--parent ID]    a new folder
  folder-rename ID --name NAME        give a folder another name
  folder-delete ID                    delete an empty folder
  history ID                          a note's changes and who made them
  diff ID --change N                  what one change did to its note, as a line diff
  changed [--note ID,ID] [--author KIND:ID] [--from TIME] [--to TIME] [--limit N] [--before NEXT]
                                      the notes that changed, latest first, with the lines added and removed in each
  changes [--note ID,ID] [--author KIND:ID] [--not-author KIND:ID] [--from TIME] [--to TIME] [--limit N]
          [--before NEXT] [--diffs false]
                                      changes across the workspace, newest first, with diffs
  authors                             everyone who has changed a note
  label ID --revision N [--name NAME] name a revision, or take its name away without --name
  revert ID --revision N              put a note back to a revision, as a new change
  revert ID --changes N,N             revert chosen changes, as one new change; revert a revert to have its changes again
  revert-author KIND:ID [--note ID,ID] [--after ID] [--trash-emptied true]
                                      revert every change an author made that still stands,
                                      and with --trash-emptied move the notes that leaves empty to Trash
  undo ID                             take back your latest change to a note
  redo ID                             revert your latest undo, so what it undid stands again
  sources                             your member's data sources: their calendar and contacts, and whether each is connected
  events --from TIME --to TIME [--timezone ZONE]
                                      your member's calendar events in a span of time
  event-update SOURCE EVENT --etag ETAG [--title TEXT] [--location TEXT] [--description TEXT]
               [--days DAY,DAY | --start TIME --end TIME]
                                      change an event where it is kept; --days makes it all-day, first and last day
  contacts [QUERY]                    your member's contacts, or those matching every word
  refer SOURCE RECORD                 the ::event{...} or ::contact{...} a note writes to reference a record
  record REF                          the event or contact a reference stands for, as it is now

TIME is anything a date parses, such as 2026-10-09 or 2026-10-09T14:00:00Z. KIND:ID is an author
from authors, such as agent:abc123def456. NEXT is the next of the page before, as JSON.

A link to a note is [[ID]] or [[ID|display text]]. Write [[Title]] and create and write store it by
the id of the one note with that title, or refuse when none or several have it. --link-titles keep
leaves such text as it is.

A mention of a person is @[[ID|Name]] for a member, with ids from members, or @[[Name]] for anyone
else. Write @[[Name]] for a member and create and write store it by their id, or refuse when several
members have the name. --mention-names keep leaves every mention as written. On a todo's line a
mention assigns the todo. WHO is a member's id or a name. A mention gives nobody access.

A todo is a checkbox line in a note, with its options on the line: - [ ] !! Call the bank due:2026-10-14 +Home
DAY is a calendar date, YYYY-MM-DD. Importance is 0 for normal and 1 to 3 for !, !! and !!!.
RULE is how a todo recurs, written every:RULE on its line: 2w (d, w, m or y), mon,thu, 3d-after-done,
3rd-day, last-day, 2nd-tue, last-fri. Checking off a todo that recurs leaves it open with
its next due date and files the checked line on your daily note for --on, or for today when left out.

SOURCE is a data source's id from sources, such as google-calendar. EVENT and RECORD are ids from
events and contacts, quoted when they have a space. A reference is your member's alone: nobody else
who reads the note can follow it.

A note shows an upload with a line of its own: ::image{ID WIDTHxHEIGHT}, ::video{ID WIDTHxHEIGHT},
::audio{ID} or ::file{ID}. upload prints the line for the file it sent. A file can be at most 50 MB,
and download never replaces a file that is there unless --force true.

Set INK_URL (default https://commonink.app) and INK_TOKEN (an agent token from Common Ink).`;

export class UsageError extends Error {}

function parse(argv: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
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

const read = (answer: string): { next?: string | null; done?: boolean } => {
  try {
    return JSON.parse(answer) as { next?: string | null; done?: boolean };
  } catch {
    return {};
  }
};

/** What is left of a name after its folders, so a name can never say where on this machine a file goes. */
const lastPart = (name: string) => name.split(/[/\\]/).at(-1) ?? "";

interface Sent {
  id: string;
  kind: UploadEmbed;
  width: number | null;
  height: number | null;
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
    const need = (what: string) => id ?? (() => { throw new UsageError(`${command} needs ${what}`); })();
    const needId = () => need("a note id");
    const needFlag = (name: string) => flags.get(name) ?? (() => { throw new UsageError(`${command} needs --${name}`); })();
    /** The flags given, each as the argument it sets. */
    const given = (as: Record<string, [flag: string, read?: (name: string, value: string) => unknown]>) =>
      Object.fromEntries(Object.entries(as).flatMap(([arg, [flag, read]]) => (flags.has(flag) ? [[arg, read ? read(`--${flag}`, flags.get(flag)!) : flags.get(flag)!]] : [])));
    const ids = (_: string, value: string) => value.split(",");
    const author = (_: string, value: string) => authorRef(value);
    const truth = (_: string, value: string) => value !== "false";
    const archivedToo = (_: string, value: string) => (value === "only" ? "only" : value !== "false");

    const base = (io.env.INK_URL ?? "https://commonink.app").replace(/\/+$/, "");
    const UNKNOWN_TOKEN = "Common Ink doesn't know that token: it was mistyped or the agent was disconnected";
    const call = async (tool: string, args: Record<string, unknown>): Promise<{ answer: string; isError: boolean }> => {
      const res = await io.fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      if (res.status === 401) throw new UsageError(UNKNOWN_TOKEN);
      const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
      if (body.error) throw new UsageError(body.error.message);
      return { answer: (body.result?.content ?? []).map((c) => c.text).join("\n"), isError: !!body.result?.isError };
    };

    // A file's bytes go over HTTP and not through a tool, at an address that names the workspace.
    if (command === "upload" || command === "download") {
      const { readFile, writeFile } = io;
      if (!readFile || !writeFile) throw new UsageError(`${command} needs files, which this ink has none of`);
      let workspace = flags.get("workspace");
      if (workspace === undefined) {
        const listed = await call("list_workspaces", {});
        const reach = ((JSON.parse(listed.answer) as { workspaces?: Array<{ id: string }> }).workspaces ?? []).map((w) => w.id);
        if (reach.length !== 1) throw new UsageError(`Pass --workspace: you can reach ${reach.length} (${reach.join(", ")})`);
        workspace = reach[0]!;
      }
      const uploads = `${base}/api/workspaces/${encodeURIComponent(workspace)}/uploads`;
      const refusal = async (res: Response) => {
        if (res.status === 401) throw new UsageError(UNKNOWN_TOKEN);
        const told = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        io.out(told?.error ? `${told.error}: ${told.message ?? ""}`.trim() : `Common Ink answered ${res.status}`);
        return 1;
      };

      if (command === "upload") {
        const path = need("a file");
        const name = flags.get("name") ?? lastPart(path);
        const bytes = await readFile(path).catch(() => {
          throw new UsageError(`Can't read ${path}`);
        });
        const res = await io.fetch(uploads, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name, ...given({ folderId: ["folder"] }) })) },
          body: bytes,
        });
        if (res.status !== 201) return refusal(res);
        const sent = (await res.json()) as Sent;
        io.out(JSON.stringify(sent, null, 2));
        io.out(`In a note: ${writtenUpload(sent.kind, sent.id, sent.width && sent.height ? { width: sent.width, height: sent.height } : null)}`);
        return 0;
      }

      const uploadId = need("an upload id");
      const info = await call("read_upload", { id: uploadId, workspace });
      if (info.isError) {
        io.out(info.answer);
        return 1;
      }
      // The name is somebody else's words. Only its last part is used, so it can't name another directory.
      const named = lastPart((JSON.parse(info.answer) as { name: string }).name);
      const path = flags.get("out") ?? named;
      if (!flags.has("out") && (!named || named === "." || named === "..")) throw new UsageError("That upload's name can't be a file's here. Pass --out");
      const res = await io.fetch(`${uploads}/${encodeURIComponent(uploadId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 200) return refusal(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!(await writeFile(path, bytes, flags.get("force") === "true"))) throw new UsageError(`${path} is already there. Pass --force true to replace it, or --out for another place`);
      io.out(`Saved ${path} (${bytes.byteLength} bytes, ${res.headers.get("Content-Type")})`);
      return 0;
    }

    let tool: string;
    let args: Record<string, unknown> = {};
    switch (command) {
      case "workspaces":
        tool = "list_workspaces";
        break;
      case "members":
        tool = "list_members";
        break;
      case "plugins":
        tool = "list_plugins";
        break;
      case "notes":
        tool = "list_notes";
        args = given({ folderId: ["folder"], updatedSince: ["since", time], tag: ["tag"], includeArchived: ["archived", archivedToo] });
        break;
      case "search":
        tool = "search";
        args = { query: need("what to find"), ...given({ folderId: ["folder"], includeArchived: ["archived", archivedToo], hasTodos: ["has-todos", truth], sort: ["sort"], limit: ["limit", integer], offset: ["offset", integer] }) };
        break;
      case "tags":
        tool = "list_tags";
        args = given({ includeArchived: ["archived", truth] });
        break;
      case "archive":
      case "unarchive":
        tool = "archive_note";
        args = { id: needId(), archived: command === "archive" };
        break;
      case "trash":
      case "restore":
        tool = `${command}_note`;
        args = { id: needId() };
        break;
      case "trashed":
        tool = "list_trash";
        break;
      case "read":
        tool = "read_note";
        args = { id: needId(), ...(flags.has("revision") ? { revision: integer("--revision", flags.get("revision")!) } : {}) };
        break;
      case "create":
        tool = "create_note";
        args = { text: flags.get("text") ?? (await io.stdin()), ...given({ folderId: ["folder"], linkTitles: ["link-titles"], mentionNames: ["mention-names"] }) };
        break;
      case "write":
        if (!flags.has("base")) throw new UsageError("write needs --base, the revision you read");
        tool = "write_note";
        args = { id: needId(), baseRevision: integer("--base", flags.get("base")!), text: flags.get("text") ?? (await io.stdin()), ...given({ writeId: ["write-id"], linkTitles: ["link-titles"], mentionNames: ["mention-names"], on: ["on"] }) };
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
          project: ["project"],
          tag: ["tag"],
          dueFrom: ["due-from"],
          dueTo: ["due-to"],
          noDue: ["no-due", truth],
          importance: ["importance", integers],
          assignee: ["assignee"],
          assignedToMe: ["assigned-to-me", truth],
          includeCompleted: ["completed", truth],
          includeArchived: ["archived", truth],
          noteId: ["note"],
          limit: ["limit", integer],
          offset: ["offset", integer],
        });
        break;
      case "todo-filters":
        tool = "todo_filters";
        args = given({ includeArchived: ["archived", truth] });
        break;
      case "todo":
        if (!flags.has("revision") || !flags.has("line") || !flags.has("text")) throw new UsageError("todo needs --revision, --line and --text, as todos gave them");
        tool = "set_todo";
        args = {
          id: needId(),
          revision: integer("--revision", flags.get("revision")!),
          line: integer("--line", flags.get("line")!),
          text: flags.get("text")!,
          ...given({ done: ["done", truth], importance: ["importance", integer], due: ["due", (_, value) => (value === "none" ? null : value)], addProject: ["add-project"], removeProject: ["remove-project"], every: ["every", (_, value) => (value === "none" ? null : value)], assign: ["assign"], unassign: ["unassign"], on: ["on"] }),
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
      case "daily-find":
        tool = "find_daily_note";
        args = given({ on: ["on"] });
        break;
      case "pins":
        tool = "list_pins";
        args = given({ includeArchived: ["archived", truth] });
        break;
      case "pin":
      case "unpin":
        tool = "pin_note";
        args = { id: needId(), pinned: command === "pin" };
        break;
      case "visit":
        tool = "last_visit";
        break;
      case "todos-rebuild":
        tool = "rebuild_todos";
        break;
      case "move":
        tool = "move_note";
        args = { id: needId(), folderId: needFlag("folder") };
        break;
      case "uploads":
        tool = "list_uploads";
        args = given({ folderId: ["folder"], includeArchived: ["archived", truth] });
        break;
      case "upload-info":
        tool = "read_upload";
        args = { id: need("an upload id") };
        break;
      case "upload-move":
        tool = "move_upload";
        args = { id: need("an upload id"), folderId: needFlag("folder") };
        break;
      case "upload-archive":
      case "upload-unarchive":
        tool = "archive_upload";
        args = { id: need("an upload id"), archived: command === "upload-archive" };
        break;
      case "upload-trash":
      case "upload-restore":
        tool = `${command.slice("upload-".length)}_upload`;
        args = { id: need("an upload id") };
        break;
      case "uploads-trashed":
        tool = "list_trashed_uploads";
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
          notAuthors: ["not-author", (_, value) => [authorRef(value)]],
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
      case "sources":
        tool = "list_sources";
        break;
      case "events":
        tool = "list_events";
        args = { from: time("--from", needFlag("from")), to: time("--to", needFlag("to")), timeZone: flags.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
        break;
      case "event-update": {
        if (positional.length < 2) throw new UsageError("event-update needs a data source and an event id");
        if (flags.has("days") && (flags.has("start") || flags.has("end"))) throw new UsageError("event-update takes --days, or --start and --end, not both");
        if (flags.has("start") !== flags.has("end")) throw new UsageError("event-update needs --start and --end together");
        const [from, to = from] = (flags.get("days") ?? "").split(",");
        const when = flags.has("days") ? { allDay: true, from, to } : flags.has("start") ? { allDay: false, from: time("--start", flags.get("start")!), to: time("--end", flags.get("end")!) } : undefined;
        tool = "update_event";
        args = { sourceId: positional[0], id: positional[1], etag: needFlag("etag"), ...given({ title: ["title"], location: ["location"], description: ["description"] }), ...(when ? { when } : {}) };
        break;
      }
      case "contacts":
        tool = "list_contacts";
        args = id === undefined ? {} : { query: id };
        break;
      case "refer":
        if (positional.length < 2) throw new UsageError("refer needs a data source and a record id");
        tool = "refer_record";
        args = { sourceId: positional[0], id: positional[1] };
        break;
      case "record":
        tool = "read_record";
        args = { ref: need("a reference") };
        break;
      case "label":
        if (!flags.has("revision")) throw new UsageError("label needs --revision");
        tool = "label_revision";
        args = { id: needId(), revision: integer("--revision", flags.get("revision")!), name: flags.get("name") ?? null };
        break;
      case "revert":
        if (flags.has("revision") === flags.has("changes")) throw new UsageError("revert needs --revision, to return to it, or --changes, to revert those");
        tool = flags.has("revision") ? "revert_note" : "revert_changes";
        args = flags.has("revision") ? { id: needId(), revision: integer("--revision", flags.get("revision")!) } : { id: needId(), revisions: integers("--changes", flags.get("changes")!) };
        break;
      case "revert-author":
        tool = "revert_author";
        args = { author: authorRef(need("an author, as KIND:ID")), ...given({ noteIds: ["note", ids], after: ["after"], trashEmptied: ["trash-emptied", truth] }) };
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

    for (;;) {
      const { answer, isError } = await call(tool, args);
      io.out(answer);
      if (isError) return 1;
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
