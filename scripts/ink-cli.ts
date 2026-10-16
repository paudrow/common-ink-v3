import { syntaxText } from "../src/core/query.ts";

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
  notes [--folder ID] [--since TIME] [--tag NAME] [--archived true|only]
                                      the notes in a workspace, in one folder, with a tag, or changed since a time
  search QUERY [--today DAY] [--zone ZONE] [--folder ID] [--archived true|only] [--has-todos true]
        [--sort match|recent|created|title] [--limit N] [--offset N]
                                      the notes a query finds: words, "a phrase", and filters such as
                                      folder:Plans, #tag, editor:@me, updated:>=7d, is:archived, has:link,
                                      with -, OR, NOT and ( ). "ink syntax" lists every one. --today and
                                      --zone are this machine's unless given
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
  todos [QUERY] [--today DAY] [--zone ZONE] [--folder ID] [--tag NAME] [--due-from DAY] [--due-to DAY]
        [--no-due true] [--importance N,N] [--assignee WHO]
        [--assigned-to-me true] [--completed true] [--archived true] [--note ID] [--sort due|priority|changed|note|text] [--limit N] [--offset N]
                                      the todos a query finds, such as "due:<today priority:>=medium", or every
                                      open one with none; --query QUERY is the same. "ink syntax todos" lists
                                      what a query can say
  syntax [todos]                      the query language of search, or of todos
  todo-filters [--archived true]      the tags and assignees that todos can be narrowed by
  todo ID --revision N --line N --text LINE [--done true|false] [--importance N] [--due DAY|none] [--words TEXT]
        [--every RULE|none] [--skip true] [--assign WHO]
        [--unassign WHO] [--on DAY]
                                      check a todo off, change it, or skip a repeating todo to its next
                                      due date; ID, both Ns and LINE are from todos
  todo-history ID --revision N --line N --text LINE
                                      each time a repeating todo was checked off, and by whom
  daily [--on DAY]                    your daily note for a day, made if it isn't there
  todos-rebuild                       the same as links-rebuild
  move ID --folder ID                 put a note in another folder
  folders                             the folders in a workspace
  folder-create NAME [--parent ID]    a new folder
  folder-rename ID --name NAME        give a folder another name
  folder-move ID [--parent ID]        put a folder inside another, or at the top level without --parent
  folder-delete ID                    delete an empty folder
  history ID                          a note's changes and who made them
  diff ID --change N                  what one change did to its note, as a line diff
  blame ID                            who wrote each line of a note: the change that last wrote or edited it
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
  revert-author KIND:ID [--note ID,ID] [--after ID] [--resolve JSON] [--trash-emptied true]
                                      revert every change an author made that still stands; --resolve settles the conflicts of the
                                      notes it names, as {"NOTE ID": {"at": N, "choices": "keep"|"back"|[...]}};
                                      with --trash-emptied the notes that leaves empty go to Trash
  revert-author KIND:ID [--note ID,ID] --preview
                                      what that would do to each note the author changed, with nothing written
  undo ID                             take back your latest change to a note
  redo ID                             revert your latest undo, so what it undid stands again
  sources                             your member's data sources: their calendar and contacts, and whether each is connected
  events --from TIME --to TIME [--timezone ZONE]
                                      your member's calendar events in a span of time
  event-update SOURCE EVENT --etag ETAG [--title TEXT] [--location TEXT] [--description TEXT]
               [--days DAY,DAY | --start TIME --end TIME]
                                      change an event where it is kept; --days makes it all-day, first and last day
  event-new SOURCE CALENDAR --title TEXT (--days DAY,DAY | --start TIME --end TIME)
            [--location TEXT] [--description TEXT]
                                      add an event to one of the calendars events lists
  contacts [QUERY]                    your member's contacts, or those matching every word
  person WHO [--limit N]              a person's page: the member they are, your member's contacts that are
                                      them, their open todos, and the lines that mention them
  refer SOURCE RECORD                 the ::event{...} or ::contact{...} a note writes to reference a record
  record REF                          the event or contact a reference stands for, as it is now
  notes-about SOURCE RECORD           the notes that reference a record, by your member's reference or a teammate's to the same event, and who sees each

A flag a command doesn't take is refused, and nothing is sent.

TIME is anything a date parses, such as 2026-10-09 or 2026-10-09T14:00:00Z. KIND:ID is an author
from authors, such as agent:abc123def456. NEXT is the next of the page before, as JSON.

A link to a note is [[ID]] or [[ID|display text]]. Write [[Title]] and create and write store it by
the id of the one note with that title, or refuse when none or several have it. --link-titles keep
leaves such text as it is.

A mention of a person is @[[ID|Name]] for a member, with ids from members, or @[[Name]] for anyone
else. Write @[[Name]] for a member and create and write store it by their id, or refuse when several
members have the name. --mention-names keep leaves every mention as written. On a todo's line a
mention assigns the todo. WHO is a member's id or a name. A mention gives nobody access.

A todo is a checkbox line in a note, with its options on the line: - [ ] !! Call the bank due:2026-10-14
DAY is a calendar date, YYYY-MM-DD. --importance is the priority: 0 for None, 1 Low (!), 2 Medium (!!), 3 High (!!!).
RULE is how a todo repeats, written every:RULE on its line:
  2w (d, w, m or y)   every N after the due date     3d-after-done      N after it was last done
  mon,thu             those days of every week       2w-mon,thu         of every 2nd week
  3rd-day last-day    that day of every month        2nd-tue last-fri   that weekday of every month
  1st-day,15th-day    several of either, in order    3m-last-fri        of every 3rd month
  mar-1               that date every year           1st-mon-mar        that weekday of that month
  then -until-DAY (none after that day) or -times-N (N more times, counting the one due now)
Checking off a todo that repeats leaves it open with its next due date and files the checked line on
your daily note for --on, or for today when left out. Its last time checks it off for good.

SOURCE is a data source's id from sources, such as google-calendar. EVENT and RECORD are ids from
events and contacts, quoted when they have a space. A reference is your member's alone: nobody else
who reads the note can follow it.

Set INK_URL (default https://commonink.app) and INK_TOKEN (an agent token from Common Ink).`;

export class UsageError extends Error {}

/** The server couldn't be reached or didn't do it, which no other way of asking would change. */
class Failed extends Error {}

/** Flags that take no value. */
const SWITCHES = new Set(["--preview"]);

/** How many notes one preview_reverts call takes, and how many history_summary lists a page. */
const PREVIEWED_A_CALL = 40;
const SUMMARIZED_A_CALL = 100;

/** The flags given. A command reads the ones it takes, and `unread` is the rest: flags it would otherwise drop without a word. */
class Flags {
  private readonly given = new Map<string, string>();
  private readonly read = new Set<string>();
  set(name: string, value: string) {
    this.given.set(name, value);
  }
  has(name: string) {
    this.read.add(name);
    return this.given.has(name);
  }
  get(name: string) {
    this.read.add(name);
    return this.given.get(name);
  }
  unread() {
    return [...this.given.keys()].filter((name) => !this.read.has(name));
  }
}

function parse(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags = new Flags();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { command: "help", positional: [], flags: new Flags() };
    if (SWITCHES.has(arg)) flags.set(arg.slice(2), "");
    else if (arg.startsWith("--")) {
      const value = argv[++i];
      // A switch right after it is the next flag, and never the value that was left out.
      if (value === undefined || SWITCHES.has(value)) throw new UsageError(`${arg} needs a value`);
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
    const id = positional[0];
    // What a query can say is the same for everyone, so it is said with no token.
    if (command === "syntax") {
      if (id !== undefined && id !== "todos") throw new UsageError("syntax takes nothing, or todos");
      io.out(syntaxText(id === "todos" ? "todos" : "notes"));
      return 0;
    }
    if (!token) throw new UsageError("Set INK_TOKEN to an agent token from Common Ink");
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

    /** When an event is: --days makes it all-day, first and last day, and --start with --end two times. Undefined when neither is given. */
    const whenGiven = () => {
      if (flags.has("days") && (flags.has("start") || flags.has("end"))) throw new UsageError(`${command} takes --days, or --start and --end, not both`);
      if (flags.has("start") !== flags.has("end")) throw new UsageError(`${command} needs --start and --end together`);
      const [from, to = from] = (flags.get("days") ?? "").split(",");
      return flags.has("days") ? { allDay: true, from, to } : flags.has("start") ? { allDay: false, from: time("--start", flags.get("start")!), to: time("--end", flags.get("end")!) } : undefined;
    };
    /** What a query's days are read by: this machine's day and zone, unless they are given. */
    const days = () => {
      const now = new Date();
      const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      return { today: flags.get("today") ?? local, zone: flags.get("zone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
    };

    let tool: string;
    let args: Record<string, unknown> = {};
    /** Set by a command that only looks: the author whose revert is previewed, in `noteIds` or in every note they changed. */
    let previewOf: { author: { kind: string; id: string }; noteIds?: string[] } | undefined;
    switch (command) {
      case "workspaces":
        tool = "list_workspaces";
        break;
      case "members":
        tool = "list_members";
        break;
      case "notes":
        tool = "list_notes";
        args = given({ folderId: ["folder"], updatedSince: ["since", time], tag: ["tag"], includeArchived: ["archived", archivedToo] });
        break;
      case "search":
        tool = "search";
        args = { query: need("what to find"), ...days(), ...given({ folderId: ["folder"], includeArchived: ["archived", archivedToo], hasTodos: ["has-todos", truth], sort: ["sort"], limit: ["limit", integer], offset: ["offset", integer] }) };
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
        if (id !== undefined && flags.has("query")) throw new UsageError("todos takes its query once: after the command, or as --query");
        args = {
          ...(id !== undefined && { query: id }),
          ...days(),
          ...given({
            query: ["query"],
            folderId: ["folder"],
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
            sort: ["sort"],
            limit: ["limit", integer],
            offset: ["offset", integer],
          }),
        };
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
          ...given({ done: ["done", truth], importance: ["importance", integer], due: ["due", (_, value) => (value === "none" ? null : value)], every: ["every", (_, value) => (value === "none" ? null : value)], skip: ["skip", truth], assign: ["assign"], unassign: ["unassign"], on: ["on"], words: ["words"] }),
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
      case "folder-move":
        tool = "move_folder";
        args = { id: need("a folder id"), parentId: flags.get("parent") ?? null };
        break;
      case "folder-delete":
        tool = "delete_folder";
        args = { id: need("a folder id") };
        break;
      case "history":
        tool = "note_history";
        args = { id: needId() };
        break;
      case "blame":
        tool = "note_blame";
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
      case "sources":
        tool = "list_sources";
        break;
      case "events":
        tool = "list_events";
        args = { from: time("--from", needFlag("from")), to: time("--to", needFlag("to")), timeZone: flags.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
        break;
      case "event-update": {
        if (positional.length < 2) throw new UsageError("event-update needs a data source and an event id");
        const when = whenGiven();
        tool = "update_event";
        args = { sourceId: positional[0], id: positional[1], etag: needFlag("etag"), ...given({ title: ["title"], location: ["location"], description: ["description"] }), ...(when ? { when } : {}) };
        break;
      }
      case "event-new": {
        if (positional.length < 2) throw new UsageError("event-new needs a data source and a calendar id");
        const when = whenGiven() ?? (() => { throw new UsageError("event-new needs --days, or --start and --end"); })();
        tool = "create_event";
        args = { sourceId: positional[0], calendarId: positional[1], title: needFlag("title"), when, ...given({ location: ["location"], description: ["description"] }) };
        break;
      }
      case "contacts":
        tool = "list_contacts";
        args = id === undefined ? {} : { query: id };
        break;
      case "person":
        tool = "read_person";
        args = { who: need("a member's id or a name"), ...given({ limit: ["limit", integer] }) };
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
      case "notes-about":
        if (positional.length < 2) throw new UsageError("notes-about needs a data source and a record id");
        tool = "notes_about_record";
        args = { sourceId: positional[0], id: positional[1] };
        break;
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
        if (flags.has("preview")) {
          if (flags.has("resolve") || flags.has("after")) throw new UsageError("revert-author --preview takes only --note: preview one note settled with revert ID --author KIND:ID --preview --resolve ... --at N");
          tool = "preview_reverts";
          previewOf = { author: authorRef(need("an author, as KIND:ID")), ...given({ noteIds: ["note", ids] }) };
          break;
        }
        tool = "revert_author";
        args = { author: authorRef(need("an author, as KIND:ID")), ...given({ noteIds: ["note", ids], after: ["after"], resolve: ["resolve", json], trashEmptied: ["trash-emptied", truth] }) };
        break;
      case "undo":
      case "redo":
        tool = command;
        args = { id: needId() };
        break;
      default:
        throw new UsageError(`No such command: ${command}`);
    }
    const workspace = flags.has("workspace") ? { workspace: flags.get("workspace") } : {};
    const unread = flags.unread();
    if (unread.length) throw new UsageError(`${command} doesn't take ${unread.map((name) => `--${name}`).join(" or ")}: nothing was sent. Run ink help for what it takes`);

    const base = (io.env.INK_URL ?? "https://commonink.app").replace(/\/+$/, "");
    const call = async (name: string, given: Record<string, unknown>): Promise<{ answer: string; failed: boolean }> => {
      const res = await io
        .fetch(`${base}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...given, ...workspace } } }),
        })
        .catch((err: unknown) => {
          throw new Failed(`Couldn't reach ${base}: ${err instanceof Error ? err.message : String(err)}`);
        });
      if (res.status === 401) throw new UsageError("Common Ink doesn't know that token: it was mistyped or the agent was disconnected");
      type Answer = { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { code?: number; message?: string } | string; message?: string };
      const body = await (res.json() as Promise<Answer | null>).catch(() => {
        throw new Failed(`${base} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}, and not with JSON`);
      });
      // What isn't a JSON-RPC answer, such as a body too large, says what was wrong as a word and sometimes a sentence.
      if (typeof body?.error === "string" || !body || (!res.ok && !body.error)) throw new Failed(`${base} answered ${res.status}: ${body?.message ?? (typeof body?.error === "string" ? body.error : res.statusText)}`);
      if (body.error) throw new (body.error.code === -32603 ? Failed : UsageError)(body.error.message ?? "Common Ink refused that, and didn't say why");
      return { answer: (body.result?.content ?? []).map((c) => c.text).join("\n"), failed: body.result?.isError === true };
    };

    if (previewOf) {
      const { author } = previewOf;
      let noteIds = previewOf.noteIds;
      if (!noteIds) {
        noteIds = [];
        for (let before: unknown; ; ) {
          const { answer, failed } = await call("history_summary", { authors: [author], limit: SUMMARIZED_A_CALL, ...(before ? { before } : {}) });
          if (failed) return io.out(answer), 1;
          const page = json("The list of what the author changed", answer) as { notes?: { noteId: string }[]; next?: unknown };
          noteIds.push(...(page.notes ?? []).map((changed) => changed.noteId));
          if (!(before = page.next)) break;
        }
      }
      // One list however many calls it took, so what is printed is one JSON document.
      const previews: unknown[] = [];
      for (let from = 0; from < noteIds.length; from += PREVIEWED_A_CALL) {
        const { answer, failed } = await call("preview_reverts", { changes: noteIds.slice(from, from + PREVIEWED_A_CALL).map((noteId) => ({ noteId, author })) });
        if (failed) return io.out(answer), 1;
        previews.push(...(json("A preview", answer) as unknown[]));
      }
      io.out(JSON.stringify(previews));
      return 0;
    }

    for (;;) {
      const { answer, failed } = await call(tool, args);
      io.out(answer);
      if (failed) return 1;
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
    if (err instanceof Failed) {
      io.out(`ink: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
