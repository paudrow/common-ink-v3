// Run by node, whose code runs as a browser's does: the markdown parser reads a note in the tab of whoever opens it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { noteParser, withSpaceRuns } from "../../src/web/plugins/lib/markdownSpaces.ts";

const N = 80_000;

/** How long `read` takes, in whole ms. */
function took(read: () => unknown): number {
  const start = performance.now();
  read();
  return Math.round(performance.now() - start);
}

/** Every node of `tree`, by name and place, so two parses can be compared. */
function nodesOf(tree: Tree): string[] {
  const nodes: string[] = [];
  tree.iterate({ enter: (node) => void nodes.push(`${node.name} ${node.from}-${node.to}`) });
  return nodes;
}

test("a paragraph's run of spaces is read in one pass, and read as before", () => {
  assert.ok(took(() => noteParser.parse(`a${" ".repeat(N)}b\n`)) < 200);
  const stock = markdownLanguage.parser as MarkdownParser;
  const pieces = [" ", "  ", "   ", "\n", "a", "*", "_", "`", "[", "]", "(", ")", "!", "#", "\\", "~", "<", ">", "-", "|", "https://x.y", "&amp;"];
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + Math.floor(random() * 24) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
    assert.deepEqual(nodesOf(noteParser.parse(text)), nodesOf(stock.parse(text)), JSON.stringify(text));
  }
});

test("a block of markdown in a note, and a file of it, read a run of spaces in one pass too", async () => {
  const known = withSpaceRuns(languages);
  for (const found of [LanguageDescription.matchLanguageName(known, "markdown", false), LanguageDescription.matchFilename(known, "notes.mkd")]) {
    assert.equal(found?.name, "Markdown");
    const { language } = await found!.load();
    assert.ok(took(() => language.parser.parse(`a${" ".repeat(N)}b\n`)) < 200);
  }
  assert.equal(withSpaceRuns(languages).length, languages.length);
  assert.equal(LanguageDescription.matchFilename(known, "a.ts")?.name, "TypeScript");
});
