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

  it("is the first line of words when no line is a # heading", () => {
    expect(summarize("#hashtag only\n\nbody")).toEqual({ title: "#hashtag only", snippet: "body", openTodos: 0 });
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
    const text = "# T\n\nSee [the docs](https://example.com), [[abc123def456|Groceries]] and [[Weekend]] with `code`, **bold**, *it* and ~~old~~.";

    expect(summarize(text).snippet).toBe("See the docs, Groceries and Weekend with code, bold, it and old.");
  });

  it("leaves out code blocks and horizontal rules", () => {
    expect(summarize("# T\n\nAbove\n\n```js\nconst a = 1;\n```\n\n---\n\nBelow").snippet).toBe("Above Below");
  });

  it("is cut at a word boundary when longer than 160 characters", () => {
    const words = Array(40).fill("lorem").join(" ");

    expect(summarize(words).snippet).toBe(`${"lorem ".repeat(25)}lorem…`);
    expect(summarize("x".repeat(160)).snippet).toBe("x".repeat(160));
    expect(summarize("x".repeat(200)).snippet).toBe(`${"x".repeat(159)}…`);
  });
});

describe("a note's snippet of a todo", () => {
  it("is the todo's words, without its importance and due date", () => {
    expect(summarize("# Plan\n\n- [ ] !! Call the **bank** due:2026-10-14 +Home #money\n- [x] done +Trip").snippet).toBe("Call the bank +Home #money done +Trip");
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

describe("a note's title without a # heading", () => {
  it("is its first line of words", () => {
    expect(summarize("Shopping for the week\n\n- milk\n- eggs")).toEqual({ title: "Shopping for the week", snippet: "milk eggs", openTodos: 0 });
    expect(summarize("\n\n## Agenda\n\nfirst item").title).toBe("Agenda");
    expect(summarize("> A quoted opening\nmore").title).toBe("A quoted opening");
  });

  it("is a todo's words, without its box, importance and due date", () => {
    expect(summarize("- [ ] !! Call the bank due:2026-10-14 +Home\n- [ ] other")).toEqual({ title: "Call the bank +Home", snippet: "other", openTodos: 2 });
  });

  it("is cut at a word when the line is long, and the line is still the start of the snippet", () => {
    const line = "word ".repeat(30).trim();
    const { title, snippet } = summarize(`${line}\n\nafter`);
    expect(title).toBe(`${"word ".repeat(16).trim()}…`);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(snippet.startsWith("word word")).toBe(true);
  });

  it("passes over what is drawn and says nothing: an embed, an image, a rule, math's fence, a link by id, a code block", () => {
    expect(summarize("::timer{5m}\n![a cat](/files/abc)\n---\n[[abc123def456]]\n```js\nconst a = 1;\n```\n$$\nReal words here").title).toBe("Real words here");
  });

  it("passes over a line that is only a web address when another line says something, and is that address when none does", () => {
    expect(summarize("https://www.youtube.com/watch?v=NgRkyAlJx5s\n\nWorth watching").title).toBe("Worth watching");
    expect(summarize("https://example.com/a\n<https://example.com/b>").title).toBe("https://example.com/a");
  });

  it("is empty only for a note with no words: nothing, a new note's `# `, or marks alone", () => {
    for (const text of ["", "# ", "#", "\n\n", "- [ ] ", "::timer{5m}", "---"]) expect(summarize(text).title, JSON.stringify(text)).toBe("");
  });

  it("gives way to a # heading further down, and keeps the lines before it as prose", () => {
    expect(summarize("intro words\n\n# The Title\n\nbody")).toEqual({ title: "The Title", snippet: "intro words body", openTodos: 0 });
  });

  it("is not a # heading with no words: the first heading that has words is", () => {
    expect(summarize("# \n# [[abc123def456]]\n# Named").title).toBe("Named");
  });
});

describe("a note's title, as words", () => {
  it("carries no marks: not bold, code, a link's address, a link's id, a mention's id or an embed", () => {
    expect(summarize("# **Bold** `plan` for [the trip](https://example.com) with [[abc123def456|Groceries]] and @[[p1|Ada]] ::timer{5m}").title).toBe("Bold plan for the trip with Groceries and @Ada");
    expect(summarize("# Notes on [[abc123def456]]").title).toBe("Notes on");
  });

  it("keeps a * or a backtick that is one of the words, and takes the marks around words", () => {
    expect(summarize("# 2 * 3 = 6").title).toBe("2 * 3 = 6");
    expect(summarize("# `rm -rf *` and *why* it is __bad__ ~~maybe~~").title).toBe("rm -rf * and why it is bad maybe");
    expect(summarize("# snake_case_name and a_b").title).toBe("snake_case_name and a_b");
  });
});
