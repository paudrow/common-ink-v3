import type { Plugin } from "../../plugin-api.ts";
import { markdownMarks } from "./marks.ts";
import { taskCheckboxes } from "./tasks.ts";

/**
 * GitHub-flavored markdown drawn where it is written: emphasis, strikethrough, headings, links,
 * quotes, rules, inline code, and a task list's checkboxes. The editor parses it either way. With
 * this off, a note shows every mark.
 */
export const gfm: Plugin = {
  id: "gfm",
  name: "GitHub-flavored markdown",
  activate(host) {
    host.editorExtensions.register({ id: "gfm.marks", extension: markdownMarks });
    host.editorExtensions.register({ id: "gfm.tasks", extension: taskCheckboxes });
  },
};
