import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/clip/html.ts";
import type { ClipSource } from "../src/clip/types.ts";

const source: ClipSource = {
  pageTitle: "Council delays the vote",
  pageUrl: "https://example.com/news/story",
  clippedOn: "2026-10-18",
};

const article = `<article>
  <h1>Council delays the vote</h1>
  <p>See the <a href="/brief">brief</a> and this list:</p>
  <ul>
    <li>Roads</li>
    <li>Parks</li>
  </ul>
  <pre><code class="language-js">let n = 1</code></pre>
  <table>
    <tr><th>Item</th><th>Cost</th></tr>
    <tr><td>Salt</td><td>4</td></tr>
  </table>
  <p><img src="/vote.png" alt="Chamber" width="1200" height="800"></p>
</article>`;

const expected = `# Council delays the vote

[Council delays the vote](https://example.com/news/story) · 2026-10-18

See the [brief](https://example.com/brief) and this list:

- Roads
- Parks

\`\`\`js
let n = 1
\`\`\`

| Item | Cost |
| --- | --- |
| Salt | 4 |

::image{a1b2c3d4e5f6 1200x800}
`;

describe("htmlToMarkdown", () => {
  it("converts an article to a Common Ink note", () => {
    const markdown = htmlToMarkdown(article, {
      baseUrl: "https://example.com/news/story",
      title: "Council delays the vote",
      source,
      placed: { "https://example.com/vote.png": { id: "a1b2c3d4e5f6", width: 1200, height: 800 } },
    });
    expect(markdown).toBe(expected);
  });

  it("writes an unplaced image as a link", () => {
    const markdown = htmlToMarkdown(article, { baseUrl: "https://example.com/news/story", title: "Council delays the vote", source });
    expect(markdown).toContain("[Chamber](https://example.com/vote.png)");
    expect(markdown).not.toContain("![");
    expect(markdown).not.toContain("::image{");
  });

  it("leaves a javascript href as text", () => {
    const markdown = htmlToMarkdown(`<p>Go <a href="javascript:alert(1)">here</a> now</p>`, {
      baseUrl: "https://example.com/news/story",
      title: "Go",
      source: { ...source, pageTitle: "Go" },
    });
    expect(markdown).toContain("Go here now");
    expect(markdown).not.toContain("javascript:");
  });

  it("does not put an embed inside a table cell", () => {
    const markdown = htmlToMarkdown(`<table><tr><th>A</th></tr><tr><td><img src="/x.png" alt="shot"></td></tr></table>`, {
      baseUrl: "https://example.com/news/story",
      title: "Table",
      source: { ...source, pageTitle: "Table" },
      placed: { "https://example.com/x.png": { id: "a1b2c3d4e5f6", width: 10, height: 10 } },
    });
    expect(markdown).not.toContain("::image{");
    expect(markdown).toContain("[shot](https://example.com/x.png)");
  });

  it("renders a checkbox as a plain bullet", () => {
    const markdown = htmlToMarkdown(`<ul><li><input type="checkbox" checked> Eggs</li><li><input type="checkbox"> Milk</li></ul>`, {
      baseUrl: "https://example.com/news/story",
      title: "List",
      source: { ...source, pageTitle: "List" },
    });
    expect(markdown).toContain("- Eggs");
    expect(markdown).toContain("- Milk");
    expect(markdown).not.toContain("[ ]");
    expect(markdown).not.toContain("[x]");
  });

  it("grows a fence past backticks in the code", () => {
    const markdown = htmlToMarkdown("<pre><code>```</code></pre>", {
      baseUrl: "https://example.com/",
      title: "Code",
      source: { ...source, pageTitle: "Code", pageUrl: "https://example.com/" },
    });
    expect(markdown).toContain("````");
    expect(markdown).toContain("```");
  });
});
