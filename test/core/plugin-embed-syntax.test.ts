import { describe, expect, it } from "vitest";
import { blocksIn, callsIn, inlineIn, misspeltIn, readNote, rewriteOf, writtenEmbed, type Rewrite, type Written } from "../../src/core/embedSyntax.ts";

const apply = (text: string, edits: readonly Rewrite[]) => [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const only = (found: Written[]) => {
  expect(found).toHaveLength(1);
  return found[0]!;
};
const names = (line: string) => callsIn(line).map((c) => line.slice(c.from, c.to));

describe("embeds as a note writes them", () => {
  it("finds /name(args) with where its config is, at the start of a line or after a space", () => {
    const text = "Time /timer(5m) and /stopwatch() here";

    expect(inlineIn(text).map((w) => [w.name, w.config, text.slice(w.from, w.to), w.configFrom])).toEqual([
      ["timer", "5m", "/timer(5m)", 12],
      ["stopwatch", "", "/stopwatch()", 31],
    ]);
    expect(inlineIn("a /timer(5m)", 100)[0]).toMatchObject({ from: 102, to: 112, configFrom: 109, content: null, body: "", fence: null });
    expect(names("/timer(5m)\tthen\u00a0/timer(1m)")).toEqual(["/timer(5m)", "/timer(1m)"]);
  });

  it("reads a quoted value with spaces or parentheses in it, and parentheses that nest", () => {
    expect(callsIn('/x-poll(question="Lunch (team)?" votes=3) after').map((c) => c.config)).toEqual(['question="Lunch (team)?" votes=3']);
    expect(callsIn("/email(abcdefabcdef Sam (work)) after").map((c) => c.config)).toEqual(["abcdefabcdef Sam (work)"]);
  });

  it("takes for an embed no path, address, word with a slash in it, name that isn't one, or ( after a space", () => {
    for (const line of ["/usr/bin(x)", "and/or (x)", "and/or(x)", "https://example.com/timer(5m)", "see a/timer(5m)", "x:/timer(5m)", "(/timer(5m))", "/timers(5m)", "/timer (5m)", "/Timer(5m)", "/timer(5m", "/ timer(5m)", "~/timer(5m)", "/sundial(9)"]) {
      expect(names(line), line).toEqual([]);
    }
    expect(names("/x-poll(Lunch?)")).toEqual(["/x-poll(Lunch?)"]);
  });

  it("reads one that holds content only alone on its line, with the fence directly under it as its content", () => {
    const text = "# Plan\n\n/kanban(wide)\n```markdown\n## To do\n- a\n```\nafter\n";
    const block = only(blocksIn(text));

    expect(block).toMatchObject({ name: "kanban", config: "wide", body: "## To do\n- a\n", content: "markdown" });
    expect(text.slice(block.from, block.to)).toBe("/kanban(wide)\n```markdown\n## To do\n- a\n```");
    expect(text.slice(block.configFrom, block.configFrom + 4)).toBe("wide");
    expect(text.slice(block.bodyFrom, block.bodyFrom + block.body.length)).toBe(block.body);
    expect(inlineIn("say /kanban() here")).toEqual([]);
    expect(blocksIn("say /kanban() here\n```\nx\n```")).toEqual([]);
  });

  it("reads one with no fence under it as holding nothing yet, and one whose fence never closes as having none", () => {
    expect(only(blocksIn("/kanban()\nafter"))).toMatchObject({ body: "", fence: null, to: "/kanban()".length });
    expect(only(blocksIn("/kanban()  \nafter"))).toMatchObject({ fence: null, to: "/kanban()  ".length });
    expect(only(blocksIn("/kanban()\n\n```\nx\n```"))).toMatchObject({ body: "", fence: null });
    expect(only(blocksIn("/form()\n```json\n{}\n"))).toMatchObject({ body: "", fence: null });
    expect(readNote("/form()\n```json\n{}\n").lines.map((l) => l.is)).toEqual(["prose", "code", "code", "code"]);
  });

  it("closes a fence as CommonMark does, so content may hold a shorter fence, or the other kind", () => {
    expect(only(blocksIn("/kanban()\n````markdown\n```\n## not a column\n```\n````")).body).toBe("```\n## not a column\n```\n");
    expect(only(blocksIn("/html()\n~~~html\n```\n<b>\n~~~")).body).toBe("```\n<b>\n");
    expect(only(blocksIn("/html()\n```html\n<b>\n`````\nafter")).body).toBe("<b>\n");
    expect(only(blocksIn("/html()\n```html\n\t```\n    ```\n   ```")).body).toBe("\t```\n    ```\n");
  });

  it("takes no embed in a code fence or in another's content, and reads one after code", () => {
    expect(blocksIn("```\n/kanban()\n```\n```\n")).toEqual([]);
    expect(blocksIn("~~~~\n/kanban()\n```\n```\n~~~~\n")).toEqual([]);
    expect(only(blocksIn("```\ncode\n```\n/kanban()\n```markdown\n```")).name).toBe("kanban");
    expect(blocksIn("/kanban()\n```markdown\n/kanban()\n```\n").map((b) => b.body)).toEqual(["/kanban()\n"]);
  });

  it("says which lines are the note's words: markdown content is, and HTML, JSON, code and fences are not", () => {
    const text = "a\n/kanban()\n```markdown\n- [ ] card\n```\n/form()\n```json\n{}\n```\n```\ncode\n```\nb";
    expect(readNote(text).lines.map((l) => [l.line, l.is])).toEqual([
      ["a", "prose"],
      ["/kanban()", "prose"],
      ["```markdown", "fence"],
      ["- [ ] card", "markdown"],
      ["```", "fence"],
      ["/form()", "prose"],
      ["```json", "fence"],
      ["{}", "json"],
      ["```", "fence"],
      ["```", "code"],
      ["code", "code"],
      ["```", "code"],
      ["b", "prose"],
    ]);
  });

  it("reads a name as its plugin says it is: a block only where its kind holds content", () => {
    const kinds = (name: string) => ({ chip: null, board: "markdown" as const })[name];
    expect(inlineIn("a /chip(1) /board()", 0, kinds).map((w) => w.name)).toEqual(["chip"]);
    expect(only(blocksIn("/board()\n```markdown\nx\n```", kinds)).body).toBe("x\n");
    expect(inlineIn("/timer(5m)", 0, kinds)).toEqual([]);
  });
});

describe("a name close to an embed's", () => {
  const NAMES = ["timer", "stopwatch", "html", "kanban", "image", "file"];
  it("is found where an embed would be, with the embed it was likely meant to be and where its name is", () => {
    expect(misspeltIn("Steep /timr(5m) now", 10, NAMES)).toEqual([{ name: "timr", meant: "timer", from: 17, to: 21 }]);
    expect(misspeltIn("/stopwach() and /kanbna()", 0, NAMES).map((m) => m.meant)).toEqual(["stopwatch", "kanban"]);
    // The start of a name is that name, and a word of three letters or fewer one letter off it.
    expect(misspeltIn("/imag(abc) /fil(x)", 0, NAMES).map((m) => m.meant)).toEqual(["image", "file"]);
  });
  it("is nothing for a word nowhere near a name, an embed's own name, or what isn't where an embed would be", () => {
    for (const line of ["/usr/bin(x)", "and/or (x)", "/hello(world)", "/timer(5m)", "x/timr(5m)", "/timr 5m", "/timr(5m", "/a(b)", "/or(x)", "/rm(x)", "/ml(x)", "/fi(x)"]) expect(misspeltIn(line, 0, NAMES), line).toEqual([]);
  });
});

describe("writing an embed", () => {
  it("writes the config in parentheses and the content in a fence tagged with its kind", () => {
    expect(writtenEmbed("timer", "5m")).toBe("/timer(5m)");
    expect(writtenEmbed("html", "", { kind: "html", body: "<p>Hi</p>" })).toBe("/html()\n```html\n<p>Hi</p>\n```");
    expect(writtenEmbed("kanban", "", { kind: "markdown", body: "" })).toBe("/kanban()\n```markdown\n```");
    expect(writtenEmbed("kanban", "", { kind: "markdown", body: "```\nx\n```\n" })).toBe("/kanban()\n````markdown\n```\nx\n```\n````");
  });
});

describe("rewriting an embed", () => {
  const note = "Before /timer(5m) between\n/kanban()\n```markdown\n## To do\n- a\n- b\n## Done\n```\nafter /timer(1m)\n";
  const timer = inlineIn(note)[0]!;
  const board = only(blocksIn(note));

  it("changes the config of the one embed and nothing else in the note", () => {
    expect(apply(note, rewriteOf(timer, { config: "5m at=10s" }))).toBe(note.replace("/timer(5m)", "/timer(5m at=10s)"));
    expect(apply(note, rewriteOf(board, { config: "wide" }))).toBe(note.replace("/kanban()", "/kanban(wide)"));
  });

  it("changes a block's body with one edit that covers only what differs", () => {
    const edits = rewriteOf(board, { body: "## To do\n- a\n## Done\n- b\n" });

    expect(apply(note, edits)).toBe(note.replace("- a\n- b\n## Done\n", "- a\n## Done\n- b\n"));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.from).toBeGreaterThan(note.indexOf("- a"));
    expect(edits[0]!.to).toBeLessThanOrEqual(board.bodyFrom + board.body.length);
  });

  it("gives a body its last line break, and changes config and body together", () => {
    expect(apply(note, rewriteOf(board, { config: "x", body: "## Only" }))).toBe("Before /timer(5m) between\n/kanban(x)\n```markdown\n## Only\n```\nafter /timer(1m)\n");
    expect(apply(note, rewriteOf(board, { body: "" }))).toBe("Before /timer(5m) between\n/kanban()\n```markdown\n```\nafter /timer(1m)\n");
  });

  it("writes the fence for a block with none, and a longer one for a body that would close it", () => {
    const bare = "/kanban()\nafter";
    expect(apply(bare, rewriteOf(only(blocksIn(bare)), { body: "## To do" }))).toBe("/kanban()\n```markdown\n## To do\n```\nafter");
    expect(rewriteOf(only(blocksIn(bare)), { body: "" })).toEqual([]);
    const fenced = apply(note, rewriteOf(board, { body: "## To do\n```\ncode\n```\n" }));
    expect(fenced).toBe("Before /timer(5m) between\n/kanban()\n````markdown\n## To do\n```\ncode\n```\n````\nafter /timer(1m)\n");
    expect(only(blocksIn(fenced)).body).toBe("## To do\n```\ncode\n```\n");
  });

  it("makes no edit when nothing would change", () => {
    expect(rewriteOf(timer, { config: "5m" })).toEqual([]);
    expect(rewriteOf(board, { body: board.body })).toEqual([]);
    expect(rewriteOf(board, {})).toEqual([]);
  });

  it("refuses what would stop the note reading as that embed", () => {
    expect(() => rewriteOf(timer, { config: "5m) /other(" })).toThrow("config");
    expect(() => rewriteOf(timer, { config: "5m\nmore" })).toThrow("config");
    expect(() => rewriteOf(timer, { config: 'say "hi)' })).toThrow("config");
    expect(() => rewriteOf(timer, { body: "text" })).toThrow("content");
    expect(apply(note, rewriteOf(timer, { config: "5m (x)" }))).toContain("/timer(5m (x))");
  });
});
