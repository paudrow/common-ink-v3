import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import type { MarkdownConfig, MarkdownParser } from "@lezer/markdown";

/**
 * A run of spaces in a line's words, read in one step. The markdown parser's own hard break looks
 * from each space to the end of its run for the line break two spaces make, so a run of many took
 * seconds, and minutes as it grew, in the tab of whoever read the note. A run that does end in a
 * line break is left to that rule, which then reads it once.
 */
export const spaceRuns: MarkdownConfig = {
  parseInline: [
    {
      name: "SpaceRun",
      before: "HardBreak",
      parse(cx, next, pos) {
        if (next !== 32) return -1;
        let end = pos + 1;
        while (cx.char(end) === 32) end++;
        return end - pos >= 2 && cx.char(end) === 10 ? -1 : end;
      },
    },
  ],
};

/** The parser notes are read with, for text read outside an editor: GitHub's markdown, with runs of spaces read in one step. */
export const noteParser = (markdownLanguage.parser as MarkdownParser).configure(spaceRuns);

/**
 * `languages` with Markdown's read the same way, for a block of markdown in a note and a file of it:
 * someone else's text as much as the note is.
 */
export const withSpaceRuns = (languages: readonly LanguageDescription[]): LanguageDescription[] =>
  languages.map((language) =>
    language.name === "Markdown" ? LanguageDescription.of({ name: language.name, alias: language.alias, extensions: language.extensions, load: () => Promise.resolve(markdown({ extensions: spaceRuns })) }) : language,
  );
