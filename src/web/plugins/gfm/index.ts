import type { Plugin } from "../../plugin-api.ts";
import { hangingLists } from "./lists.ts";
import { markdownMarks } from "./marks.ts";
import { taskCheckboxes } from "./tasks.ts";

/**
 * GitHub-flavored markdown drawn where it is written: emphasis, strikethrough, headings, links,
 * quotes, rules, inline code, a task list's checkboxes, and list items whose wrapped rows hang under
 * their first word. The editor parses it either way. With this off, a note shows every mark.
 */
export const gfm: Plugin = {
  id: "gfm",
  name: "GitHub-flavored markdown",
  description: "Emphasis, headings, links, quotes and inline code drawn where they are written.",
  icon: "markdown",
  activate(host) {
    host.editorExtensions.register({ id: "gfm.marks", extension: markdownMarks });
    host.editorExtensions.register({ id: "gfm.tasks", extension: taskCheckboxes });
    host.editorExtensions.register({ id: "gfm.lists", extension: hangingLists });
  },
};
