import { describe, expect, it } from "vitest";
import { linesOutsideCode } from "../../src/core/lines.ts";
import { linksOn } from "../../src/core/links.ts";
import { summarize } from "../../src/core/markdown.ts";
import { mentionsOn } from "../../src/core/mentions.ts";
import { addressSpans, codeSpans } from "../../src/core/spans.ts";
import { parseTodo, tagsOn } from "../../src/core/todos.ts";
import { uploadIds } from "../../src/core/uploadRefs.ts";

const N = 40_000;

/** Lines that each made a pattern try again from every opening it met: seconds a line, before. */
const HOSTILE: Record<string, string> = {
  backticks: "`".repeat(N),
  "backticks apart": "` ".repeat(N / 2),
  "code then everything": `${"`".repeat(N)} [[a]] @[[b]] ::image{aaaaaaaaaaaa} ](x)`,
  addresses: "](".repeat(N / 2),
  links: "[[".repeat(N / 2),
  mentions: "@[[".repeat(N / 3),
  brackets: "[".repeat(N),
  pictures: "![".repeat(N / 2),
  "links with addresses": "[a](".repeat(N / 4),
  "angle addresses": "<http://".repeat(N / 8),
  spaces: `${" ".repeat(N)}x[[`,
  "a heading's spaces": `a${" ".repeat(N)}b`,
  "nested brackets": "[[a]".repeat(N / 4),
  embeds: "::image{".repeat(N / 8),
  mixed: "`[[@[[](![::a{**~~_".repeat(N / 20),
};

describe("reading a very long line", () => {
  for (const [name, line] of Object.entries(HOSTILE)) {
    it(`takes under 50 ms for each reader on ${N.toLocaleString("en")} characters of ${name}`, () => {
      const readers = {
        todo: () => parseTodo(`- [ ] ${line}`),
        tags: () => tagsOn(line),
        links: () => linksOn(line),
        mentions: () => mentionsOn(line),
        uploads: () => uploadIds(line),
        summary: () => summarize(`# ${line}\n${line}`),
      };
      const slow = Object.entries(readers).flatMap(([reader, read]) => {
        const start = performance.now();
        read();
        const ms = performance.now() - start;
        return ms < 50 ? [] : [`${reader}: ${Math.round(ms)} ms`];
      });
      expect(slow).toEqual([]);
    });
  }
});

describe("inline code and addresses on a line", () => {
  it("closes a run of backticks with the next run of as many, and leaves a run nothing closes as backticks", () => {
    expect(codeSpans("a `b` c")).toEqual([[2, 5]]);
    expect(codeSpans("``a ` b`` `c`")).toEqual([
      [0, 9],
      [10, 13],
    ]);
    expect(codeSpans("``` a ` b")).toEqual([]);
    expect(codeSpans("`` a `b`")).toEqual([[5, 8]]);
    expect(codeSpans("no code")).toEqual([]);
  });

  it("finds each address from its `](` to its `)`, and none that a newline or the end cuts off", () => {
    expect(addressSpans("[a](x) and [b](y)")).toEqual([
      [2, 6],
      [13, 17],
    ]);
    expect(addressSpans("[a](x\n[b](y)")).toEqual([[8, 12]]);
    expect(addressSpans("[a](never closed")).toEqual([]);
  });

  it("reads what the line says the same as before", () => {
    expect(parseTodo("- [ ] call `due:2026-01-01` [x](due:2026-01-02) due:2026-01-03")?.due?.date).toBe("2026-01-03");
    expect(linksOn("`[[code]]` [[note]]").map((l) => l.target)).toEqual(["note"]);
    expect(mentionsOn("[x](@[[nobody]]) `@[[nor]]` @[[Ada]]").map((m) => m.target)).toEqual(["Ada"]);
    expect(uploadIds("`::image{aaaaaaaaaaaa}` ::file{bbbbbbbbbbbb}")).toEqual(["bbbbbbbbbbbb"]);
    expect(summarize("# A `code` [link](https://x.y) and [[abcdefghijkl]] and [[Note|shown]] ![pic](p.png)").title).toBe("A code link and and shown");
    expect(summarize("# See [Foo [1]](https://en.wikipedia.org/wiki/Foo_(bar)) here ![p](a_(b).png) ##").title).toBe("See Foo [1] here");
    expect(["# Title ##  ", "# C#", "#   spaced"].map((text) => summarize(text).title)).toEqual(["Title", "C#", "spaced"]);
  });
});

describe("a note of many forms", () => {
  // A form is one line to open it and one to close it, so a note as long as a note can be has some twenty thousand, and as many lines again.
  const forms = 18_000;
  const text = ":::form{}\n:::\n".repeat(forms) + "\nword".repeat(48_000);

  it("is read in one pass: its lines outside the forms in under 200 ms", () => {
    const start = performance.now();
    const lines = [...linesOutsideCode(text)];
    expect(Math.round(performance.now() - start)).toBeLessThan(200);
    expect(lines).toHaveLength(48_001);
    expect(lines.at(-1)).toEqual({ line: "word", from: text.length - 4, index: forms * 2 + 48_000 });
  });

  it("still leaves out each form's lines, and the lines between them stay", () => {
    expect([...linesOutsideCode("a\n:::form{}\n{}\n:::\nb\n:::form{}\n:::\nc")].map((l) => l.line)).toEqual(["a", "b", "c"]);
    expect([...linesOutsideCode(":::form{}\nnever closed")].map((l) => l.line)).toEqual([":::form{}", "never closed"]);
  });
});
