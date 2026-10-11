import { describe, expect, it } from "vitest";
import { fencedIn } from "../../src/web/plugins/code/fence.ts";

describe("a fenced code block", () => {
  it("has a language and the code between its fences", () => {
    const text = "```ts\nconst a = 1;\n\nconsole.log(a);\n```";

    expect(fencedIn(text)).toEqual({ language: "ts", code: "const a = 1;\n\nconsole.log(a);", from: 6, to: 35, closed: true });
    expect(text.slice(6, 35)).toBe("const a = 1;\n\nconsole.log(a);");
  });

  it("takes the first word after the fence as its language", () => {
    expect(fencedIn("~~~ python title=x\npass\n~~~")).toMatchObject({ language: "python", code: "pass", closed: true });
    expect(fencedIn("```\nplain\n```")).toMatchObject({ language: "", code: "plain" });
  });

  it("runs to the end when it has no closing fence, and a shorter fence doesn't close it", () => {
    expect(fencedIn("```js\nlet a;")).toMatchObject({ code: "let a;", closed: false });
    expect(fencedIn("````\n```\ninner\n```\n````")).toMatchObject({ code: "```\ninner\n```", closed: true });
    expect(fencedIn("```js")).toMatchObject({ code: "", from: 5, to: 5, closed: false });
  });

  it("gives the code without the indent of its fence", () => {
    expect(fencedIn("  ```\n  a\n    b\n c\n  ```")).toMatchObject({ code: "a\n  b\nc" });
  });

  it("is an empty string when nothing is between the fences", () => {
    expect(fencedIn("```sh\n```")).toMatchObject({ code: "", from: 6, to: 6, closed: true });
  });

  it("isn't read from text that doesn't open with a fence", () => {
    expect(fencedIn("words\n```")).toBeNull();
  });
});
