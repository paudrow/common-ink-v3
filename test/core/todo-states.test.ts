import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { summarize } from "../../src/core/markdown.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError } from "../../src/core/protocol.ts";
import { changesBetween } from "../../src/core/text.ts";
import { changeTodo, checkedOff, completeTodo, parseTodo, rewriteTodo, skipTodo, todoIndex } from "../../src/core/todos.ts";
import { newMember } from "./members.ts";

const SUNDAY = "2026-10-11";
const CELLO = "- [ ] ! Practise the cello due:2026-10-10 every:1w #music";

describe("a todo's box", () => {
  it("says one of four states by its mark, X as well as x for done", () => {
    expect(["- [ ] a", "- [x] a", "- [X] a", "- [-] a", "- [>] a", "- [<] a", "- [~] a", "- [--] a"].map((line) => parseTodo(line)?.state ?? null)).toEqual(["open", "done", "done", "abandoned", "backlog", null, null, null]);
  });

  it("reads the same words and tokens whatever its state", () => {
    const read = (line: string) => {
      const todo = parseTodo(line)!;
      return [todo.state, todo.box, todo.importance, todo.due?.date, todo.words];
    };
    expect(read("  - [-] !! Paint the fence due:2026-11-01 #home")).toEqual(["abandoned", { from: 4, to: 7 }, 2, "2026-11-01", "Paint the fence #home"]);
    expect(read("1. [>] Learn Finnish")).toEqual(["backlog", { from: 3, to: 6 }, 0, undefined, "Learn Finnish"]);
  });

  it("is written with one mark for each state, changing nothing else on the line", () => {
    const line = "  * [ ] !! Paint the fence due:2026-11-01";
    expect(rewriteTodo(line, { state: "abandoned" })).toBe("  * [-] !! Paint the fence due:2026-11-01");
    expect(rewriteTodo(line, { state: "backlog" })).toBe("  * [>] !! Paint the fence due:2026-11-01");
    expect(rewriteTodo(line, { state: "done" })).toBe("  * [x] !! Paint the fence due:2026-11-01");
    expect(rewriteTodo("- [-] Paint", { state: "open" })).toBe("- [ ] Paint");
    expect(rewriteTodo("- [X] Paint", { state: "done" })).toBe("- [X] Paint");
    expect(rewriteTodo("- [>] Paint", { state: "backlog", due: "2026-12-24" })).toBe("- [>] Paint due:2026-12-24");
  });

  it("is in the index by its state's name", () => {
    expect(todoIndex("# Chores\n\n- [ ] Sweep\n- [X] Dust\n- [-] Paint\n- [>] Tile").todos).toEqual([
      [2, "open", 0, null, "- [ ] Sweep"],
      [3, "done", 0, null, "- [X] Dust"],
      [4, "abandoned", 0, null, "- [-] Paint"],
      [5, "backlog", 0, null, "- [>] Tile"],
    ]);
  });

  it("makes a todo open in its note's count only when it is open", () => {
    expect(summarize("# Chores\n\n- [ ] Sweep\n- [x] Dust\n- [-] Paint\n- [>] Tile").openTodos).toBe(1);
    expect(summarize("# Chores\n\n- [-] Paint\n- [>] Tile").snippet).toBe("Paint Tile");
  });
});

describe("changing a todo's state", () => {
  it("abandons or backlogs a repeating todo by its box alone, filing nothing and moving no date", () => {
    expect(changeTodo(CELLO, { state: "abandoned" }, SUNDAY)).toEqual({ line: "- [-] ! Practise the cello due:2026-10-10 every:1w #music", filed: null });
    expect(changeTodo(CELLO, { state: "backlog" }, SUNDAY)).toEqual({ line: "- [>] ! Practise the cello due:2026-10-10 every:1w #music", filed: null });
    expect(changeTodo("- [>] ! Practise the cello due:2026-10-10 every:1w #music", { state: "open" }, SUNDAY)).toEqual({ line: CELLO, filed: null });
  });

  it("checks off a backlogged or abandoned todo as an open one, rolling a repeating one forward to open", () => {
    expect(completeTodo("- [>] ! Practise the cello due:2026-10-10 every:1w #music", SUNDAY)).toEqual({
      line: "- [ ] ! Practise the cello due:2026-10-17 every:1w #music done:2026-10-11x1",
      filed: "- [x] ! Practise the cello due:2026-10-10 #music",
    });
    expect(changeTodo("- [-] Paint the fence", { state: "done" }, SUNDAY)).toEqual({ line: "- [x] Paint the fence", filed: null });
    expect(completeTodo("- [x] Paint the fence every:1w", SUNDAY)).toEqual({ line: "- [x] Paint the fence every:1w", filed: null });
  });

  it("skips only an open repeating todo", () => {
    expect(skipTodo(CELLO, SUNDAY)).toBe("- [ ] ! Practise the cello due:2026-10-17 every:1w #music");
    expect(() => skipTodo("- [>] ! Practise the cello due:2026-10-10 every:1w", SUNDAY)).toThrow(/Only an open todo that repeats can be skipped/);
    expect(() => changeTodo(CELLO, { state: "backlog", skip: true }, SUNDAY)).toThrow(/Only an open todo that repeats can be skipped/);
  });

  it("counts a write that checks a backlogged repeating todo's box as checking it off, and one that abandons it as not", () => {
    const was = `# Music\n\n${CELLO.replace("[ ]", "[>]")}`;
    const checked = was.replace("[>]", "[x]");
    expect(checkedOff(was, changesBetween(was, checked)).map((todo) => todo.text)).toEqual(["- [x] ! Practise the cello due:2026-10-10 every:1w #music"]);
    const open = `# Music\n\n${CELLO}`;
    expect(checkedOff(open, changesBetween(open, open.replace("[ ]", "[-]")))).toEqual([]);
  });
});

describe("todo.set with a state", () => {
  const codeOf = (run: Promise<unknown>) => run.then(() => "answered", (err) => (err instanceof OpError ? `${err.code}: ${err.message}` : Promise.reject(err)));
  const lineOf = async (as: Actor, id: string, line: number) => (await perform(env.DB, as, { type: "note.read", id })).text.split("\n")[line];

  it("writes each state's box, and backlogging a repeating todo files nothing on a daily note", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: `# Music\n\n${CELLO}\n- [ ] Tune the piano` });
    const backlogged = await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 2, text: CELLO, state: "backlog", on: SUNDAY });
    expect(backlogged.filed).toBeUndefined();
    expect(await lineOf(ada, note.id, 2)).toBe("- [>] ! Practise the cello due:2026-10-10 every:1w #music");
    expect((await perform(env.DB, ada, { type: "note.list" })).notes.map((n) => n.title)).toEqual(["Music"]);
    await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 2, line: 3, text: "- [ ] Tune the piano", state: "abandoned" });
    expect(await lineOf(ada, note.id, 3)).toBe("- [-] Tune the piano");
    const listed = await perform(env.DB, ada, { type: "todo.list", query: "is:abandoned OR is:backlog" });
    expect(listed.todos.map((t) => [t.words, t.state])).toEqual([
      ["Practise the cello #music", "backlog"],
      ["Tune the piano", "abandoned"],
    ]);
  });

  it("takes done as the older way to say done or open, and refuses done with a state that says otherwise", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Chores\n\n- [>] Sweep" });
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 2, text: "- [>] Sweep", done: true, state: "open" }))).toBe("invalid: done: true and state: open say different things. Pass state alone");
    await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 2, text: "- [>] Sweep", done: false });
    expect(await lineOf(ada, note.id, 2)).toBe("- [ ] Sweep");
    await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 2, line: 2, text: "- [ ] Sweep", done: true, state: "done" });
    expect(await lineOf(ada, note.id, 2)).toBe("- [x] Sweep");
    // Not done and abandoned agree.
    await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 3, line: 2, text: "- [x] Sweep", done: false, state: "abandoned" });
    expect(await lineOf(ada, note.id, 2)).toBe("- [-] Sweep");
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 4, line: 2, text: "- [-] Sweep", done: false, state: "done" }))).toBe("invalid: done: false and state: done say different things. Pass state alone");
  });

  it("is what an agent's set_todo sets, by state or by done, and list_todos says each todo's state", async () => {
    const ada = await newMember();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await worker.fetch(new Request("https://ink.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }) as never, env);
      const { result } = (await answer.json()) as { result: { content: { text: string }[]; isError?: boolean } };
      if (result.isError) throw new Error(result.content[0]!.text);
      return JSON.parse(result.content[0]!.text);
    };
    const note = await call("create_note", { text: "# Chores\n\n- [ ] Sweep\n- [ ] Dust" });
    await call("set_todo", { noteId: note.id, revision: 1, line: 2, text: "- [ ] Sweep", state: "backlog" });
    await call("set_todo", { noteId: note.id, revision: 2, line: 3, text: "- [ ] Dust", done: true });
    const listed = await call("list_todos", { query: "is:backlog OR is:done" });
    expect(listed.todos.map((t: { text: string; state: string }) => [t.text, t.state])).toEqual([
      ["- [>] Sweep", "backlog"],
      ["- [x] Dust", "done"],
    ]);
  });
});
