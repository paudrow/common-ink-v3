import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { timeIn } from "../../src/core/history.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { run } from "../../scripts/ink-cli.ts";
import { newMember } from "./members.ts";

const MCP = "https://ink.test/mcp";
const send = (req: Request) => worker.fetch(req as never, env);
const post = (token: string, body: unknown) => send(new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));

/** An agent as a client sees the server: tools/list, and tools/call answered with text. */
function agentOf(token: string) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = (await (await post(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content[0]!.text, isError: !!result.isError };
  };
  return {
    call,
    json: async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const answer = await call(name, args);
      if (answer.isError) throw new Error(`${name}: ${answer.text}`);
      return JSON.parse(answer.text) as T;
    },
    tools: async () => ((await (await post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string; description: string; inputSchema: any }[] } }).result.tools,
  };
}

async function connected(name = "Ada Lovelace") {
  const ada = await newMember(name);
  const { token } = await connectAgent(env.DB, ada.personId, "Claude");
  return { ada, token, agent: agentOf(token) };
}

const setZone = async (member: Actor, timeZone: string) => perform(env.DB, member, { type: "settings.write", text: JSON.stringify({ "daily.timeZone": timeZone }), baseRevision: 0 });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** Every value under a key that holds a time, outside what is passed back as given. */
function timesIn(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((item) => timesIn(item, found));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "next" || key === "before") continue;
      if (/^(at|[a-z]+At)$/.test(key) && item !== null) found.push(item);
      else timesIn(item, found);
    }
  return found;
}

describe("a time", () => {
  it("is written in ISO 8601 with the zone's offset at that moment", () => {
    const summer = Date.UTC(2026, 6, 1, 16, 30, 5, 7);
    const winter = Date.UTC(2026, 0, 15, 16, 30);
    expect(timeIn("UTC")(summer)).toBe("2026-07-01T16:30:05.007+00:00");
    expect(timeIn("America/Los_Angeles")(summer)).toBe("2026-07-01T09:30:05.007-07:00");
    expect(timeIn("America/Los_Angeles")(winter)).toBe("2026-01-15T08:30:00.000-08:00");
    expect(timeIn("Asia/Kolkata")(winter)).toBe("2026-01-15T22:00:00.000+05:30");
    expect(timeIn("Pacific/Kiritimati")(Date.UTC(2026, 0, 15, 23, 0))).toBe("2026-01-16T13:00:00.000+14:00");
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) expect(Date.parse(timeIn(zone)(summer)), zone).toBe(summer);
  });
});

describe("an agent's answers", () => {
  it("give every time as ISO 8601 in the member's zone, and a page's next as it is to be passed back", async () => {
    const { ada, agent } = await connected();
    await setZone(ada, "America/Los_Angeles");
    const made = await agent.json("create_note", { text: "# Plan\n\n- [ ] Water the plants every:1w due:2026-10-14" });
    const todo = (await agent.json("list_todos")).todos[0];
    await agent.json("set_todo", { noteId: made.id, revision: todo.revision, line: todo.line, text: todo.text, done: true, on: "2026-10-14" });
    const answers = [
      made,
      await agent.json("read_note", { noteId: made.id }),
      await agent.json("list_notes"),
      await agent.json("note_history", { noteId: made.id }),
      await agent.json("history", { limit: 1 }),
      await agent.json("history_summary", { limit: 1 }),
      await agent.json("todo_history", { noteId: made.id, revision: 2, line: 2, text: (await agent.json("read_note", { noteId: made.id })).text.split("\n")[2] }),
      await agent.json("backlinks", { noteId: made.id }),
      await agent.json("daily_note", { on: "2026-10-14" }),
    ];
    const binned = await agent.json("create_note", { text: "# Old plan" });
    await agent.json("trash_note", { noteId: binned.id });
    const trashed = await agent.json("list_trash");
    expect(trashed[0]).toMatchObject({ stateAt: expect.stringMatching(/-0[78]:00$/), trashedAt: expect.stringMatching(/-0[78]:00$/), purgesAt: expect.stringMatching(/-0[78]:00$/) });
    answers.push(trashed);
    await perform(env.DB, ada, { type: "visit.mark", until: Date.UTC(2026, 9, 15, 16, 30) });
    expect(await agent.json("last_visit")).toEqual({ readUntil: "2026-10-15T09:30:00.000-07:00", now: expect.stringMatching(ISO) });

    const times = timesIn(answers);
    expect(times.length).toBeGreaterThan(10);
    expect(times.filter((t) => typeof t !== "string" || !ISO.test(t))).toEqual([]);
    expect(times.every((t) => /-0[78]:00$/.test(t as string))).toBe(true);
    expect(Date.parse(made.createdAt)).toBe((await perform(env.DB, ada, { type: "note.read", id: made.id })).createdAt);
    // A page's next is passed back as the server wrote it.
    const page = await agent.json("history", { limit: 1 });
    expect(page.next).toMatchObject({ createdAt: expect.any(Number) });
    expect((await agent.json("history", { limit: 1, before: page.next })).changes[0].revision).not.toBe(page.changes[0].revision);
  });

  it("are in UTC for a member who named no zone, and take a time back as ISO 8601 or as milliseconds", async () => {
    const { agent } = await connected();
    const made = await agent.json("create_note", { text: "# Plan" });
    expect(made.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);

    expect((await agent.json("list_notes", { updatedSince: made.updatedAt })).map((n: { id: string }) => n.id)).toEqual([made.id]);
    expect(await agent.json("list_notes", { updatedSince: Date.parse(made.updatedAt) + 1 })).toEqual([]);
    expect((await agent.json("history_summary", { from: "2026-01-01", to: new Date(Date.parse(made.updatedAt) + 1).toISOString() })).notes).toHaveLength(1);
    expect(await agent.call("list_notes", { updatedSince: "yesterday" })).toEqual({ isError: true, text: "invalid: updatedSince must be a time: ISO 8601, such as 2026-10-15T09:30:00-07:00, or milliseconds since 1970" });
  });
});

describe("an agent's arguments", () => {
  it("are taken by the old name of each too: workspace for workspaceId, and id for noteId or folderId", async () => {
    const { ada, agent } = await connected();
    const folder = await agent.json("create_folder", { name: "Plans" });
    const made = await agent.json("create_note", { workspace: ada.workspaceId, text: "# Plan", folderId: folder.id });

    expect((await agent.json("read_note", { id: made.id })).text).toBe("# Plan");
    expect((await agent.json("read_note", { noteId: made.id, workspaceId: ada.workspaceId })).text).toBe("# Plan");
    expect(await agent.json("list_folders", { workspace: ada.workspaceId })).toEqual(await agent.json("list_folders", { workspaceId: ada.workspaceId }));
    expect(await agent.json("rename_folder", { id: folder.id, name: "Plans 2" })).toMatchObject({ name: "Plans 2" });
    expect(await agent.json("rename_folder", { folderId: folder.id, name: "Plans 3" })).toMatchObject({ name: "Plans 3" });
    expect(await agent.call("read_note", { id: made.id, noteId: "zzzzzzzzzzzz" })).toEqual({ isError: true, text: 'invalid: Pass noteId once: "id" is its old name, and they differ' });
    expect((await agent.call("read_note", {})).text).toMatch(/→ at noteId$/);
    expect((await agent.call("delete_folder", { folderId: "nope" })).text).toBe("invalid: ✖ not an id\n  → at folderId");
    expect(await agent.call("preview_revert", { noteId: made.id, to: "3" })).toMatchObject({ isError: true, text: expect.stringMatching(/→ at to$/) });
    expect(await agent.call("list_folders", { workspace_id: ada.workspaceId })).toEqual({ isError: true, text: 'invalid: list_folders takes no "workspace_id": did you mean "workspaceId"? It takes workspaceId.' });
  });

  it("are named in each tool's schema with the old names marked deprecated, and each description ends with an example", async () => {
    const { agent } = await connected();
    const tools = await agent.tools();
    const read = tools.find((t) => t.name === "read_note")!;
    expect(read.inputSchema.required).toEqual(["noteId"]);
    expect(read.inputSchema.properties.id).toMatchObject({ deprecated: true, description: "The old name of noteId, still taken. Use noteId" });
    expect(read.inputSchema.properties.workspace).toMatchObject({ deprecated: true });
    expect(read.description).toMatch(/\n\nExample: \{"noteId":"[a-z0-9]{12}"\}$/);
    expect(tools.every((t) => /\n\nExample: \{.*\}$/.test(t.description))).toBe(true);
  });
});

/** The example call at the end of a tool's description, with its made-up ids put for real ones. */
const exampleOf = (description: string, ids: Record<string, string>) =>
  JSON.parse(Object.entries(ids).reduce((text, [made, real]) => text.replaceAll(made, real), description.split("\n\nExample: ")[1]!)) as Record<string, unknown>;

describe("a fresh agent's first calls, made from the tools' descriptions alone", () => {
  it("find the workspace and folders, make a folder only if it is missing, and make a note that links by title", async () => {
    const { token } = await connected();
    const agent = agentOf(token);
    const tools = Object.fromEntries((await agent.tools()).map((t) => [t.name, t.description]));
    const example = (name: string, ids: Record<string, string> = {}) => exampleOf(tools[name]!, ids);
    const ids = (from: string) => [...from.matchAll(/"([a-z0-9]{12})"/g)].map((m) => m[1]!);

    const { workspaces } = await agent.json("list_workspaces", example("list_workspaces"));
    const workspaceId = workspaces[0].id;
    const [madeUpWorkspace] = ids(tools.list_folders!.split("Example: ")[1]!);
    const { unsortedId } = await agent.json("list_folders", example("list_folders", { [madeUpWorkspace!]: workspaceId }));

    // find_folder's example asks for Projects/Skills; the agent makes them with create_folder's example, twice.
    const [madeUpParent] = ids(tools.create_folder!.split("Example: ")[1]!);
    const projects = await agent.json("create_folder", { name: "projects" });
    const skills = await agent.json("create_folder", example("create_folder", { [madeUpParent!]: projects.id }));
    expect(skills).toMatchObject({ name: "Skills", parentId: projects.id, created: true });
    expect(await agent.json("create_folder", example("create_folder", { [madeUpParent!]: projects.id }))).toEqual({ ...skills, created: false });
    expect(await agent.json("find_folder", example("find_folder"))).toMatchObject({ id: skills.id, path: "projects/Skills" });

    // create_note's example links [[Budget]], which no note is titled: kept as written, and said so.
    const [madeUpFolder] = ids(tools.create_note!.split("Example: ")[1]!);
    const note = await agent.json("create_note", example("create_note", { [madeUpFolder!]: skills.id }));
    expect(note).toMatchObject({ title: "Plan", folderId: skills.id, unresolved: [{ target: "Budget", matches: [] }] });
    expect(note.text).toContain("[[Budget]]");
    const [madeUpNote] = ids(tools.read_note!.split("Example: ")[1]!);
    expect((await agent.json("read_note", example("read_note", { [madeUpNote!]: note.id }))).links).toEqual([]);
    expect(await agent.json("move_note", example("move_note", { [madeUpNote!]: note.id, [madeUpParent!]: unsortedId }))).toMatchObject({ folderId: unsortedId });
    expect(await agent.json("daily_note", example("daily_note"))).toMatchObject({ title: "2026-10-15" });
    expect(await agent.json("list_todos", example("list_todos"))).toEqual({ todos: [], next: null });
  });
});

describe("the ink command, against the server", () => {
  it("finds a folder by path, makes one only if missing, keeps a link it can't resolve, and prints times as ISO 8601", async () => {
    const { ada, token } = await connected();
    await setZone(ada, "Asia/Kolkata");
    const said: string[] = [];
    const ink = async (argv: string[], stdin = "") => {
      said.length = 0;
      const code = await run(argv, { env: { INK_TOKEN: token, INK_URL: "https://ink.test" }, stdin: async () => stdin, out: (line) => said.push(line), fetch: (async (url: string, init: RequestInit) => send(new Request(url, init))) as unknown as typeof fetch });
      return { code, out: said.join("\n") };
    };
    const json = async (argv: string[], stdin = "") => {
      const { code, out } = await ink(argv, stdin);
      expect(code, `${argv.join(" ")}: ${out}`).toBe(0);
      return JSON.parse(out);
    };

    const made = await json(["folder-create", "Projects"]);
    expect(made).toMatchObject({ name: "Projects", created: true });
    expect(await json(["folder-create", "PROJECTS"])).toEqual({ ...made, created: false });
    expect(await ink(["folder-create", "projects", "--if-exists", "error"])).toMatchObject({ code: 1, out: expect.stringContaining(`invalid: There's already a folder named "Projects" here (${made.id})`) });
    const skills = await json(["folder-create", "Skills", "--parent", made.id]);
    expect(await json(["folder-find", "projects/skills", "--workspace", ada.workspaceId])).toMatchObject({ id: skills.id, path: "Projects/Skills" });
    expect(await ink(["folder-find", "Projects/Nowhere"])).toEqual({ code: 1, out: "not_found: No such folder" });

    const note = await json(["create", "--folder", skills.id], "# Plan\n\nSee [[Budget]]");
    expect(note).toMatchObject({ unresolved: [{ target: "Budget", matches: [] }], createdAt: expect.stringMatching(/\+05:30$/) });
    expect(await ink(["create", "--link-titles", "resolve-strict", "--text", "# Plan\n\nSee [[Budget]]"])).toMatchObject({ code: 1, out: expect.stringContaining('No note is titled "Budget"') });
    expect((await json(["notes", "--since", note.createdAt])).map((n: { id: string }) => n.id)).toEqual([note.id]);
    expect((await json(["notes", "--since", String(Date.parse(note.createdAt))])).map((n: { id: string }) => n.id)).toEqual([note.id]);
    expect((await json(["history", note.id]))[0].createdAt).toMatch(/\+05:30$/);
  });
});
