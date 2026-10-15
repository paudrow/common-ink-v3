import { describe, expect, it } from "vitest";
import { run, type Io } from "../../scripts/ink-cli.ts";
import { Op, type OpType } from "../../src/core/protocol.ts";
import { NOT_FOR_AGENTS, OVER_HTTP, TOOLS } from "../../src/worker/mcp/tools.ts";

const ID = "aaaaaaaaaaaa";
const AUTHOR = `agent:${ID}`;

/** Each operation and the fields it takes, read from the schema the web app's requests are checked against. */
const OPS = new Map(Op.options.map((option) => [option.shape.type.value as OpType, Object.keys(option.shape).filter((key) => key !== "type")]));

const argumentsOf = (tool: (typeof TOOLS)[number]) => Object.keys((tool.inputSchema as { properties: object }).properties).filter((key) => key !== "workspace");

/** For each tool, `ink` commands that between them set every argument the tool takes. */
const COMMANDS: Record<string, string[][]> = {
  list_workspaces: [["workspaces"]],
  list_members: [["members"]],
  list_plugins: [["plugins"]],
  list_notes: [["notes", "--folder", ID, "--since", "2026-10-01", "--tag", "money", "--archived", "true"]],
  search: [["search", "budget #money", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--archived", "only", "--has-todos", "true", "--sort", "title", "--limit", "5", "--offset", "5"]],
  list_tags: [["tags", "--archived", "true"]],
  archive_note: [["archive", ID], ["unarchive", ID]],
  trash_note: [["trash", ID]],
  restore_note: [["restore", ID]],
  list_trash: [["trashed"]],
  read_note: [["read", ID, "--revision", "1"]],
  create_note: [["create", "--text", "# Hi", "--folder", ID, "--link-titles", "keep", "--mention-names", "keep"]],
  write_note: [["write", ID, "--base", "1", "--text", "# Hi", "--write-id", "w1", "--link-titles", "keep", "--mention-names", "keep", "--on", "2026-10-11"]],
  backlinks: [["backlinks", ID]],
  rebuild_links: [["links-rebuild"]],
  list_todos: [["todos", "due:<today -tag:someday", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--tag", "money", "--due-from", "2026-10-01", "--due-to", "2026-10-31", "--no-due", "false", "--importance", "2,3", "--assignee", "Sam Okafor", "--assigned-to-me", "true", "--completed", "true", "--archived", "true", "--note", ID, "--sort", "priority", "--limit", "5", "--offset", "5"]],
  todo_filters: [["todo-filters", "--archived", "true"]],
  set_todo: [["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call", "--done", "true", "--importance", "2", "--due", "none", "--every", "2w", "--assign", "Sam Okafor", "--unassign", ID, "--on", "2026-10-11", "--words", "Call the bank #money"], ["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w", "--skip", "true"]],
  todo_history: [["todo-history", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w"]],
  daily_note: [["daily", "--on", "2026-10-11"]],
  find_daily_note: [["daily-find", "--on", "2026-10-11"]],
  list_pins: [["pins", "--archived", "true"]],
  pin_note: [["pin", ID], ["unpin", ID]],
  last_visit: [["visit"]],
  rebuild_todos: [["todos-rebuild"]],
  move_note: [["move", ID, "--folder", ID]],
  list_uploads: [["uploads", "type:image uploader:@me", "--today", "2026-10-11", "--zone", "Europe/Paris", "--folder", ID, "--archived", "true"]],
  place_upload: [["upload-place", ID, "--note", ID]],
  read_upload: [["upload-info", ID]],
  move_upload: [["upload-move", ID, "--folder", ID]],
  archive_upload: [["upload-archive", ID], ["upload-unarchive", ID]],
  trash_upload: [["upload-trash", ID]],
  restore_upload: [["upload-restore", ID]],
  list_trashed_uploads: [["uploads-trashed"]],
  list_folders: [["folders"]],
  create_folder: [["folder-create", "Plans", "--parent", ID]],
  rename_folder: [["folder-rename", ID, "--name", "Plans"]],
  delete_folder: [["folder-delete", ID]],
  note_history: [["history", ID]],
  change_diff: [["diff", ID, "--change", "2"]],
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

  it("has an ink command for every operation done over HTTP, which sends the token to the operation's address", async () => {
    expect(Object.keys(OVER_HTTP).sort()).toEqual(["upload.create", "upload.open"]);
    const WS = "wwwwwwwwwwww";
    const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    const requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    const written: { path: string; bytes: number[]; replace: boolean }[] = [];
    const out: string[] = [];
    const uploaded = { id: ID, name: "cat.png", type: "image/png", kind: "image", size: 4, width: 640, height: 480 };
    const tools: Record<string, unknown> = { list_workspaces: { workspaces: [{ id: WS }] }, read_upload: { ...uploaded, name: "../../etc/cat.png" } };
    const io: Io = {
      env: { INK_TOKEN: "cink_x", INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line) => out.push(line),
      readFile: async (path) => (path === "pictures/cat.png" ? PNG_BYTES : Promise.reject(new Error("no such file"))),
      writeFile: async (path, bytes, replace) => {
        if (path === "taken.png" && !replace) return false;
        written.push({ path, bytes: [...bytes], replace });
        return true;
      },
      fetch: (async (url: string, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>;
        if (url === "https://ink.test/mcp") {
          const { name } = JSON.parse(init.body as string).params;
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(tools[name]) }] } });
        }
        requests.push({ method: init.method ?? "GET", url, headers, body: init.body });
        return init.method === "POST" ? Response.json(uploaded, { status: 201 }) : new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
      }) as unknown as typeof fetch,
    };

    expect(await run(["upload", "pictures/cat.png", "--folder", ID], io)).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: `https://ink.test/api/workspaces/${WS}/uploads`,
        headers: { Authorization: "Bearer cink_x", "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "cat.png", folderId: ID })) },
        body: PNG_BYTES,
      },
    ]);
    expect(out.at(-1)).toBe(`In a note: ::image{${ID} 640x480}`);

    requests.length = 0;
    expect(await run(["upload", "pictures/cat.png", "--name", "Tabby.png", "--workspace", "vvvvvvvvvvvv"], io)).toBe(0);
    expect(requests.map((r) => [r.url, JSON.parse(decodeURIComponent(r.headers["X-Ink-Upload"]!))])).toEqual([["https://ink.test/api/workspaces/vvvvvvvvvvvv/uploads", { name: "Tabby.png" }]]);

    requests.length = 0;
    expect(await run(["download", ID], io)).toBe(0);
    expect(requests).toEqual([{ method: "GET", url: `https://ink.test/api/workspaces/${WS}/uploads/${ID}`, headers: { Authorization: "Bearer cink_x" }, body: undefined }]);
    expect(written, "only the last part of an upload's name says where it is saved").toEqual([{ path: "cat.png", bytes: [0x89, 0x50, 0x4e, 0x47], replace: false }]);

    expect(await run(["download", ID, "--out", "taken.png"], io)).toBe(2);
    expect(out.at(-1)).toBe("ink: taken.png is already there. Pass --force true to replace it, or --out for another place");
    expect(await run(["download", ID, "--out", "taken.png", "--force", "true"], io)).toBe(0);
    expect(written.at(-1)).toEqual({ path: "taken.png", bytes: [0x89, 0x50, 0x4e, 0x47], replace: true });

    tools.list_workspaces = { workspaces: [{ id: WS }, { id: "vvvvvvvvvvvv" }] };
    expect(await run(["download", ID], io)).toBe(2);
    expect(out.at(-1)).toBe(`ink: Pass --workspace: you can reach 2 (${WS}, vvvvvvvvvvvv)`);
  });

  it("takes nothing from a request that says who is asking, since a tool passes its arguments straight on", () => {
    expect([...OPS.values()].flat().filter((field) => /^(actor|personId|agentId|pluginId|workspaceId|role|scope)$/.test(field))).toEqual([]);
  });

  it("gives each tool every field its operation takes, and no other", () => {
    for (const tool of TOOLS.filter((t) => t.op)) expect(argumentsOf(tool).sort(), tool.name).toEqual([...OPS.get(tool.op!)!].sort());
  });

  it("has an ink command for every tool, with a flag for every argument", async () => {
    for (const tool of TOOLS) {
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
            return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "OK" }] } });
          }) as unknown as typeof fetch,
        };
        expect(await run(argv, io), argv.join(" ")).toBe(0);
      }
      expect([...sent].sort(), `ink has no way to send every argument of ${tool.name}; add a command and list it in COMMANDS`).toEqual(argumentsOf(tool).sort());
    }
    expect(Object.keys(COMMANDS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
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
