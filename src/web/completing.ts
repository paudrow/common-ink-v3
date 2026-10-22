import { acceptCompletion, autocompletion, closeCompletion, currentCompletions, selectedCompletionIndex, setSelectedCompletion, type Completion as Option, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { grouped, waits, type Group } from "./completionGroups.ts";
import { placed, startsLine, typedAfter } from "./completionSyntax.ts";
import type { Completion, CompletionItem, CompletionPreview } from "./plugin-api.ts";

type Items = readonly CompletionItem[];
/** An option of CodeMirror's with the line under its label that it doesn't draw itself, and the kind of its item. */
type Described = Option & { description?: string; kind?: string };

/**
 * What the list shows while nothing fits the word being typed, so it stays where it was: a key that
 * takes a letter back finds the list there to fill again. It is never highlighted of itself, and
 * picked it closes the list.
 */
const NOTHING: Described = { label: "No matches", type: "none", apply: (view) => void closeCompletion(view) };

/**
 * Opens the list at the cursor while the member types after a completion's trigger, in the editor
 * of note `noteId`. Every completion whose trigger fits is asked, and their items share the one list,
 * grouped by kind and otherwise in the order of the completions. One that throws offers nothing, and
 * `onFail` is told.
 */
export function completing(given: readonly Completion[], noteId: string, onFail: (completion: Completion, error: unknown) => void): Extension {
  if (!given.length) return [];
  const completions = [...given].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  /** Where the list last offered something: where it started, and where the cursor was. */
  let fit: { from: number; to: number } | null = null;

  /** Where a completion's trigger starts and what it offers for what was typed after it, or null when the cursor isn't after its trigger. */
  const ask = (completion: Completion, context: CompletionContext): { completion: Completion; from: number; items: Items | Promise<Items> } | null => {
    const line = context.state.doc.lineAt(context.pos);
    const typed = typedAfter(line.text.slice(0, context.pos - line.from), completion.trigger, completion);
    if (typed === null) return null;
    const from = context.pos - typed.length - completion.trigger.length;
    if (/Code/.test(syntaxTree(context.state).resolveInner(from, 1).name)) return null;
    const failed = (err: unknown): Items => (onFail(completion, err), []);
    try {
      const items = completion.items(typed, { noteId });
      return { completion, from, items: items instanceof Promise ? items.catch(failed) : items };
    } catch (err) {
      return { completion, from, items: failed(err) };
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
      const offered = answers.flatMap((items, i) => items.map((item) => ({ item, completion: asked[i]!.completion, after: asked[i]!.from - from })));
      // The completions have already chosen and ordered what fits, and unfiltered items keep the order they are given in, which grouping by kind keeps within each kind.
      const options = grouped(offered, (o) => o.item.kind).map(({ item: o, group }) => optionFor(o.completion, o.item, o.after, group));
      if (options.length) {
        fit = { from, to: context.pos };
        return { from, to: context.pos, filter: false, update, options };
      }
      // Letters typed on from where something last fit keep the list, saying nothing does. A space or a mark after them closes it: that is prose, or syntax written by hand.
      // So does a prose trigger after other words, as in "yes /no", where the member is as likely writing as asking.
      const still = fit?.from === from && context.pos > fit.to && /^[\p{L}\p{N}]+$/u.test(context.state.sliceDoc(fit.to, context.pos)) && entersAt(context.state);
      return still ? { from, to: context.pos, filter: false, update, options: [NOTHING] } : null;
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
  const optionFor = (completion: Completion, item: CompletionItem, after: number, group: Group | undefined): Described => ({
    ...(item.tone && { type: item.tone }),
    label: item.label,
    detail: item.detail,
    ...(item.description && { description: item.description }),
    ...(item.kind && { kind: item.kind }),
    ...(group && { section: { name: group.heading, rank: group.rank, header: headed } }),
    ...(item.preview && { info: () => drawn(item.preview!) }),
    apply(view, _picked, listFrom, end) {
      const start = listFrom + after;
      const write = (insert: string, from = start, to = end) => {
        const at = view.state.doc.lineAt(from);
        const { anchor, head, ...changes } = placed({ ...item, insert }, { from, to, before: at.text.slice(0, from - at.from), after: at.text.slice(to - at.from), below: at.number < view.state.doc.lines ? view.state.doc.line(at.number + 1).text : null });
        // Typing carried on after it while it was made: the cursor stays where that left it.
        const still = view.state.selection.main.empty && view.state.selection.main.head === to;
        view.dispatch({ changes, ...(still && { selection: { anchor, head } }), scrollIntoView: true, userEvent: "input.complete" });
      };
      if (typeof item.insert === "string") return write(item.insert);
      const typed = view.state.doc.sliceString(start, end);
      const anchor = markAtCursor(view);
      item.insert({ noteId, anchor, focus: () => view.dom.isConnected && view.focus() }).then(
        (insert) => {
          if (insert === null || !view.dom.isConnected) return;
          // Typing before it while it was made moved it: it is written where the trigger and what was typed now are, the nearest, or not at all.
          const text = view.state.doc.toString();
          const found: number[] = [];
          for (let at = text.indexOf(typed); at >= 0; at = text.indexOf(typed, at + 1)) found.push(at);
          const at = found.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0];
          if (at !== undefined) write(insert, at, at + typed.length);
        },
        (err: unknown) => onFail(completion, err),
      ).finally(() => anchor.remove());
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
  // Tab picks what is highlighted, or the first item when nothing is. A list with nothing in it to pick leaves Tab to the note.
  const pick = (view: EditorView) => {
    const shown = currentCompletions(view.state);
    if (shown[0] === NOTHING) return false;
    if (shown.length && selectedCompletionIndex(view.state) === null) view.dispatch({ effects: setSelectedCompletion(0) });
    return acceptCompletion(view);
  };
  // No delays: a member who types `/timer` and Enter without a pause means the timer.
  return [
    // A list opens with nothing highlighted, and its first item is highlighted in the same turn unless a prose trigger follows other words on its line, or the item waits to be picked on purpose, where Enter stays a new line.
    autocompletion({
      override: [source],
      icons: false,
      activateOnTypingDelay: 0,
      interactionDelay: 0,
      selectOnOpen: false,
      optionClass: (option) => (option.type ? `cm-completion-${option.type}` : ""),
      addToOptions: [{ render: (option: Described) => (option.description ? Object.assign(document.createElement("span"), { className: "cm-completionDescription", textContent: option.description }) : null), position: 90 }],
    }),
    EditorView.updateListener.of(({ view, state }) => {
      const first: Described | undefined = currentCompletions(state)[0];
      if (first && first !== NOTHING && !waits(first.kind) && selectedCompletionIndex(state) === null && entersAt(state)) view.dispatch({ effects: setSelectedCompletion(0) });
    }),
    // With no list open Tab is whatever it is elsewhere in a note.
    Prec.highest(keymap.of([{ key: "Tab", run: pick }])),
  ];
}

/** An empty element at the cursor of `view` for a popover to hang from, which scrolls with the note's text. */
function markAtCursor(view: EditorView): HTMLElement {
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.coordsAtPos(view.state.selection.main.head) ?? { left: box.left, top: box.top, bottom: box.top };
  const mark = view.scrollDOM.appendChild(document.createElement("span"));
  Object.assign(mark.style, {
    position: "absolute",
    width: "0",
    left: `${at.left - box.left + view.scrollDOM.scrollLeft}px`,
    top: `${at.top - box.top + view.scrollDOM.scrollTop}px`,
    height: `${at.bottom - at.top}px`,
  });
  return mark;
}

/** A group's heading. The list is a listbox, which holds options alone, so the heading is seen and not read. */
function headed({ name }: { name: string }): HTMLElement {
  return Object.assign(document.createElement("completion-section"), { textContent: name, ariaHidden: "true" });
}

/** A preview as the pane beside the list draws it, or nothing where it has nothing to show. */
function drawn({ image, text, facts }: CompletionPreview): HTMLElement | null {
  if (!image && !text && !facts?.length) return null;
  const pane = document.createElement("div");
  pane.className = "completion-preview";
  if (image) pane.appendChild(Object.assign(document.createElement("img"), { src: image, alt: "", decoding: "async", draggable: false }));
  if (text) pane.appendChild(document.createElement("p")).textContent = text;
  if (facts?.length) {
    const list = pane.appendChild(document.createElement("dl"));
    for (const [name, value] of facts) {
      list.appendChild(document.createElement("dt")).textContent = name;
      list.appendChild(document.createElement("dd")).textContent = value;
    }
  }
  return pane;
}
