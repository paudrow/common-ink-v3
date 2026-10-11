import type { Plugin } from "../../plugin-api.ts";
import { markdownMarks } from "./marks.ts";

/**
 * GitHub-flavored markdown drawn where it is written: emphasis, strikethrough, headings, links,
 * quotes, rules, and inline code. The editor parses it either way. With this off, a note shows
 * every mark. A task list's checkboxes are the todos plugin's.
 */
export const gfm: Plugin = {
  id: "gfm",
  name: "GitHub-flavored markdown",
  activate(host) {
    host.editorExtensions.register({ id: "gfm.marks", extension: markdownMarks });
  },
};
