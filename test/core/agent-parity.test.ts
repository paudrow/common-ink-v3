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
  list_notes: [["notes", "--folder", ID, "--since", "2026-10-01"]],
  read_note: [["read", ID, "--revision", "1"]],
  create_note: [["create", "--text", "# Hi", "--folder", ID]],
  write_note: [["write", ID, "--base", "1", "--text", "# Hi", "--write-id", "w1"]],
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
});
