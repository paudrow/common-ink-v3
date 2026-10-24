import type { Plugin } from "../plugin-api.ts";
import { canSelect, clearHere, extendBy, hasSelection } from "./lib/selecting.ts";

/**
 * The keys for picking several rows of a list to act on at once, in the lists that let their rows be
 * picked: Shift with Down or Up widens what is picked from the row focus is on, and Escape lets it
 * go. Vim's V is vim's, and picking with the pointer is the window's (`selecting`).
 */
export const listSelection: Plugin = {
  id: "list-selection",
  name: "Selecting rows",
  description: "Keys to select several rows of a list, such as todos or notes, to act on them together: Shift with ↓ or ↑, and Escape to clear them.",
  icon: "check",
  activate(host) {
    host.commands.register({ id: "list.selectDown", title: "Select the next row too", keys: ["shift+arrowdown"], group: "Lists", when: canSelect, run: () => extendBy(1) });
    host.commands.register({ id: "list.selectUp", title: "Select the row before too", keys: ["shift+arrowup"], group: "Lists", when: canSelect, run: () => extendBy(-1) });
    host.commands.register({ id: "list.clearSelection", title: "Clear the selected rows", keys: ["escape"], group: "Lists", when: hasSelection, run: clearHere });
  },
};
