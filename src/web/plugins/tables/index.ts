import type { Plugin } from "../../plugin-api.ts";
import { editTable, hasTable, tableRendering } from "./rendering.ts";

/**
 * A markdown table drawn as a table whose cells are typed in where they are drawn. What is typed is
 * written back into the note's markdown as the member's edit.
 */
export const tables: Plugin = {
  id: "tables",
  name: "Tables",
  activate(host) {
    host.editorExtensions.register({ id: "tables", extension: tableRendering });
    host.commands.register({
      id: "tables.edit",
      title: "Edit the next table",
      keys: ["mod+alt+t"],
      when: () => !!hasTable(document.activeElement),
      run() {
        const view = hasTable(document.activeElement);
        if (view) editTable(view);
      },
    });
  },
};
