import { acceptCompletion, autocompletion, currentCompletions, selectedCompletionIndex, setSelectedCompletion, type Completion as Option, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { placed, startsLine, typedAfter } from "./completionSyntax.ts";
import type { Completion, CompletionItem } from "./plugin-api.ts";

type Items = readonly CompletionItem[];

/**
 * Opens the list at the cursor while the member types after a completion's trigger. Every
 * completion whose trigger fits is asked, and their items share the one list, in the order of the
 * completions. One that throws offers nothing, and `onFail` is told.
 */
export function completing(completions: readonly Completion[], onFail: (completion: Completion, error: unknown) => void): Extension {
  if (!completions.length) return [];

  /** Where a completion's trigger starts and what it offers for what was typed after it, or null when the cursor isn't after its trigger. */
  const ask = (completion: Completion, context: CompletionContext): { from: number; items: Items | Promise<Items> } | null => {
    const line = context.state.doc.lineAt(context.pos);
    const typed = typedAfter(line.text.slice(0, context.pos - line.from), completion.trigger, completion);
    if (typed === null) return null;
    const from = context.pos - typed.length - completion.trigger.length;
    if (/Code/.test(syntaxTree(context.state).resolveInner(from, 1).name)) return null;
    const failed = (err: unknown): Items => (onFail(completion, err), []);
    try {
      const items = completion.items(typed);
      return { from, items: items instanceof Promise ? items.catch(failed) : items };
    } catch (err) {
      return { from, items: failed(err) };
    }
  };

  /**
   * One source for every completion. To CodeMirror each source is asked on its own a moment after a
   * key, and the list takes no keys while any of them is still to answer, so with a source apiece
   * Enter pressed right after the last letter would break the line instead of picking.
   */
  function source(context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> {
    const asked = completions.flatMap((completion) => ask(completion, context) ?? []);
    if (!asked.length) return null;
    const from = Math.min(...asked.map((a) => a.from));
    const offer = (answers: Items[]): CompletionResult | null => {
      // The completion has already chosen and ordered what fits, and unfiltered items keep the order they are given in, one completion after another.
      const options = answers.flatMap((items, i) => items.map((item) => optionFor(item, asked[i]!.from - from)));
      return options.length ? { from, to: context.pos, filter: false, update, options } : null;
    };
    const answers = asked.map((a) => a.items);
    // Answered at once when every completion answers at once, so the list is right by the member's next key.
    return answers.some((items) => items instanceof Promise) ? Promise.all(answers).then(offer) : offer(answers as Items[]);
  }

  /** Asked again within the keystroke that changed what was typed, where that can be answered at once. */
  const update: CompletionResult["update"] = (_shown, _from, _to, context) => {
    const again = source(context);
    return again instanceof Promise ? null : again;
  };

  /** `after` is how far the item's own trigger is past where the list starts, which is the earliest trigger of those that fit. */
  const optionFor = (item: CompletionItem, after: number): Option => ({
    label: item.label,
    detail: item.detail,
    apply(view, _picked, listFrom, end) {
      const start = listFrom + after;
      const at = view.state.doc.lineAt(start);
      const { anchor, head, ...changes } = placed(item, { from: start, to: end, before: at.text.slice(0, start - at.from), after: at.text.slice(end - at.from), last: at.number === view.state.doc.lines });
      view.dispatch({ changes, selection: { anchor, head }, scrollIntoView: true, userEvent: "input.complete" });
    },
  });

  const entersAt = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    return completions.every((completion) => {
      const typed = completion.prose ? typedAfter(before, completion.trigger, completion) : null;
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
    autocompletion({ override: [source], icons: false, activateOnTypingDelay: 0, interactionDelay: 0, selectOnOpen: false }),
    EditorView.updateListener.of(({ view, state }) => {
      if (currentCompletions(state).length && selectedCompletionIndex(state) === null && entersAt(state)) view.dispatch({ effects: setSelectedCompletion(0) });
    }),
    // With no list open Tab is whatever it is elsewhere in a note.
    Prec.highest(keymap.of([{ key: "Tab", run: pick }])),
  ];
}
