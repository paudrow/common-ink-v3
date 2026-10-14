import { acceptCompletion, autocompletion, currentCompletions, selectedCompletionIndex, setSelectedCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { placed, startsLine, typedAfter } from "./completionSyntax.ts";
import type { Completion, CompletionItem } from "./plugin-api.ts";

/**
 * Opens the list at the cursor while the member types after a completion's trigger. Every
 * completion whose trigger fits is asked, and their items share the one list, in the order of the
 * completions. One that throws offers nothing, and `onFail` is told.
 */
export function completing(completions: readonly Completion[], onFail: (completion: Completion, error: unknown) => void): Extension {
  if (!completions.length) return [];
  const sourceOf = (completion: Completion) => (context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const typed = typedAfter(line.text.slice(0, context.pos - line.from), completion.trigger, completion.spaces);
    if (typed === null) return null;
    const from = context.pos - typed.length - completion.trigger.length;
    if (/Code/.test(syntaxTree(context.state).resolveInner(from, 1).name)) return null;
    const offer = (items: readonly CompletionItem[]): CompletionResult | null =>
      items.length
        ? {
            from,
            to: context.pos,
            // The completion has already chosen and ordered what fits, and unfiltered items keep the order they are given in, one completion after another.
            filter: false,
            options: items.map((item) => ({
              label: item.label,
              detail: item.detail,
              apply(view, _picked, start, end) {
                const at = view.state.doc.lineAt(start);
                const { anchor, head, ...changes } = placed(item, { from: start, to: end, before: at.text.slice(0, start - at.from), after: at.text.slice(end - at.from), last: at.number === view.state.doc.lines });
                view.dispatch({ changes, selection: { anchor, head }, scrollIntoView: true, userEvent: "input.complete" });
              },
            })),
          }
        : null;
    const failed = (err: unknown) => (onFail(completion, err), null);
    try {
      // Answered at once when the completion answers at once, so Enter right after the last letter picks from the list.
      const items = completion.items(typed);
      return items instanceof Promise ? items.then(offer, failed) : offer(items);
    } catch (err) {
      return failed(err);
    }
  };
  const entersAt = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    return completions.every((completion) => {
      const typed = completion.prose ? typedAfter(before, completion.trigger, completion.spaces) : null;
      return typed === null || startsLine(before, typed, completion.trigger);
    });
  };
  // Tab picks what is highlighted, or the first item when nothing is.
  const pick = (view: EditorView) => {
    if (currentCompletions(view.state).length && selectedCompletionIndex(view.state) === null) view.dispatch({ effects: setSelectedCompletion(0) });
    return acceptCompletion(view);
  };
  // No delays: a member who types `/timer` and Enter without a pause means the timer.
  return [
    // A list opens with nothing highlighted, and its first item is highlighted in the same turn unless a prose trigger follows other words on its line, where Enter stays a new line.
    autocompletion({ override: completions.map(sourceOf), icons: false, activateOnTypingDelay: 0, interactionDelay: 0, selectOnOpen: false }),
    EditorView.updateListener.of(({ view, state }) => {
      if (currentCompletions(state).length && selectedCompletionIndex(state) === null && entersAt(state)) view.dispatch({ effects: setSelectedCompletion(0) });
    }),
    // With no list open Tab is whatever it is elsewhere in a note.
    Prec.highest(keymap.of([{ key: "Tab", run: pick }])),
  ];
}
