import type { Plugin } from "../../plugin-api.ts";
import { hangingLists } from "./lists.ts";
import { markdownMarks } from "./marks.ts";

/**
 * GitHub-flavored markdown drawn where it is written: emphasis, strikethrough, headings, links,
 * quotes, rules, inline code, and list items whose wrapped rows hang under their first word. The
 * editor parses it either way. With this off, a note shows every mark. A task list's checkboxes are
 * the todos plugin's.
 */
export const gfm: Plugin = {
  id: "gfm",
  name: "GitHub-flavored markdown",
  description: "Emphasis, headings, links, quotes and inline code drawn where they are written.",
  icon: "markdown",
  activate(host) {
    host.editorExtensions.register({ id: "gfm.marks", extension: markdownMarks });
    host.editorExtensions.register({ id: "gfm.lists", extension: hangingLists });
  },
};
