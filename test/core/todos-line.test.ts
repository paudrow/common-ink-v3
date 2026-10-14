import { describe, expect, it } from "vitest";
import { summarize } from "../../src/core/markdown.ts";
import * as core from "../../src/core/todos.ts";
import { completeTodo, isDay, locateTodo, parseTodo, rewriteTodo, tagsIn, todoIndex, todosIn, type Todo, type TodoChange } from "../../src/core/todos.ts";

const read = (line: string) => {
  const todo = parseTodo(line);
  return todo && { done: todo.done, importance: todo.importance, due: todo.due?.date ?? null, tags: todo.tags.map((t) => t.name), words: todo.words };
};

describe("a todo's line", () => {
  it("is a list item with a checkbox, whatever the list mark and however deep", () => {
    expect(["- [ ] a", "  * [x] b", "\t+ [X] c", "3. [ ] d", "4) [ ]", "- [ ]no space", "[ ] not in a list", "- [] empty", "- [y] other", "> - [ ] quoted"].map((line) => parseTodo(line)?.done ?? null)).toEqual([false, true, true, false, false, null, null, null, null, null]);
  });

  it("reads importance, a due date, and tags from its tokens, and the words left over", () => {
    expect(read("- [ ] !! Call the bank due:2026-10-14 about #money, then follow up.")).toEqual({
      done: false,
      importance: 2,
      due: "2026-10-14",
      tags: ["money"],
      words: "Call the bank about #money, then follow up.",
    });
  });

  it("has no projects: a +Name is words like any other, read and left as written", () => {
    const line = "- [ ] !! Call the bank due:2026-10-14 +Home about +Follow-up.";
    expect(read(line)).toEqual({ done: false, importance: 2, due: "2026-10-14", tags: [], words: "Call the bank +Home about +Follow-up." });
    expect(Object.keys(parseTodo(line)!).sort()).toEqual(["box", "done", "due", "every", "importance", "importanceAt", "lastDone", "tags", "words"]);
    expect(completeTodo(line, "2026-10-11")).toEqual({ line: "- [x] !! Call the bank due:2026-10-14 +Home about +Follow-up.", filed: null });
    expect(rewriteTodo(line, { importance: 0, due: null })).toBe("- [ ] Call the bank +Home about +Follow-up.");
    expect(Object.keys(todoIndex(line)).sort()).toEqual(["tags", "todos"]);
    expect("isProjectName" in core).toBe(false);
  });

  it("says where each token is, so it can be drawn and rewritten", () => {
    const line = "  - [x] !!! pay due:2026-01-31 +Bills #tax";
    const todo = parseTodo(line, 100)!;
    const at = (span: { from: number; to: number } | null) => span && line.slice(span.from - 100, span.to - 100);

    expect([at(todo.box), at(todo.importanceAt), at(todo.due), todo.tags.map(at)]).toEqual(["[x]", "!!!", "due:2026-01-31", ["#tax"]]);
  });

  it("takes importance only right after the checkbox, and at most three marks", () => {
    expect(["- [ ] ! a", "- [ ] !!! a", "- [ ] !!!! a", "- [ ] a !! b", "- [ ] !a", "- [ ] !!"].map((line) => read(line)!.importance)).toEqual([1, 3, 0, 0, 0, 2]);
  });

  it("takes a due date only as a real day written due:YYYY-MM-DD, and the first when there are two", () => {
    expect(["- [ ] a due:2026-02-28", "- [ ] a due:2026-02-30 due:2026-03-01", "- [ ] a due:tomorrow", "- [ ] a overdue:2026-02-28", "- [ ] a due:2026-2-8", "- [ ] due:2024-02-29."].map((line) => read(line)!.due)).toEqual(["2026-02-28", "2026-03-01", null, null, null, "2024-02-29"]);
    expect(["2026-12-31", "2026-13-01", "2026-00-10", "2025-02-29", "26-01-01", "0000-01-01"].map(isDay)).toEqual([true, false, false, false, false, false]);
  });

  it("takes a tag only as #tag with no space", () => {
    expect(read("- [ ] # heading-like, #12, a#b, #v2 and #área/sub")!.tags).toEqual(["v2", "área/sub"]);
  });

  it("leaves tokens in code, in a link to a note, and in an address as the text they are", () => {
    expect(read("- [ ] see `+Code due:2026-01-01 #x` and [[abc123def456|+Shown #y]] and [docs](https://e.com/a +Url #frag) #real")).toEqual({
      done: false,
      importance: 0,
      due: null,
      tags: ["real"],
      words: "see `+Code due:2026-01-01 #x` and [[abc123def456|+Shown #y]] and [docs](https://e.com/a +Url #frag) #real",
    });
  });
});

describe("rewriting a todo's line", () => {
  const line = "  - [ ] !! Call  the bank due:2026-10-14 +Home about #money  ";
  /** Each change to one token, and exactly what it writes in that token's place. */
  const ONE_TOKEN: [TodoChange, token: (todo: Todo) => { from: number; to: number }, written: string][] = [
    [{ done: true }, (t) => t.box, "[x]"],
    [{ importance: 3 }, (t) => t.importanceAt!, "!!!"],
    [{ importance: 1 }, (t) => t.importanceAt!, "!"],
    [{ due: "2027-01-02" }, (t) => t.due!, "due:2027-01-02"],
  ];

  it("changes one token and leaves every other character of the line as it was", () => {
    const todo = parseTodo(line)!;
    for (const [change, token, written] of ONE_TOKEN) {
      const { from, to } = token(todo);
      expect(rewriteTodo(line, change), JSON.stringify(change)).toBe(line.slice(0, from) + written + line.slice(to));
    }
  });

  it("round trips: changing a token and changing it back gives the line that was there", () => {
    const back: [TodoChange, TodoChange][] = [
      [{ done: true }, { done: false }],
      [{ importance: 0 }, { importance: 2 }],
      [{ importance: 3 }, { importance: 2 }],
      [{ due: "2030-12-25" }, { due: "2026-10-14" }],
    ];
    for (const [there, again] of back) expect(rewriteTodo(rewriteTodo(line, there), again), JSON.stringify(there)).toBe(line);
  });

  it("takes a token away with the space before it, and adds one with a space before it", () => {
    expect(rewriteTodo("- [ ] !! a due:2026-10-14 +Home b", { importance: 0 })).toBe("- [ ] a due:2026-10-14 +Home b");
    expect(rewriteTodo("- [ ] !! a due:2026-10-14 +Home b", { due: null })).toBe("- [ ] !! a +Home b");
    expect(rewriteTodo("- [ ] a", { importance: 1 })).toBe("- [ ] ! a");
    expect(rewriteTodo("- [ ] a +Home  ", { due: "2026-10-14" })).toBe("- [ ] a +Home due:2026-10-14  ");
    expect(rewriteTodo("- [ ]", { importance: 2, due: "2026-10-14" })).toBe("- [ ] !! due:2026-10-14");
    expect(rewriteTodo("- [ ] a due:2026-10-14", { importance: 3, due: null })).toBe("- [ ] !!! a");
  });

  it("writes nothing when the line already says it, and nothing to a line that isn't a todo", () => {
    const same: TodoChange[] = [{ done: false }, { importance: 2 }, { due: "2026-10-14" }, {}];
    for (const change of same) expect(rewriteTodo(line, change), JSON.stringify(change)).toBe(line);
    expect(rewriteTodo("- [X] kept as written", { done: true })).toBe("- [X] kept as written");
    expect(rewriteTodo("Just words +Home", { done: true, due: "2026-10-14" })).toBe("Just words +Home");
  });

  it("refuses a due date that isn't a day", () => {
    expect(() => rewriteTodo(line, { due: "2026-02-30" })).toThrow(RangeError);
  });

  it("checks a todo off as one function", () => {
    expect(completeTodo("- [ ] ! water +Garden", "2026-10-11")).toEqual({ line: "- [x] ! water +Garden", filed: null });
  });
});

describe("a note's todos and tags", () => {
  const note = "# Plan #q4\n\n- [ ] one +A\n```\n- [ ] in code #no\n```\n      - [x] deep +a +A\ntext #Q4 #other\n- [ ] one +A";

  it("are found anywhere outside fenced code, each with its line", () => {
    expect(todosIn(note).map((t) => [t.line, t.text, note.slice(t.from, t.from + t.text.length) === t.text])).toEqual([
      [2, "- [ ] one +A", true],
      [6, "      - [x] deep +a +A", true],
      [8, "- [ ] one +A", true],
    ]);
    expect(tagsIn(note)).toEqual(["q4", "other"]);
    expect(summarize(note).openTodos).toBe(2);
  });

  it("are indexed with the note's tags, each once ignoring case", () => {
    expect(todoIndex(note)).toEqual({
      todos: [
        [2, 0, 0, null, "- [ ] one +A"],
        [6, 1, 0, null, "      - [x] deep +a +A"],
        [8, 0, 0, null, "- [ ] one +A"],
      ],
      tags: [
        ["q4", "q4"],
        ["other", "other"],
      ],
    });
  });

  it("finds a listed todo again by its line, or by its words when the line moved, and never guesses", () => {
    const at = (line: number, text: string) => locateTodo(note, { line, text })?.line ?? null;

    expect(at(2, "- [ ] one +A")).toBe(2);
    expect(at(8, "- [ ] one +A")).toBe(8);
    expect(at(3, "      - [x] deep +a +A")).toBe(6);
    // Two todos read the same and neither is on the line that was listed.
    expect(at(5, "- [ ] one +A")).toBe(null);
    expect(at(2, "- [ ] one +B")).toBe(null);
    // A line in code is not a todo, whatever it reads.
    expect(at(4, "- [ ] in code #no")).toBe(null);
  });
});
