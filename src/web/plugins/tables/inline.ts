import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";
import type { DrawMath } from "../lib/drawnMath.ts";
import { opens } from "../lib/opening.ts";
import { formulasIn, type Formula } from "../math/syntax.ts";

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

/** Makes `el` a link out to `href`, as a note draws one, when it is an address that may be opened. */
function linkOut(el: HTMLElement, href: string) {
  el.className = "md-link";
  if (!opens(href)) return;
  el.dataset.href = href;
  el.title = `${href}\nClick to open`;
}

/** Puts `text` from `from` to `to` into `parent`, each formula wholly in that stretch drawn. */
type Put = (parent: ParentNode, from: number, to: number) => void;

function drawInto(parent: ParentNode, text: string, from: number, to: number, children: readonly Element[], put: Put, inLink = false) {
  let at = from;
  for (const child of children) {
    put(parent, at, child.from);
    at = child.to;
    const name = nameOf(child);
    const url = name === "URL" ? child : name === "Link" || name === "Autolink" ? child.children?.find((c) => nameOf(c) === "URL") : undefined;
    const address = url && text.slice(url.from, url.to);
    // An address written bare, or in <>, is its own words.
    if (!inLink && (name === "URL" || name === "Autolink") && address) {
      const el = document.createElement("span");
      linkOut(el, address);
      el.append(address);
      parent.append(el);
    } else if (LEFT_OUT.has(name)) continue;
    else if (name === "Escape") parent.append(text.slice(child.from + 1, child.to));
    else if (TAGS[name]) {
      const el = document.createElement(TAGS[name]);
      if (name === "Link") linkOut(el, address ?? "");
      drawInto(el, text, child.from, child.to, child.children ?? [], put, inLink || name === "Link");
      parent.append(el);
    } else put(parent, child.from, child.to);
  }
  put(parent, at, to);
}

const codeIn = (elements: readonly Element[]): Element[] => elements.flatMap((el) => (nameOf(el) === "InlineCode" ? [el] : codeIn(el.children ?? [])));

/**
 * One line of markdown drawn as elements: emphasis, strikethrough, code, a link's words, and with
 * `math` its formulas. It is built from text nodes only, so nothing a note says is read as HTML.
 */
export function inlineMarkdown(text: string, math?: DrawMath | null): DocumentFragment {
  const code = math ? codeIn(parser.parseInline(text, 0)) : [];
  const formulas = math ? formulasIn(text).filter((f) => !code.some((c) => c.from < f.to && f.from < c.to)) : [];
  // What a formula says is not markdown: it is read as letters, so a `*` in it starts no emphasis.
  let read = text;
  for (const f of formulas) read = read.slice(0, f.from) + "x".repeat(f.to - f.from) + read.slice(f.to);
  const put: Put = (parent, from, to) => {
    let at = from;
    for (const f of formulas.filter((f) => f.from >= from && f.to <= to)) {
      parent.append(text.slice(at, f.from), drawnFormula(f, text.slice(f.from, f.to), math!));
      at = f.to;
    }
    parent.append(text.slice(at, to));
  };
  const drawn = document.createDocumentFragment();
  drawInto(drawn, text, 0, text.length, parser.parseInline(read, 0), put);
  return drawn;
}

function drawnFormula(formula: Formula, written: string, math: DrawMath): HTMLElement {
  const el = document.createElement("span");
  try {
    math(el, formula);
  } catch {
    el.replaceChildren(written);
  }
  return el;
}
