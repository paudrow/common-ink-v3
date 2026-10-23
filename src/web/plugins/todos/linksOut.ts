import { noteParser } from "../lib/markdownSpaces.ts";
import { opens } from "../lib/opening.ts";

/** A link out of the app in a todo's words: where it is written, the words it shows, and the address it opens. */
export interface LinkOut {
  from: number;
  to: number;
  text: string;
  url: string;
}

/**
 * The links out in a todo's words, read by the parse a note's editor draws them with, so a todo
 * shows as a link what its note does: `[words](address)`, `<address>`, and an address written bare.
 * One to an address that can't be opened, as the editor leaves it, is left out.
 */
export function linksOut(words: string): LinkOut[] {
  if (!/:\/\/|mailto:/i.test(words)) return [];
  const found: LinkOut[] = [];
  noteParser.parse(words).iterate({
    enter(node) {
      if (node.name === "InlineCode" || node.name === "Image") return false;
      const link = node.name === "Link" || node.name === "Autolink";
      if (!link && !(node.name === "URL" && !["Link", "Autolink", "Image", "LinkReference"].includes(node.node.parent?.name ?? ""))) return;
      const url = link ? node.node.getChild("URL") : node.node;
      const marks = node.node.getChildren("LinkMark");
      if (!url || (link && marks.length < 2)) return false;
      const address = words.slice(url.from, url.to);
      const text = node.name === "Link" ? words.slice(marks[0]!.to, marks[1]!.from) : address;
      if (opens(address) && text) found.push({ from: node.from, to: node.to, text, url: address });
      return false;
    },
  });
  return found;
}
