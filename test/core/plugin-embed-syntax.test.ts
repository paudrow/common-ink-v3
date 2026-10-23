import { describe, expect, it } from "vitest";
import { blocksIn, inlineIn, rewriteOf, type Rewrite, type Written } from "../../src/core/embedSyntax.ts";

const apply = (text: string, edits: readonly Rewrite[]) => [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const only = (found: Written[]) => {
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("embeds as a note writes them", () => {
  it("finds inline embeds with where their config is, and leaves the opening of a block alone", () => {
    const text = "Time ::timer{5m} and ::stopwatch{} here\n:::kanban{}\n:::";

    expect(inlineIn(text).map((w) => [w.name, w.config, text.slice(w.from, w.to), w.configFrom])).toEqual([
      ["timer", "5m", "::timer{5m}", 13],
      ["stopwatch", "", "::stopwatch{}", 33],
    ]);
    expect(inlineIn("a ::timer{5m}", 100)[0]).toMatchObject({ from: 102, to: 113, configFrom: 110, block: false, body: "" });
  });

  it("finds a block from its opening line to its closing line, with its body between", () => {
    const text = "# Plan\n\n:::kanban{wide}\n## To do\n- a\n:::\nafter\n";
    const block = only(blocksIn(text));

    expect(block).toMatchObject({ name: "kanban", config: "wide", body: "## To do\n- a\n", block: true });
    expect(text.slice(block.from, block.to)).toBe(":::kanban{wide}\n## To do\n- a\n:::");
    expect(text.slice(block.configFrom, block.configFrom + 4)).toBe("wide");
    expect(text.slice(block.bodyFrom, block.bodyFrom + block.body.length)).toBe(block.body);
  });

  it("reads a block with nothing in it, and two blocks one after the other", () => {
    expect(blocksIn(":::a{}\n:::\n:::b{}\nx\n:::").map((b) => [b.name, b.body])).toEqual([
      ["a", ""],
      ["b", "x\n"],
    ]);
  });

  it("takes for a block neither one that is never closed, nor one in a code fence, nor one that doesn't start its line", () => {
    expect(blocksIn(":::kanban{}\n## To do\n- a\n")).toEqual([]);
    expect(blocksIn("```\n:::kanban{}\n:::\n```\n")).toEqual([]);
    expect(blocksIn("~~~~\n:::kanban{}\n```\n:::\n~~~~\n")).toEqual([]);
    expect(blocksIn(" :::kanban{}\n:::\n")).toEqual([]);
    expect(blocksIn("see :::kanban{}\n:::\n")).toEqual([]);
    expect(blocksIn(":::kanban\n:::\n")).toEqual([]);
    expect(only(blocksIn("```\ncode\n```\n:::kanban{}\n:::")).name).toBe("kanban");
  });

  it("keeps a code fence inside a block as the block's body", () => {
    expect(only(blocksIn(":::kanban{}\n```\n## not a column\n```\n:::")).body).toBe("```\n## not a column\n```\n");
  });
});

describe("rewriting an embed", () => {
  const note = "Before ::timer{5m} between\n:::kanban{}\n## To do\n- a\n- b\n## Done\n:::\nafter ::timer{1m}\n";
  const timer = inlineIn(note)[0]!;
  const board = only(blocksIn(note));

  it("changes the config of the one embed and nothing else in the note", () => {
    expect(apply(note, rewriteOf(timer, { config: "5m at=10s" }))).toBe(note.replace("::timer{5m}", "::timer{5m at=10s}"));
    expect(apply(note, rewriteOf(board, { config: "wide" }))).toBe(note.replace(":::kanban{}", ":::kanban{wide}"));
  });

  it("changes a block's body with one edit that covers only what differs", () => {
    const edits = rewriteOf(board, { body: "## To do\n- a\n## Done\n- b\n" });

    expect(apply(note, edits)).toBe(note.replace("- a\n- b\n## Done\n", "- a\n## Done\n- b\n"));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.from).toBeGreaterThan(note.indexOf("- a"));
    expect(edits[0]!.to).toBeLessThanOrEqual(board.bodyFrom + board.body.length);
  });

  it("gives a body its last line break, and changes config and body together", () => {
    expect(apply(note, rewriteOf(board, { config: "x", body: "## Only" }))).toBe("Before ::timer{5m} between\n:::kanban{x}\n## Only\n:::\nafter ::timer{1m}\n");
    expect(apply(note, rewriteOf(board, { body: "" }))).toBe("Before ::timer{5m} between\n:::kanban{}\n:::\nafter ::timer{1m}\n");
  });

  it("makes no edit when nothing would change", () => {
    expect(rewriteOf(timer, { config: "5m" })).toEqual([]);
    expect(rewriteOf(board, { body: board.body })).toEqual([]);
    expect(rewriteOf(board, {})).toEqual([]);
  });

  it("refuses what would stop the note reading as that embed", () => {
    expect(() => rewriteOf(timer, { config: "5m} ::other{" })).toThrow("config");
    expect(() => rewriteOf(timer, { config: "5m\nmore" })).toThrow("config");
    expect(() => rewriteOf(board, { body: "## To do\n:::\n# Escaped\n" })).toThrow(":::");
    expect(() => rewriteOf(timer, { body: "text" })).toThrow("block");
  });
});
