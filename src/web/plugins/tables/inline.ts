import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";

interface Element {
  type: number;
  from: number;
  to: number;
  children?: readonly Element[];
}

const parser = markdownLanguage.parser as MarkdownParser;
const nameOf = (el: Element) => parser.nodeSet.types[el.type]!.name;

const TAGS: Record<string, string> = { Emphasis: "em", StrongEmphasis: "strong", InlineCode: "code", Strikethrough: "s", Link: "span" };
const LEFT_OUT = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "URL", "LinkTitle"]);

function drawInto(parent: ParentNode, text: string, from: number, to: number, children: readonly Element[]) {
  let at = from;
  for (const child of children) {
    parent.append(text.slice(at, child.from));
    at = child.to;
    const name = nameOf(child);
    if (LEFT_OUT.has(name)) continue;
    if (name === "Escape") parent.append(text.slice(child.from + 1, child.to));
    else if (TAGS[name]) {
      const el = document.createElement(TAGS[name]);
      if (name === "Link") el.className = "md-link";
      drawInto(el, text, child.from, child.to, child.children ?? []);
      parent.append(el);
    } else parent.append(text.slice(child.from, child.to));
  }
  parent.append(text.slice(at, to));
}

/**
 * One line of markdown drawn as elements: emphasis, strikethrough, code, and a link's words. It is
 * built from text nodes only, so nothing a note says is read as HTML.
 */
export function inlineMarkdown(text: string): DocumentFragment {
  const drawn = document.createDocumentFragment();
  drawInto(drawn, text, 0, text.length, parser.parseInline(text, 0));
  return drawn;
}
