import { describe, expect, it } from "vitest";
import { linkedFolder, linkedIds, linksIn, linksOn, retargeted, writtenFolderLink } from "../../src/core/links.ts";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

describe("links as a note writes them", () => {
  it("reads a link's target and its display text, with where it is", () => {
    expect(linksOn(`See [[${A}]] and [[${B}|the plan]].`, 100)).toEqual([
      { from: 104, to: 120, target: A, display: null },
      { from: 125, to: 150, target: B, display: "the plan" },
    ]);
  });

  it("takes an empty display text for none, and trims both parts", () => {
    expect(linksOn(`[[ ${A} | ]]`)).toEqual([{ from: 0, to: 20, target: A, display: null }]);
  });

  it("leaves out what isn't a whole link", () => {
    expect(linksOn("[[]] [[ ]] [[open [single] ]]")).toEqual([]);
  });

  it("leaves out links in inline code and in code blocks", () => {
    const text = `[[${A}]]\n\`[[${B}]]\` and \`\`a \` [[${B}]]\`\`\n\`\`\`sh\nif [[ -f x ]]; then\n[[${B}]]\n\`\`\`\n~~~\n[[${B}]]\n~~~\nafter [[Title]]`;

    expect(linksIn(text).map((l) => l.target)).toEqual([A, "Title"]);
    expect(text.slice(linksIn(text)[1]!.from)).toBe("[[Title]]");
  });

  it("reads a link on an indented line, which may be a nested bullet as well as a code block", () => {
    expect(linkedIds(`- one\n    - two\n        - [[${A}]]\n\nwords\n\n    [[${B}]]`)).toEqual([A, B]);
  });

  it("names each note linked by id once, in order", () => {
    expect(linkedIds(`[[${B}]] [[Plan]] [[${A}|a]] [[${B}|again]]`)).toEqual([B, A]);
  });

  it("writes targets another way and keeps display text and everything else", () => {
    const to = (target: string) => ({ Plan: A, Trip: B })[target];

    expect(retargeted("# T\n\n[[Plan]] then [[Trip|go]] and [[Other]]\n`[[Plan]]`", to)).toBe(`# T\n\n[[${A}]] then [[${B}|go]] and [[Other]]\n\`[[Plan]]\``);
  });
});

describe("a link to a folder", () => {
  it("is written by the folder's id, and read back as that folder; any other target is no folder's", () => {
    expect(writtenFolderLink(A)).toBe(`[[folder:${A}]]`);
    expect(linksOn(`See ${writtenFolderLink(A)}.`).map((link) => linkedFolder(link.target))).toEqual([A]);
    expect([A, "folder:", "folder:short", `folder:${A}x`, `Folder:${A}`].map(linkedFolder)).toEqual([null, null, null, null, null]);
  });

  it("names no note", () => {
    expect(linkedIds(`[[folder:${A}]] [[${B}]]`)).toEqual([B]);
  });
});
