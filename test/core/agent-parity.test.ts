import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
import { Op, type OpType } from "../../src/core/protocol.ts";
import { NOT_FOR_AGENTS, TOOLS } from "../../src/worker/mcp/tools.ts";

const ID = "aaaaaaaaaaaa";
const AUTHOR = `agent:${ID}`;

/** Each operation and the fields it takes, read from the schema the web app's requests are checked against. */
const OPS = new Map(Op.options.map((option) => [option.shape.type.value as OpType, Object.keys(option.shape).filter((key) => key !== "type")]));

const argumentsOf = (tool: (typeof TOOLS)[number]) => Object.keys((tool.inputSchema as { properties: object }).properties).filter((key) => key !== "workspace");

/** For each tool, `ink` commands that between them set every argument the tool takes. */
const COMMANDS: Record<string, string[][]> = {
  list_workspaces: [["workspaces"]],
  list_members: [["members"]],
  list_notes: [["notes", "--folder", ID, "--since", "2026-10-01"]],
  read_note: [["read", ID, "--revision", "1"]],
  create_note: [["create", "--text", "# Hi", "--folder", ID, "--link-titles", "keep"]],
  write_note: [["write", ID, "--base", "1", "--text", "# Hi", "--write-id", "w1", "--link-titles", "keep", "--on", "2026-10-11"]],
  backlinks: [["backlinks", ID]],
  rebuild_links: [["links-rebuild"]],
  list_todos: [["todos", "--folder", ID, "--tag", "money", "--due-from", "2026-10-01", "--due-to", "2026-10-31", "--no-due", "false", "--importance", "2,3", "--completed", "true", "--note", ID, "--sort", "priority", "--limit", "5", "--offset", "5"]],
  todo_filters: [["todo-filters"]],
  set_todo: [["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call", "--done", "true", "--importance", "2", "--due", "none", "--every", "2w", "--on", "2026-10-11", "--words", "Call the bank #money"], ["todo", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w", "--skip", "true"]],
  todo_history: [["todo-history", ID, "--revision", "4", "--line", "3", "--text", "- [ ] Call every:2w"]],
  daily_note: [["daily", "--on", "2026-10-11"]],
  rebuild_todos: [["todos-rebuild"]],
  move_note: [["move", ID, "--folder", ID]],
  list_folders: [["folders"]],
  create_folder: [["folder-create", "Plans", "--parent", ID]],
  rename_folder: [["folder-rename", ID, "--name", "Plans"]],
  delete_folder: [["folder-delete", ID]],
  note_history: [["history", ID]],
  change_diff: [["diff", ID, "--change", "2"]],
  history_summary: [["changed", "--note", ID, "--author", AUTHOR, "--by", "agents", "--from", "2026-10-01", "--to", "2026-10-02", "--limit", "5", "--before", `{"lastAt":1,"noteId":"${ID}"}`]],
  history: [["changes", "--note", ID, "--author", AUTHOR, "--by", "people", "--from", "2026-10-01", "--to", "2026-10-02", "--limit", "5", "--before", `{"createdAt":1,"noteId":"${ID}","revision":1}`, "--diffs", "false"]],
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
  revert_author: [["revert-author", AUTHOR, "--note", ID, "--after", ID, "--resolve", `{"${ID}": {"at": 3, "choices": "back"}}`]],
  undo: [["undo", ID]],
  redo: [["redo", ID]],
};

describe("what an agent can do, against what the web app can", () => {
  it("has one tool for every operation, or a reason it has none", () => {
    for (const type of OPS.keys()) {
      const tools = TOOLS.filter((t) => t.op === type).map((t) => t.name);
      if (NOT_FOR_AGENTS[type]) expect(tools, `${type} is kept from agents, so it has no tool`).toEqual([]);
      else expect(tools, `${type} needs a tool in src/worker/mcp/tools.ts, or a reason in NOT_FOR_AGENTS`).toHaveLength(1);
    }
    expect(Object.keys(NOT_FOR_AGENTS).filter((type) => !OPS.has(type as OpType))).toEqual([]);
  });

  it("takes nothing from a request that says who is asking, since a tool passes its arguments straight on", () => {
    expect([...OPS.values()].flat().filter((field) => /^(actor|personId|agentId|workspaceId|role|scope)$/.test(field))).toEqual([]);
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
