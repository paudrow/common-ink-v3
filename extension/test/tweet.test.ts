import { describe, expect, it } from "vitest";
import { pageToMarkdown } from "../src/clip/html.ts";
import { tweetFromOembed } from "../src/clip/tweet.ts";
import type { ClipSource } from "../src/clip/types.ts";

const permalink = "https://x.com/jack/status/20";
const source: ClipSource = { pageTitle: "jack on X", pageUrl: permalink, clippedOn: "2026-10-18" };

const oembed = `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>`;

const expected = `# just setting up my twttr

[jack on X](${permalink}) · 2026-10-18

**jack** (@jack)

just setting up my twttr

March 21, 2006

${permalink}
`;

describe("tweets", () => {
  it("reads the text, author, handle, date, and permalink from an oEmbed quote", () => {
    expect(tweetFromOembed(oembed, permalink)).toEqual({
      author: "jack",
      handle: "jack",
      text: "just setting up my twttr",
      date: "March 21, 2006",
      permalink,
      images: [],
    });
  });

  it("keeps the tweet as markdown, with the permalink alone so Common Ink can embed it", () => {
    const page = `<!doctype html><html><head><title>jack on X</title><link rel="canonical" href="${permalink}"></head><body>${oembed}</body></html>`;
    expect(pageToMarkdown(page, source)).toBe(expected);
  });

  it("uses the status card when the page has no quote", () => {
    const page = `<!doctype html><html><head>
      <meta property="og:title" content="jack (@jack)">
      <meta property="og:description" content="just setting up my twttr">
      <meta property="og:image" content="https://pbs.twimg.com/profile_images/example.jpg">
      <meta property="og:image" content="https://pbs.twimg.com/media/example.jpg">
    </head><body><p>Log in to X</p></body></html>`;
    const markdown = pageToMarkdown(page, source);
    expect(markdown).toContain("**jack** (@jack)");
    expect(markdown).toContain("just setting up my twttr");
    expect(markdown).toContain(`\n${permalink}\n`);
    expect(markdown).toContain("[image](https://pbs.twimg.com/media/example.jpg)");
    expect(markdown).not.toContain("Log in to X");
  });
});
