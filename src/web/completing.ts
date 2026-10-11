import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { placed, typedAfter } from "./completionSyntax.ts";
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
  // No delays: a member who types `/timer` and Enter without a pause means the timer.
  return autocompletion({ override: completions.map(sourceOf), icons: false, activateOnTypingDelay: 0, interactionDelay: 0 });
}
