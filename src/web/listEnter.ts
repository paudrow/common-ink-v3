import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { ChangeSet, Prec, type ChangeSpec, type Extension, type StateCommand } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/** Markdown's Enter, which on an empty second item ends the list instead of making it loose. */
const continued = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** What markdown's Enter writes in a loose list before the new item: a line break, a line of nothing but indent and quote marks, and another. */
const LOOSE = /^\n[ \t>]*\n/;

/**
 * Enter in a list, a todo list included, continues it with an item directly below, never with a
 * blank line between: markdown's own Enter copies the blank lines of a list written with them.
 * Enter on an item with nothing in it ends the list, as it does on any item but the second.
 */
const continueList: StateCommand = ({ state, dispatch }) =>
  continued({
    state,
    dispatch(tr) {
      const blanks: ChangeSpec[] = [];
      tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        const loose = inserted.lines > 2 && LOOSE.exec(inserted.sliceString(0, 200));
        if (loose) blanks.push({ from: fromB + 1, to: fromB + loose[0].length });
      });
      if (!blanks.length) return dispatch(tr);
      const tight = ChangeSet.of(blanks, tr.newDoc.length);
      dispatch(state.update({ changes: tr.changes.compose(tight), selection: tr.newSelection.map(tight), scrollIntoView: true, userEvent: "input" }));
    },
  });

/** Markdown's Enter and Backspace for lists and quotes, in place of the ones `markdown()` would add. */
export const listKeys: Extension = Prec.high(keymap.of([{ key: "Enter", run: continueList }, { key: "Backspace", run: deleteMarkupBackward }]));
