import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { classHighlighter, highlightTree } from "@lezer/highlight";

type Loaded = Language | "loading" | "failed";

const loaded = new Map<LanguageDescription, Loaded>();
const marks = new Map<string, Decoration>();
const mark = (classes: string) => marks.get(classes) ?? marks.set(classes, Decoration.mark({ class: classes })).get(classes)!;

/** The parse of each block last drawn, so moving the cursor doesn't parse them again. */
type Tree = ReturnType<Language["parser"]["parse"]>;
const parsed = new Map<string, Tree>();

function parseOf(language: Language, name: string, code: string): Tree {
  const key = `${name}\n${code}`;
  let tree = parsed.get(key);
  if (!tree) {
    if (parsed.size >= 64) parsed.clear();
    parsed.set(key, (tree = language.parser.parse(code)));
  }
  return tree;
}

/** Longer than this and a block is left one color, so typing in it stays quick. */
const LONGEST = 200_000;

/**
 * The colors of a block of code written in `name`, as decorations from `at` in the note. A language
 * is loaded the first time it is asked for: until then the block has no colors, and `onLoad` is
 * called when it has arrived, or `onFail` when it couldn't be fetched. A name nobody knows has none.
 */
export function highlighted(name: string, code: string, at: number, visible: { from: number; to: number }, onLoad: () => void, onFail: (language: string) => void): Range<Decoration>[] {
  const description = name && code.length <= LONGEST ? LanguageDescription.matchLanguageName(languages, name, false) : null;
  if (!description) return [];
  const language = loaded.get(description);
  if (!language) {
    loaded.set(description, "loading");
    description.load().then(
      (support) => {
        loaded.set(description, support.language);
        onLoad();
      },
      () => {
        loaded.set(description, "failed");
        onFail(description.name);
      },
    );
    return [];
  }
  if (typeof language === "string") return [];
  const colors: Range<Decoration>[] = [];
  highlightTree(parseOf(language, description.name, code), classHighlighter, (from, to, classes) => colors.push(mark(classes).range(at + from, at + to)), Math.max(0, visible.from - at), Math.min(code.length, visible.to - at));
  return colors;
}
