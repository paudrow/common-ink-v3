import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { articleFromDocument } from "../src/clip/article.ts";
import { htmlToMarkdown } from "../src/clip/html.ts";

const page = `<!doctype html>
<html>
  <head><title>City desk</title></head>
  <body>
    <nav>Site nav secret menu</nav>
    <aside class="sidebar">Buy widgets now from our sponsor</aside>
    <article>
      <h1>The council voted</h1>
      <p>The vote was delayed until Thursday after a long hearing.</p>
    </article>
    <footer>Copyright the paper</footer>
  </body>
</html>`;

describe("articleFromDocument", () => {
  it("drops the nav and the ad and keeps the article", () => {
    const { document } = parseHTML(page);
    const article = articleFromDocument(document);
    expect(article).not.toBeNull();
    const markdown = htmlToMarkdown(article!.html, {
      baseUrl: "https://example.com/city",
      title: article!.title || "The council voted",
      source: { pageTitle: "City desk", pageUrl: "https://example.com/city", clippedOn: "2026-10-18" },
    });
    expect(markdown).not.toContain("Site nav secret");
    expect(markdown).not.toContain("Buy widgets");
    expect(markdown).not.toContain("Copyright the paper");
    expect(markdown).toContain("The vote was delayed until Thursday");
  });

  it("does not keep a page whose only text is a skip link", () => {
    const html = `<!doctype html><html><head>
      <title>The paper</title>
      <meta property="og:description" content="The council delayed the vote until Thursday after a long hearing.">
    </head><body><a class="skip-link" href="#content">Skip to content</a><div id="content"></div></body></html>`;
    const { document } = parseHTML(html);
    const article = articleFromDocument(document, "https://example.com/city");
    expect(article?.html).toContain("The council delayed the vote");
    expect(article?.html).not.toContain("Skip to content");
  });

  it("keeps the article when the skip link is only chrome around it", () => {
    const html = `<!doctype html><html><head><title>City desk</title></head><body>
      <a href="#content">Skip to content</a>
      <article id="content"><h1>The council voted</h1><p>The vote was delayed until Thursday after a long hearing.</p></article>
    </body></html>`;
    const { document } = parseHTML(html);
    const article = articleFromDocument(document, "https://example.com/city");
    expect(article?.html).toContain("The vote was delayed until Thursday");
    expect(article?.html).not.toContain("Skip to content");
  });
});
