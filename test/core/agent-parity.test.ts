import { describe, expect, it } from "vitest";
import { run, type Io } from "../../scripts/ink-cli.ts";
import { z } from "zod";
import { Id, Op, type OpInput, type OpType } from "../../src/core/protocol.ts";
import { RULE_GRAMMAR } from "../../src/core/recurrence.ts";
import { SCOPES, syntax } from "../../src/core/query.ts";
import { NOT_FOR_AGENTS, OVER_HTTP, callTool, opArguments, toolList, TOOLS, type Caller } from "../../src/worker/mcp/tools.ts";

const ID = "aaaaaaaaaaaa";
const AUTHOR = `agent:${ID}`;

/** Each operation and the fields it takes, read from the schema the web app's requests are checked against. */
const OPS = new Map(Op.options.map((option) => [option.shape.type.value as OpType, Object.keys(option.shape).filter((key) => key !== "type")]));

const argumentsOf = (tool: (typeof TOOLS)[number]) => Object.keys((tool.inputSchema as { properties: object }).properties).filter((key) => key !== "workspaceId");

/** For each tool, `ink` commands that between them set every argument the tool takes. */
const COMMANDS: Record<string, string[][]> = {
  list_workspaces: [["workspaces"]],
  list_members: [["members"]],
  list_plugins: [["plugins"]],
  scaffold_plugin: [["plugin-new", "Greeter"]],
  validate_plugin: [["plugin-validate", "--manifest", '{"name":"Greeter"}', "--code", "ink.notify(1)"]],
  read_plugin: [["plugin", ID]],
  install_plugin: [["plugin-install", "--manifest", '{"name":"Greeter"}', "--code", "ink.notify(1)", "--replaces", ID]],
  uninstall_plugin: [["plugin-uninstall", ID]],
  permit_plugin: [["plugin-permit", ID, "--capability", "notes.read", "--allowed", "true", "--locked", "false", "--origins", "https://a.example", "--code-hash", "a".repeat(64)]],
  request_plugin_permission: [["plugin-request", "html", "--capability", "network", "--origins", "https://a.example"]],
  list_plugin_proposals: [["plugin-proposals"]],
  list_drafts: [["drafts"]],
  read_draft: [["draft", ID]],
  save_draft: [["draft-save", ID, "--manifest", '{"name":"Greeter"}', "--code", "ink.notify(1)", "--running", "true", "--base-hash", "none"]],
  discard_draft: [["draft-discard", ID]],
  list_notes: [["notes", "--folder", ID, "--since", "2026-10-01", "--tag", "money", "--archived", "true", "--limit", "5", "--after", "WzEsImEiXQ"]],
  search: [["search", "budget #money", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--archived", "only", "--has-todos", "true", "--sort", "title", "--limit", "5", "--after", "WzEsImEiXQ"]],
  list_tags: [["tags", "--name", "money", "--archived", "true", "--limit", "5", "--after", "WyJhIl0"]],
  describe_tag: [["tag-describe", "money", "--description", "Bills and budgets"]],
  archive_note: [["archive", ID], ["unarchive", ID]],
  trash_note: [["trash", ID]],
  restore_note: [["restore", ID]],
  list_trash: [["trashed", "--limit", "5", "--after", "WzEsImEiXQ"]],
  read_note: [["read", ID, "--revision", "1", "--from", "1", "--to", "3", "--numbered", "true"]],
  note_syntax: [["note-syntax"]],
  create_note: [["create", "--text", "# Hi", "--folder", ID, "--write-id", "w1", "--link-titles", "keep", "--mention-names", "keep", "--new-tags", "money,bills"]],
  write_note: [["write", ID, "--base", "1", "--text", "# Hi", "--write-id", "w1", "--link-titles", "keep", "--mention-names", "keep", "--new-tags", "money", "--on", "2026-10-11"]],
  edit_note: [["edit", ID, "--base", "1", "--edits", '[{"from":1,"to":2,"text":"Hi"}]', "--write-id", "w1", "--link-titles", "keep", "--mention-names", "keep", "--new-tags", "money", "--on", "2026-10-11"]],
  backlinks: [["backlinks", ID]],
  rebuild_links: [["links-rebuild"]],
  list_todos: [["todos", "due:<today -tag:someday", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--tag", "money", "--due-from", "2026-10-01", "--due-to", "2026-10-31", "--no-due", "false", "--importance", "2,3", "--assignee", "Sam Okafor", "--assigned-to-me", "true", "--completed", "true", "--archived", "true", "--note", ID, "--sort", "priority", "--limit", "5", "--after", "WzEsImEiXQ"]],
  todo_filters: [["todo-filters", "--archived", "true"]],
  set_todo: [["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call", "--done", "true", "--importance", "2", "--due", "none", "--every", "2w", "--assign", "Sam Okafor", "--unassign", ID, "--on", "2026-10-11", "--words", "Call the bank #money", "--new-tags", "money"], ["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w", "--skip", "true"], ["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call", "--state", "backlog"]],
  todo_history: [["todo-history", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w"]],
  daily_note: [["daily", "--on", "2026-10-11"]],
  find_daily_note: [["daily-find", "--on", "2026-10-11"]],
  list_pins: [["pins", "--archived", "true"]],
  pin_note: [["pin", ID], ["unpin", ID]],
  last_visit: [["visit"]],
  rebuild_todos: [["todos-rebuild"]],
  move_note: [["move", ID, "--folder", ID]],
  list_uploads: [["uploads", "type:image uploader:@me", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--archived", "true", "--limit", "5", "--after", "WzEsImEiXQ"]],
  place_upload: [["upload-place", ID, "--note", ID]],
  read_upload: [["upload-info", ID]],
  move_upload: [["upload-move", ID, "--folder", ID]],
  archive_upload: [["upload-archive", ID], ["upload-unarchive", ID]],
  trash_upload: [["upload-trash", ID]],
  restore_upload: [["upload-restore", ID]],
  list_trashed_uploads: [["uploads-trashed"]],
  start_upload: [["upload-start", "episode.mp3", "--size", "123", "--folder", ID, "--private", "false", "--write-id", "w1"]],
  resume_upload: [["upload-resume", ID]],
  finish_upload: [["upload-finish", ID]],
  abort_upload: [["upload-abort", ID]],
  upload_file: [["upload-inline", "dot.png", "--base64", "iVBORw0K", "--folder", ID, "--write-id", "w1"]],
  plan_export: [["export-plan", "--part-bytes", "1000", "--part-files", "10"]],
  list_folders: [["folders"]],
  find_folder: [["folder-find", "Projects/Skills"]],
  create_folder: [["folder-create", "Plans", "--parent", ID, "--if-exists", "error"]],
  rename_folder: [["folder-rename", ID, "--name", "Plans"]],
  move_folder: [["folder-move", ID, "--parent", ID]],
  delete_folder: [["folder-delete", ID]],
  note_history: [["history", ID]],
  change_diff: [["diff", ID, "--change", "2"]],
  note_blame: [["blame", ID]],
  history_summary: [["changed", "--note", ID, "--author", AUTHOR, "--by", "agents", "--from", "2026-10-01", "--to", "2026-10-02", "--limit", "5", "--before", `{"lastAt":1,"noteId":"${ID}"}`]],
  history: [["changes", "--note", ID, "--author", AUTHOR, "--not-author", AUTHOR, "--by", "people", "--from", "2026-10-01", "--to", "2026-10-02", "--limit", "5", "--before", `{"createdAt":1,"noteId":"${ID}","revision":1}`, "--diffs", "false"]],
  history_authors: [["authors"]],
  history_diff: [["diffs", `${ID}:1,2`]],
  preview_reverts: [["revert-many", `${ID}:1,2`, "--preview"]],
  revert_many: [["revert-many", `${ID}:1,2@3`, "--resolve", "back"]],
  label_revision: [["label", ID, "--revision", "1", "--name", "Draft"]],
  revert_note: [["revert", ID, "--revision", "1", "--resolve", "back", "--at", "3"]],
  revert_changes: [["revert", ID, "--changes", "1,2", "--resolve", '["keep", {"text": "by hand"}]', "--at", "3"]],
  preview_revert: [
    ["revert", ID, "--changes", "1,2", "--preview"],
    ["revert", ID, "--revision", "1", "--preview"],
    ["revert", ID, "--author", AUTHOR, "--preview", "--resolve", "keep", "--at", "3"],
  ],
  revert_author: [["revert-author", AUTHOR, "--note", ID, "--after", ID, "--resolve", `{"${ID}": {"at": 3, "choices": "back"}}`, "--trash-emptied", "true"]],
  undo: [["undo", ID]],
  redo: [["redo", ID]],
  list_sources: [["sources"]],
  list_events: [["events", "--from", "2026-10-11", "--to", "2026-10-18", "--timezone", "America/Chicago"]],
  update_event: [
    ["event-update", "google-calendar", "ada@example.com lunch", "--etag", '"1"', "--title", "Lunch", "--location", "Cafe", "--description", "Bring it", "--days", "2026-10-14,2026-10-15"],
    ["event-update", "google-calendar", "ada@example.com lunch", "--etag", '"1"', "--start", "2026-10-14T17:00:00Z", "--end", "2026-10-14T18:00:00Z"],
  ],
  create_event: [
    ["event-new", "google-calendar", "ada@example.com", "--title", "Lunch", "--location", "Cafe", "--description", "Bring it", "--days", "2026-10-14,2026-10-15"],
    ["event-new", "google-calendar", "ada@example.com", "--title", "Lunch", "--start", "2026-10-14T17:00:00Z", "--end", "2026-10-14T18:00:00Z"],
  ],
  list_contacts: [["contacts", "sam"]],
  read_person: [["person", "Sam Okafor", "--limit", "5"]],
  refer_record: [["refer", "google-contacts", "people/c1"]],
  read_record: [["record", ID]],
  notes_about_record: [["notes-about", "google-calendar", "primary e1"]],
};
/** Tools whose ink command answers on this machine, with no token, as the tool would. */
const OFFLINE = ["query_syntax"];

describe("what an agent can do, against what the web app can", () => {
  it("has one tool for every operation, or a reason it has none", () => {
    for (const type of OPS.keys()) {
      const tools = TOOLS.filter((t) => t.op === type).map((t) => t.name);
      if (NOT_FOR_AGENTS[type]) expect(tools, `${type} is kept from agents, so it has no tool`).toEqual([]);
      else if (OVER_HTTP[type]) expect(tools, `${type} is done over HTTP, so it has no tool`).toEqual([]);
      else expect(tools, `${type} needs a tool in src/worker/mcp/tools.ts, a reason in NOT_FOR_AGENTS, or an address in OVER_HTTP`).toHaveLength(1);
    }
    expect(Object.keys(NOT_FOR_AGENTS).filter((type) => !OPS.has(type as OpType))).toEqual([]);
    expect(Object.keys(OVER_HTTP).filter((type) => !OPS.has(type as OpType))).toEqual([]);
    expect(Object.keys(OVER_HTTP).filter((type) => type in NOT_FOR_AGENTS), "an operation is kept from agents or done over HTTP, not both").toEqual([]);
  });

  it("has an ink command for every operation done over HTTP: upload sends a file's parts to their address from disk, and download and export send the token to the bytes' address", async () => {
    expect(Object.keys(OVER_HTTP).sort()).toEqual(["export.open", "upload.create", "upload.open", "upload.part"]);
    const WS = "wwwwwwwwwwww";
    const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d);
    const requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const written: { path: string; bytes: number[]; replace: boolean }[] = [];
    const out: string[] = [];
    const uploaded = { id: ID, name: "cat.png", type: "image/png", kind: "image", size: 5, width: 640, height: 480 };
    const sending = { id: ID, name: "cat.png", size: 5, kind: "image", partSize: 2, partCount: 3, stored: [] as number[], address: "https://ink.test/api/upload-parts/first/{part}", expiresAt: 1 };
    let failOnce = new Set<string>();
    const tools: Record<string, unknown> = {
      list_workspaces: { workspaces: [{ id: WS }] },
      read_upload: { ...uploaded, name: "../../etc/cat.png" },
      start_upload: sending,
      resume_upload: { ...sending, stored: [1, 3], address: "https://ink.test/api/upload-parts/fresh/{part}" },
      finish_upload: { ...uploaded, line: `::image{${ID} 640x480}` },
    };
    const io: Io = {
      env: { INK_TOKEN: "cink_x", INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line) => out.push(line),
      wait: async () => {},
      sizeOf: async (path) => (path === "pictures/cat.png" ? PNG_BYTES.byteLength : Promise.reject(new Error("no such file"))),
      readPart: async (path, offset, length) => (path === "pictures/cat.png" ? PNG_BYTES.slice(offset, offset + length) : Promise.reject(new Error("no such file"))),
      writeFile: async (path, bytes, replace) => {
        if (path === "taken.png" && !replace) return false;
        written.push({ path, bytes: [...bytes], replace });
        return true;
      },
      fetch: (async (url: string, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>;
        if (url === "https://ink.test/mcp") {
          const { name, arguments: args } = JSON.parse(init.body as string).params;
          calls.push({ name, args });
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(tools[name]) }] } });
        }
        requests.push({ method: init.method ?? "GET", url, headers, body: init.body instanceof Uint8Array ? [...init.body] : init.body });
        if (failOnce.delete(url)) return Response.json({ error: "invalid", message: "the connection dropped" }, { status: 400 });
        return init.method === "PUT" ? Response.json({ id: ID }) : new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
      }) as unknown as typeof fetch,
    };

    expect(await run(["upload", "pictures/cat.png", "--folder", ID], io)).toBe(0);
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ["start_upload", { name: "cat.png", size: 5, folderId: ID }],
      ["finish_upload", { uploadId: ID }],
    ]);
    // No token goes to a part's address: the address is the permission.
    expect(requests.sort((a, b) => a.url.localeCompare(b.url))).toEqual(
      [1, 2, 3].map((n) => ({ method: "PUT", url: `https://ink.test/api/upload-parts/first/${n}`, headers: { "Content-Type": "application/octet-stream" }, body: [...PNG_BYTES.slice((n - 1) * 2, n * 2)] })),
    );
    expect(out.at(-1)).toBe(`In a note: ::image{${ID} 640x480}`);

    // A part that doesn't get through is sent again, to a fresh address, and only the parts not stored are.
    requests.length = calls.length = 0;
    failOnce = new Set(["https://ink.test/api/upload-parts/first/2"]);
    expect(await run(["upload", "pictures/cat.png", "--name", "Tabby.png", "--workspace", "vvvvvvvvvvvv"], io)).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(["start_upload", "resume_upload", "finish_upload"]);
    expect(calls[0]!.args).toEqual({ name: "Tabby.png", size: 5, workspaceId: "vvvvvvvvvvvv" });
    expect(requests.map((r) => r.url).sort()).toEqual(["https://ink.test/api/upload-parts/first/1", "https://ink.test/api/upload-parts/first/2", "https://ink.test/api/upload-parts/first/3", "https://ink.test/api/upload-parts/fresh/2"]);
    expect(out).toContain("Part 2 didn't get through: the connection dropped");

    // One that never gets through stops, and says how to go on.
    requests.length = calls.length = 0;
    tools.resume_upload = { ...sending, stored: [1, 3], address: "https://ink.test/api/upload-parts/dead/{part}" };
    const dead = { has: (url: string) => url.endsWith("/2"), delete: (url: string) => url.endsWith("/2") } as unknown as Set<string>;
    failOnce = dead;
    expect(await run(["upload", "pictures/cat.png"], io)).toBe(1);
    expect(out.at(-1)).toBe(`ink: Parts 2 didn't get through. Nothing sent is lost: ink upload-resume ${ID} says what is left, and upload-abort throws it away`);
    expect(calls.map((c) => c.name).filter((name) => name === "finish_upload")).toEqual([]);
    expect(await run(["upload", "pictures/missing.png"], io)).toBe(2);
    expect(await run(["upload", "pictures/cat.png", "--color", "red"], io), "a flag it doesn't take, before anything is sent").toBe(2);

    requests.length = 0;
    expect(await run(["download", ID], io)).toBe(0);
    expect(requests).toEqual([{ method: "GET", url: `https://ink.test/api/workspaces/${WS}/uploads/${ID}`, headers: { Authorization: "Bearer cink_x" }, body: undefined }]);
    expect(written, "only the last part of an upload's name says where it is saved").toEqual([{ path: "cat.png", bytes: [...PNG_BYTES], replace: false }]);

    expect(await run(["download", ID, "--out", "taken.png"], io)).toBe(2);
    expect(out.at(-1)).toBe("ink: taken.png is already there. Pass --force true to replace it, or --out for another place");
    expect(await run(["download", ID, "--out", "taken.png", "--force", "true"], io)).toBe(0);
    expect(written.at(-1)).toEqual({ path: "taken.png", bytes: [...PNG_BYTES], replace: true });

    // An export's parts are saved as they come, each to a file of its own, with the token sent only to the server's own addresses.
    const saved: { path: string; bytes: number[]; replace: boolean }[] = [];
    io.saveStream = async (path, body, replace) => {
      if (path === "backups/common-ink-wwwwwwwwwwww.zip" && !replace) return false;
      saved.push({ path, bytes: [...new Uint8Array(await new Response(body).arrayBuffer())], replace });
      return true;
    };
    const part = (number: number) => ({ number, notes: number === 1 ? 2 : 0, uploads: 1, bytes: 5, address: `https://ink.test/api/workspaces/${WS}/export?part=${number}&of=2${number === 1 ? "&notes=1" : ""}` });
    tools.plan_export = { notes: 2, uploads: 2, parts: [part(1), part(2)] };
    requests.length = calls.length = 0;
    expect(await run(["export", "--out", "backups", "--part-files", "1"], io)).toBe(0);
    expect(calls.map((c) => [c.name, c.args])).toEqual([["list_workspaces", {}], ["plan_export", { partFiles: 1, workspaceId: WS }]]);
    expect(requests).toEqual([1, 2].map((n) => ({ method: "GET", url: part(n).address, headers: { Authorization: "Bearer cink_x" }, body: undefined })));
    expect(saved).toEqual([1, 2].map((n) => ({ path: `backups/common-ink-${WS}-part-${n}-of-2.zip`, bytes: [...PNG_BYTES], replace: false })));
    expect(out.at(-1)).toBe(`Saved part 2 of 2: backups/common-ink-${WS}-part-2-of-2.zip`);
    tools.plan_export = { notes: 2, uploads: 0, parts: [part(1)] };
    expect(await run(["export", "--out", "backups"], io)).toBe(2);
    expect(out.at(-1)).toBe(`ink: backups/common-ink-${WS}.zip is already there. Pass --force true to replace it, or --out for another place`);
    tools.plan_export = { notes: 2, uploads: 0, parts: [{ ...part(1), address: "https://evil.example/steal" }] };
    requests.length = 0;
    expect(await run(["export"], io)).toBe(1);
    expect(requests).toEqual([]);

    tools.list_workspaces = { workspaces: [{ id: WS }, { id: "vvvvvvvvvvvv" }] };
    expect(await run(["download", ID], io)).toBe(2);
    expect(out.at(-1)).toBe(`ink: Pass --workspace: you can reach 2 (${WS}, vvvvvvvvvvvv)`);
  });

  it("takes nothing from a request that says who is asking, since a tool passes its arguments straight on", () => {
    expect([...OPS.values()].flat().filter((field) => /^(actor|personId|agentId|pluginId|workspaceId|role|scope)$/.test(field))).toEqual([]);
  });

  it("gives each tool every field its operation takes, and no other but its own, which say how its answer is shown", () => {
    for (const tool of TOOLS.filter((t) => t.op)) expect(argumentsOf(tool).filter((name) => !tool.own?.includes(name)).map((name) => tool.renames?.[name] ?? name).sort(), tool.name).toEqual([...OPS.get(tool.op!)!].sort());
  });

  it("has an ink command for every tool, with a flag for every argument", async () => {
    for (const tool of TOOLS.filter((t) => !OFFLINE.includes(t.name))) {
      const sent = new Set<string>();
      for (const argv of COMMANDS[tool.name] ?? []) {
        const io = {
          env: { INK_TOKEN: "cink_x" },
          stdin: async () => "",
          out: () => {},
          fetch: (async (_url: string, init: RequestInit) => {
            const { name, arguments: args } = JSON.parse(init.body as string).params;
            expect(name, argv.join(" ")).toBe(tool.name);
            for (const key of Object.keys(args)) sent.add(key);
            return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"next":null}' }] } });
          }) as unknown as typeof fetch,
        };
        expect(await run(argv, io), argv.join(" ")).toBe(0);
      }
      expect([...sent].sort(), `ink has no way to send every argument of ${tool.name}; add a command and list it in COMMANDS`).toEqual(argumentsOf(tool).sort());
    }
    expect([...Object.keys(COMMANDS), ...OFFLINE].sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("prints with ink syntax, with no token, what query_syntax answers: every form of each scope, and for todos every rule of every:", async () => {
    const agent: Caller = { agentId: ID, personId: ID, name: "Claude", workspaceId: null, readOnly: false, folderIds: null };
    for (const scope of SCOPES) {
      const answered = await callTool({} as D1Database, agent, "query_syntax", { scope });
      const said: string[] = [];
      expect(await run(["syntax", ...(scope === "notes" ? [] : [scope])], { env: {}, stdin: async () => "", out: (line) => said.push(line), fetch: (async () => expect.unreachable()) as unknown as typeof fetch })).toBe(0);
      expect(said.join("\n"), scope).toBe(answered!.content[0]!.text);
      for (const row of syntax(scope)) expect(said.join("\n"), `${scope} ${row.form}`).toContain(`${row.form}: ${row.means}`);
      for (const rule of RULE_GRAMMAR.split("\n")) expect(said.join("\n").includes(rule), `${scope} ${rule}`).toBe(scope === "todos");
    }
    expect(await callTool({} as D1Database, agent, "query_syntax", { scope: "people" })).toEqual({ content: [{ type: "text", text: "invalid: scope is notes, todos, uploads" }], isError: true });
  });

  it("reads a yes or no only as true or false, and asks the server nothing otherwise: a mistyped no must never allow", async () => {
    for (const argv of [["plugin-permit", "html", "--capability", "network", "--allowed", "no", "--origins", "https://x.example"], ["draft-save", ID, "--manifest", "{}", "--code", "", "--running", "0"], ["plugin-permit", ID, "--capability", "notes.read", "--allowed", "False"]]) {
      const said: string[] = [];
      const io = { env: { INK_TOKEN: "cink_x" }, stdin: async () => "", out: (text: string) => void said.push(text), fetch: (async () => expect.unreachable(argv.join(" "))) as unknown as typeof fetch };
      expect(await run(argv, io), argv.join(" ")).toBe(2);
      expect(said.join("\n")).toMatch(/is true or false/);
    }
  });

  it("refuses a flag a command doesn't take, and asks the server nothing: a filter dropped unsaid would list everything", async () => {
    for (const argv of [["todos", "--project", "Home"], ["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call", "--add-project", "Home"], ["folders", "--tag", "money"]]) {
      const said: string[] = [];
      const io = { env: { INK_TOKEN: "cink_x" }, stdin: async () => "", out: (text: string) => void said.push(text), fetch: (async () => expect.unreachable(argv.join(" "))) as unknown as typeof fetch };
      expect(await run(argv, io), argv.join(" ")).not.toBe(0);
      expect(said.join("\n"), argv.join(" ")).toContain(`${argv[0]} doesn't take ${argv.find((arg) => arg.startsWith("--") && !["--revision", "--line", "--text"].includes(arg))}`);
    }
  });

  it("refuses a flag a command doesn't take, and sends nothing", async () => {
    const said: string[] = [];
    let sent = 0;
    const io = {
      env: { INK_TOKEN: "cink_x" },
      stdin: async () => "",
      out: (line: string) => said.push(line),
      fetch: (async () => (sent++, Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "OK" }] } }))) as unknown as typeof fetch,
    };
    const all = [...Object.values(COMMANDS).flat(), ["revert-author", AUTHOR], ["revert-author", AUTHOR, "--note", ID, "--preview"], ["undo", ID], ["redo", ID]];
    for (const argv of all) {
      expect(await run([...argv, "--frobnicate", "yes"], io), argv.join(" ")).toBe(2);
      expect(said.at(-1), argv.join(" ")).toMatch(new RegExp(`^ink: ${argv[0]} doesn't take --frobnicate`));
      // A switch another command takes is as unknown here as any other flag.
      if (!argv.includes("--preview") && !["revert", "revert-many", "revert-author"].includes(argv[0]!)) {
        expect(await run([...argv, "--preview"], io), `${argv.join(" ")} --preview`).toBe(2);
        expect(said.at(-1)).toContain("doesn't take --preview");
      }
    }
    expect(await run(["read", ID, "--rev", "3"], io)).toBe(2);
    expect(await run(["notes", "--folder", ID, "--sinse", "2026-10-01", "--to", "x"], io)).toBe(2);
    expect(said.at(-1)).toContain("--sinse or --to");
    expect(sent).toBe(0);
  });

  it("prints its usage for --help, wherever it is", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["notes", "--help"], ["revert-author", "--help"]]) {
      const said: string[] = [];
      const io = { env: {}, stdin: async () => "", out: (line: string) => said.push(line), fetch: (async () => expect.unreachable()) as unknown as typeof fetch };
      expect(await run(argv, io), argv.join(" ")).toBe(0);
      expect(said.join("\n")).toMatch(/^Usage: ink/);
    }
  });
});

/** The schema under optional, nullable and default: what the value itself must be. */
function bare(schema: z.ZodType): z.ZodType {
  let inner = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable || inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType;
  return inner;
}
const holdsIds = (schema: z.ZodType) => {
  const inner = bare(schema);
  return inner === Id || (inner instanceof z.ZodArray && bare(inner.element as z.ZodType) === Id);
};
/** What a tool's argument holding ids is called: for what they are the ids of. `after` is a page's next, passed back as given, and `ref` a note's reference to a record. */
const ID_NAMES = ["noteId", "noteIds", "folderId", "parentId", "workspaceId", "after", "ref", "uploadId", "pluginId"];

describe("what each argument is called", () => {
  it("names every argument that holds ids for what they are the ids of, the same in every tool", () => {
    const named = new Set<string>();
    for (const tool of TOOLS.filter((t) => t.op)) {
      const shape = Op.options.find((o) => o.shape.type.value === tool.op)!.shape as Record<string, z.ZodType>;
      for (const name of argumentsOf(tool)) if (holdsIds(shape[tool.renames?.[name] ?? name]!)) named.add(name);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties), tool.name).toContain("workspaceId");
    }
    expect([...named].filter((name) => !ID_NAMES.includes(name)), "an id argument named otherwise").toEqual([]);
    expect(named).toEqual(new Set(["noteId", "noteIds", "folderId", "parentId", "after", "ref", "uploadId", "pluginId"]));
  });

  it("still takes each argument's old name, and shows only the name it has now", () => {
    const listed = toolList();
    for (const tool of TOOLS.filter((t) => t.op)) {
      const { properties } = listed.find((t) => t.name === tool.name)!.inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(properties), tool.name).not.toContain("workspace");
      expect(opArguments(tool, { workspace: "w" }), tool.name).toEqual({ workspaceId: "w", fields: { ...tool.defaults }, own: {} });
      for (const [name, field] of Object.entries(tool.renames ?? {})) {
        expect(Object.keys(properties), `${tool.name} ${field}`).not.toContain(field);
        expect(opArguments(tool, { [field]: ID }).fields, `${tool.name} ${field}`).toEqual({ ...tool.defaults, [field]: ID });
        expect(opArguments(tool, { [name]: ID }).fields, `${tool.name} ${name}`).toEqual({ ...tool.defaults, [field]: ID });
      }
    }
    expect(TOOLS.filter((t) => t.renames).map((t) => t.name)).toHaveLength(40);
  });

  it("ends every description with an example call the tool takes as it stands", () => {
    for (const tool of toolList()) expect(tool.description, tool.name).toMatch(/\n\nExample: \{.*\}$/);
    for (const tool of TOOLS.filter((t) => t.op)) {
      const { fields } = opArguments(tool, tool.example);
      const parsed = Op.safeParse({ ...fields, type: tool.op } as OpInput);
      expect(parsed.success ? "" : z.prettifyError(parsed.error), tool.name).toBe("");
    }
  });

  it("refuses an argument it doesn't take by name, with the ones it does and a guess at the one meant", () => {
    const tool = TOOLS.find((t) => t.name === "list_folders")!;
    expect(() => opArguments(tool, { workspace_id: ID })).toThrow('list_folders takes no "workspace_id": did you mean "workspaceId"? It takes workspaceId.');
    expect(() => opArguments(TOOLS.find((t) => t.name === "read_note")!, { noteId: ID, rev: 2 })).toThrow('read_note takes no "rev". It takes workspaceId, noteId, revision, lines, numbered.');
    expect(() => opArguments(TOOLS.find((t) => t.name === "read_note")!, { noteId: ID, id: "bbbbbbbbbbbb" })).toThrow('Pass noteId once: "id" is its old name, and they differ');
    expect(opArguments(TOOLS.find((t) => t.name === "read_note")!, { noteId: ID, id: ID, workspace: "w" })).toEqual({ workspaceId: "w", fields: { id: ID }, own: {} });
  });

  it("takes a time as ISO 8601 or as milliseconds, and gives create_folder's ifExists its default", () => {
    const notes = TOOLS.find((t) => t.name === "list_notes")!;
    expect(opArguments(notes, { updatedSince: "2026-10-15T09:30:00-07:00" }).fields).toEqual({ updatedSince: Date.UTC(2026, 9, 15, 16, 30), limit: 50 });
    expect(opArguments(notes, { updatedSince: 5, limit: 3 }).fields).toEqual({ updatedSince: 5, limit: 3 });
    expect(() => opArguments(notes, { updatedSince: "last tuesday" })).toThrow("updatedSince must be a time");
    expect(opArguments(TOOLS.find((t) => t.name === "create_folder")!, { name: "Skills" }).fields).toEqual({ name: "Skills", ifExists: "return" });
    expect(opArguments(TOOLS.find((t) => t.name === "create_folder")!, { name: "Skills", ifExists: "error" }).fields).toEqual({ name: "Skills", ifExists: "error" });
  });
});
