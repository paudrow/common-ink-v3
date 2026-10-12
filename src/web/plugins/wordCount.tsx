import { useOpenNote, type OpenNote, type Plugin } from "../plugin-api.ts";

const WORDS_A_MINUTE = 230;

/** An embed as a note writes it, and the lines that open and close a block: what a reader doesn't read. */
const EMBED = /:::?[a-z][a-z0-9-]*\{[^{}\n]*\}/g;

/** How many words a note's text has, and how long they take to read. Markdown's own marks aren't words, and neither is how an embed is written. */
export function counted(text: string): { words: number; minutes: number } {
  const words = text.replace(EMBED, " ").split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return { words, minutes: Math.ceil(words / WORDS_A_MINUTE) };
}

/** What the bar says of a note: its count and reading time, or how many of its words are selected while some are. */
export function said({ text, selected }: OpenNote): string {
  const { words, minutes } = counted(text);
  const picked = counted(selected).words;
  if (picked) return `${picked} of ${words} ${words === 1 ? "word" : "words"} selected`;
  return `${words} ${words === 1 ? "word" : "words"} · ${minutes} min read`;
}

/** The word count and reading time of the note in front, at the right end of the bottom bar, as it is typed. */
export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
  description: "The word count and reading time of the note in front, in the bottom bar. Select some of it to count just that.",
  icon: "text",
  activate(host) {
    host.views.register("bar", {
      id: "word-count",
      side: "right",
      component: ({ app }) => {
        const note = useOpenNote(app.noteId);
        return note && <span aria-label="Word count">{said(note)}</span>;
      },
    });
  },
};
