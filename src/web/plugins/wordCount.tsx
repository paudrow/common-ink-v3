import type { Plugin } from "../plugin-api.ts";
import { openNotes } from "./lib/openNotes.ts";

const WORDS_A_MINUTE = 230;

/** An embed as a note writes it, and the lines that open and close a block: what a reader doesn't read. */
const EMBED = /:::?[a-z][a-z0-9-]*\{[^{}\n]*\}/g;

/** How many words a note's text has, and how long they take to read. Markdown's own marks aren't words, and neither is how an embed is written. */
export function counted(text: string): { words: number; minutes: number } {
  const words = text.replace(EMBED, " ").split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return { words, minutes: Math.ceil(words / WORDS_A_MINUTE) };
}

/** The open note's word count and reading time, at the right of the bottom bar, as it is typed. */
export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
  activate(host) {
    const notes = openNotes(host);
    host.views.register("bar", {
      id: "word-count",
      component: ({ app }) => {
        const text = notes.useText(app.noteId);
        if (text === null) return null;
        const { words, minutes } = counted(text);
        return (
          <span className="bar-item bar-end" aria-label="Word count">
            {words} {words === 1 ? "word" : "words"} · {minutes} min read
          </span>
        );
      },
    });
  },
};
