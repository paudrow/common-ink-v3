import type { Surfaces } from "./surfaces.ts";

/** Where a key of vim's is taken outside a note's text. Each is a question `Surfaces.on` answers about where focus is. */
export type Surface = keyof Surfaces["on"];

export interface VimKey {
  /** The command it is, under `vim.`. */
  id: string;
  title: string;
  surface: Surface;
  keys: readonly string[];
  run: (ui: Surfaces) => void;
  /** Whether it may put a note or a tab in front, which then takes focus: a note in its text, a list on its row. */
  arrives?: boolean;
}

/**
 * Vim's keys outside a note's text: where each is taken, and the command it runs. Letters are only
 * on surfaces where nothing is typed. In a field the keys are held with Control, and there are two
 * of each because a browser keeps some for itself off a Mac.
 */
export const KEYS: readonly VimKey[] = [
  { id: "list.down", title: "Vim: next row of a list", surface: "list", keys: ["j"], run: (ui) => ui.move("down") },
  { id: "list.up", title: "Vim: previous row of a list", surface: "list", keys: ["k"], run: (ui) => ui.move("up") },
  { id: "list.first", title: "Vim: first row of a list", surface: "anyList", keys: ["g g"], run: (ui) => ui.move("first") },
  { id: "list.last", title: "Vim: last row of a list", surface: "anyList", keys: ["shift+g"], run: (ui) => ui.move("last") },
  { id: "list.halfDown", title: "Vim: half a page down a list", surface: "anyList", keys: ["ctrl+d"], run: (ui) => ui.move("halfDown") },
  { id: "list.halfUp", title: "Vim: half a page up a list", surface: "anyList", keys: ["ctrl+u"], run: (ui) => ui.move("halfUp") },
  { id: "list.open", title: "Vim: open the selected row", surface: "row", keys: ["enter", "l"], run: (ui) => ui.open(), arrives: true },
  { id: "list.preview", title: "Vim: preview the selected row in the editor area, and stay on it", surface: "beside", keys: ["space"], run: (ui) => ui.preview() },
  { id: "list.out", title: "Vim: collapse the selected row, or go to its parent", surface: "row", keys: ["h"], run: (ui) => ui.out() },
  { id: "list.toggle", title: "Vim: expand or collapse the selected row", surface: "row", keys: ["z a"], run: (ui) => ui.toggle() },
  { id: "list.delete", title: "Vim: delete the selected row, or abandon the selected todo", surface: "deletable", keys: ["d d"], run: (ui) => ui.remove() },
  // Where / is typed with Shift, as on a German keyboard, the press is written shift+/. On a US one Shift and / is shift+?, which is nobody's.
  { id: "search", title: "Vim: go to the search box", surface: "search", keys: ["/", "shift+/"], run: (ui) => ui.search() },
  { id: "field.down", title: "Vim: next row, from a field", surface: "field", keys: ["ctrl+j", "ctrl+n"], run: (ui) => ui.arrow("ArrowDown") },
  { id: "field.up", title: "Vim: previous row, from a field", surface: "field", keys: ["ctrl+k", "ctrl+p"], run: (ui) => ui.arrow("ArrowUp") },
  { id: "field.leave", title: "Vim: leave a field for its list", surface: "fieldOfList", keys: ["escape"], run: (ui) => ui.leaveField() },
  { id: "window.left", title: "Vim: go to the region on the left", surface: "window", keys: ["ctrl+w h"], run: (ui) => ui.go("left") },
  { id: "window.down", title: "Vim: go to the region below", surface: "window", keys: ["ctrl+w j"], run: (ui) => ui.go("down") },
  { id: "window.up", title: "Vim: go to the region above", surface: "window", keys: ["ctrl+w k"], run: (ui) => ui.go("up") },
  { id: "window.right", title: "Vim: go to the region on the right", surface: "window", keys: ["ctrl+w l"], run: (ui) => ui.go("right") },
  { id: "window.previous", title: "Vim: go back to the region you were in", surface: "window", keys: ["ctrl+w p"], run: (ui) => ui.back() },
  { id: "window.next", title: "Vim: go to the next region, round to the first", surface: "window", keys: ["ctrl+w w"], run: (ui) => ui.round() },
  { id: "tab.next", title: "Vim: next tab", surface: "tabs", keys: ["g t"], run: (ui) => ui.tab(1), arrives: true },
  { id: "tab.previous", title: "Vim: previous tab", surface: "tabs", keys: ["g shift+t"], run: (ui) => ui.tab(-1), arrives: true },
];
