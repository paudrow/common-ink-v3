import type { Input } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { BlockContext, MarkdownConfig } from "@lezer/markdown";
import { readNote } from "../core/embedSyntax.ts";

/**
 * Where in a note an embed's markdown content is fenced, by where each line starts: its embed's line,
 * which with the fence under it is one node, to where that fence's line ends, and its closing fence's
 * line. The parser can't ask which names are embeds, so any `/name(…)` alone on its line counts, with
 * a fence under it tagged `markdown`. Read once for each text the parser is given.
 */
const fencesIn = new WeakMap<Input, ReadonlyMap<number, number>>();

function fences(input: Input): ReadonlyMap<number, number> {
  let found = fencesIn.get(input);
  if (!found) {
    const { blocks } = readNote(input.read(0, input.length), () => "markdown");
    found = new Map(blocks.flatMap(({ from, fence }) => (fence?.info === "markdown" ? [[from, fence.open.to] as const, [fence.close.from, fence.close.to] as const] : [])));
    fencesIn.set(input, found);
  }
  return found;
}

// The parser keeps the text it reads to itself; it is there all the same.
const fenceAt = (cx: BlockContext) => (cx.parentType().name === "Document" ? fences((cx as unknown as { input: Input }).input).get(cx.lineStart) : undefined);

/**
 * An embed's markdown content, as a board's is, is read as the note's own markdown and not as code:
 * its embed's line with the fence under it, and its closing fence, are nodes of their own, and what is
 * between them is headings, lists, todos, links and tags, which the note's live preview draws while
 * the embed's source is shown. The embed's line and its fence are one node, so a change to either is
 * read again with the other, and the parser never keeps a fence it read for a line above that changed.
 */
export const embedContent: MarkdownConfig = {
  defineNodes: [{ name: "EmbedFence", style: tags.processingInstruction }],
  parseBlock: [
    {
      name: "EmbedFence",
      before: "FencedCode",
      parse(cx, line) {
        const to = fenceAt(cx);
        if (to === undefined) return false;
        cx.addElement(cx.elt("EmbedFence", cx.lineStart, to));
        while (cx.lineStart + line.text.length < to) cx.nextLine();
        cx.nextLine();
        return true;
      },
      endLeaf: (cx) => fenceAt(cx) !== undefined,
    },
  ],
};
