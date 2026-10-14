import type { Plugin } from "../../plugin-api.ts";
import { actOnLastCell, editTable, hasTable, tableRendering } from "./rendering.ts";
import { CELL_ACTIONS } from "./table.ts";

/**
 * A markdown table drawn as a table whose cells are typed in where they are drawn. What is typed is
 * written back into the note's markdown as the member's edit. Rows and columns are added and deleted
 * from a cell's menu, a right-click or the menu key, and from the palette for the cell last typed in.
 */
export const tables: Plugin = {
  id: "tables",
  name: "Tables",
  description: "A markdown table drawn as a table, typed into cell by cell.",
  icon: "table",
  screenshots: [{ src: "/plugin-shots/tables-light.png", dark: "/plugin-shots/tables-dark.png", alt: "A markdown table in a note, drawn as a table." }],
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
    for (const { id, label } of CELL_ACTIONS) host.commands.register({ id: `tables.${id}`, title: `Table: ${label.toLowerCase()}`, run: () => void actOnLastCell(id) });
  },
};
