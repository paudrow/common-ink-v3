// The word count and reading time of the note in front, at the far end of the bottom bar, as it is
// typed. While some of the note is selected, it says how many of its words are.
const WORDS_A_MINUTE = 230;

// An embed as a note writes it, and the fences around a block's content: what a reader doesn't read.
const EMBED = /(?<=^|\s)\/[a-z][a-z0-9-]*\((?:[^()\n]|\([^()\n]*\))*\)|^ {0,3}(?:`{3,}|~{3,}).*$/gm;

// Markdown's own marks aren't words, and neither is how an embed is written.
function counted(text) {
  const words = text.replace(EMBED, " ").split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return { words, minutes: Math.ceil(words / WORDS_A_MINUTE) };
}

const count = document.createElement("span");
count.setAttribute("aria-label", "Word count");
count.style.padding = "0 8px";

// The whole note is counted again only when it changes, not as the selection moves through it.
let whole = { text: null, words: 0, minutes: 0 };
ink.onNote((note) => {
  // With no note in front there is nothing to say, and the bar gives nothing no room.
  if (!note) return void count.remove();
  if (note.text !== whole.text) whole = { text: note.text, ...counted(note.text) };
  const { words, minutes } = whole;
  const picked = note.selected ? counted(note.selected).words : 0;
  count.textContent = picked ? `${picked} of ${words} ${words === 1 ? "word" : "words"} selected` : `${words} ${words === 1 ? "word" : "words"} · ${minutes} min read`;
  ink.root.append(count);
});
