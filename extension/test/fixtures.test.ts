import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageToMarkdown } from "../src/clip/html.ts";

interface Fixture {
  id: string;
  category: string;
  url: string;
  title: string;
}

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8")) as Fixture[];

describe("saved pages", () => {
  for (const fixture of fixtures) {
    it(`clips ${fixture.category}: ${fixture.id}`, () => {
      const html = readFileSync(new URL(`./fixtures/${fixture.id}.html`, import.meta.url), "utf8");
      const expected = readFileSync(new URL(`./fixtures/${fixture.id}.md`, import.meta.url), "utf8");
      const markdown = pageToMarkdown(html, { pageTitle: fixture.title, pageUrl: fixture.url, clippedOn: "2026-10-18" });
      expect(markdown).toBe(expected);
    });
  }
});
