import { describe, expect, it } from "vitest";
import { summarize } from "../../src/core/markdown.ts";

describe("a note's title", () => {
  it("is its first # heading", () => {
    expect(summarize("intro\n## Not this\n# Café Notes #\n# Later").title).toBe("Café Notes");
  });

  it("skips headings inside code blocks", () => {
    expect(summarize("```sh\n# a comment\n```\n# Real title").title).toBe("Real title");
  });

  it("keeps a # that is part of the words", () => {
    expect(summarize("# Learning C#").title).toBe("Learning C#");
  });

  it("is empty without a heading", () => {
    expect(summarize("#hashtag only\n\nbody").title).toBe("");
  });
});

describe("a note's snippet", () => {
  it("is the prose after the title without heading, quote, list, or checkbox marks", () => {
    const text = "# Trip\n\n## Packing\n> Bring a coat\n- socks\n* hat\n+ scarf\n1. passport\n2) tickets\n- [ ] call mum\n- [x] book hotel";

    expect(summarize(text)).toEqual({
      title: "Trip",
      snippet: "Packing Bring a coat socks hat scarf passport tickets call mum book hotel",
      openTodos: 1,
    });
  });

  it("shows the text of links and drops inline formatting", () => {
    const text = "See [the docs](https://example.com), [[abc123def456|Groceries]] and [[Weekend]] with `code`, **bold**, *it* and ~~old~~.";

    expect(summarize(text).snippet).toBe("See the docs, Groceries and Weekend with code, bold, it and old.");
  });

  it("leaves out code blocks and horizontal rules", () => {
    expect(summarize("Above\n\n```js\nconst a = 1;\n```\n\n---\n\nBelow").snippet).toBe("Above Below");
  });

  it("is cut at a word boundary when longer than 160 characters", () => {
    const words = Array(40).fill("lorem").join(" ");

    expect(summarize(words).snippet).toBe(`${"lorem ".repeat(25)}lorem…`);
    expect(summarize("x".repeat(160)).snippet).toBe("x".repeat(160));
    expect(summarize("x".repeat(200)).snippet).toBe(`${"x".repeat(159)}…`);
  });
});

describe("a note's snippet of a todo", () => {
  it("is the todo's words, without its importance, due date and projects", () => {
    expect(summarize("# Plan\n\n- [ ] !! Call the **bank** due:2026-10-14 +Home #money\n- [x] done +Trip").snippet).toBe("Call the bank #money done");
  });
});

describe("a note's open todos", () => {
  it("count unchecked list checkboxes", () => {
    expect(summarize("- [ ] a\n  * [ ] nested\n3. [ ] numbered\n4) [ ]\n- [x] done\n- [ ]no space\n[ ] not in a list").openTodos).toBe(4);
  });

  it("leave out checkboxes and headings inside code blocks", () => {
    const text = "```md\n# Not a title\n- [ ] not a todo\n```\n# Real\n- [ ] real todo\n~~~\n```\n- [ ] still code\n~~~";

    expect(summarize(text)).toEqual({ title: "Real", snippet: "real todo", openTodos: 1 });
  });
});
