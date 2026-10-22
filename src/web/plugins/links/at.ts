import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { isNoteId, linkedFolder, linksIn, linksOn, type WrittenLink } from "../../plugin-api.ts";
import { inCode } from "../lib/live.ts";
import { opens } from "../lib/opening.ts";

/** Whether a link's target is a note's id or a folder's: what the app follows, where any other is a title nobody resolved. */
const followable = (link: WrittenLink) => isNoteId(link.target) || linkedFolder(link.target) !== null;
const noteLinksIn = (text: string) => new Map(linksIn(text).filter(followable).map((link) => [link.from, link]));

/**
 * The note's links to notes and folders, by where each starts, read from the whole text by the
 * function the server records backlinks with. So what is drawn as a link is what is a link, where
 * the editor's own parse would say otherwise: in a deeply nested bullet, which is indented as far as
 * a code block is.
 */
export const noteLinks = StateField.define<ReadonlyMap<number, WrittenLink>>({
  create: (state) => noteLinksIn(state.doc.toString()),
  update: (links, tr) => (tr.docChanged ? noteLinksIn(tr.state.doc.toString()) : links),
});

/** What reads as a link to a note or a folder on one line. Whether it is one is `noteLinks`' to say. */
export const noteLinksOn = (line: string, offset: number): WrittenLink[] => linksOn(line, offset).filter(followable);

export type Followed = { note: string } | { page: string };

/** What following a link at `pos` goes to: a note, for a link to one, or a page, for an address that may be opened. */
export function linkAt(state: EditorState, pos: number): Followed | null {
  for (const link of state.field(noteLinks).values()) if (link.from <= pos && pos < link.to) return { note: link.target };
  if (inCode(state, pos)) return null;
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    const url = node.name === "URL" ? node : node.name === "Link" || node.name === "Autolink" ? node.getChild("URL") : null;
    if (!url) continue;
    const page = state.sliceDoc(url.from, url.to);
    return opens(page) ? { page } : null;
  }
  return null;
}
