import type { Block, Capture, Clip, ClipImage, HtmlTree, ImageMissReason, Inline, ListItem } from "./types.ts";

const DROP = new Set(["script", "style", "noscript", "template", "iframe", "canvas", "form", "button", "svg", "head", "meta", "link", "object", "embed", "input"]);
const UNWRAP = new Set(["div", "section", "article", "main", "body", "header", "footer", "nav", "aside", "span", "font", "center", "html", "#fragment"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "pre", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "hr", "address", "form"]);

export const INLINE_IMAGE_CAP = 1_000_000;
export const INLINE_CLIP_CAP = 4_000_000;

interface Counter {
  n: number;
  inline: number;
}

export function clipFromTree(capture: Capture): Clip {
  return { mode: capture.mode, title: capture.title, source: capture.source, blocks: readTree(capture.tree) };
}

export function readTree(root: HtmlTree): Block[] {
  return blocksFrom(root, { n: 0, inline: 0 });
}

function blocksFrom(node: HtmlTree, images: Counter): Block[] {
  if (node.tag === "#text") {
    const text = keepEdgeSpace(node.text);
    return text.trim() ? [{ type: "paragraph", inlines: [{ type: "text", text: text.trim() }] }] : [];
  }
  if (DROP.has(node.tag)) return [];
  if (node.tag === "hr") return [{ type: "rule" }];
  if (node.tag === "img") {
    const image = blockImage(node, images);
    return image ? [{ type: "image", image }] : [];
  }
  if (/^h[1-6]$/.test(node.tag)) {
    const level = Number(node.tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    const inlines = trimInlines(inlinesFrom(node));
    return inlines.length ? [{ type: "heading", level, inlines }] : [];
  }
  if (node.tag === "p" || node.tag === "figcaption" || node.tag === "address") return paragraphBlocks(node, images);
  if (node.tag === "pre") return [codeBlock(node)];
  if (node.tag === "blockquote") {
    const blocks = childrenBlocks(node, images);
    return blocks.length ? [{ type: "quote", blocks }] : [];
  }
  if (node.tag === "ul" || node.tag === "ol") return [listFrom(node, images)];
  if (node.tag === "table") {
    const rows = tableRows(node);
    return rows.length ? [{ type: "table", rows }] : [];
  }
  if (node.tag === "figure") return childrenBlocks(node, images);
  if (node.tag === "li") return itemBlocks(node, images);
  if (UNWRAP.has(node.tag) || !BLOCK.has(node.tag)) {
    return childrenArePhrasing(node) ? paragraphBlocks(node, images) : childrenBlocks(node, images);
  }
  return childrenBlocks(node, images);
}

function childrenBlocks(node: HtmlTree, images: Counter): Block[] {
  return node.children.flatMap((child) => blocksFrom(child, images));
}

function childrenArePhrasing(node: HtmlTree): boolean {
  return node.children.every((child) => child.tag === "#text" || (!BLOCK.has(child.tag) && !DROP.has(child.tag) && child.tag !== "div" && childrenArePhrasing(child)));
}

function paragraphBlocks(node: HtmlTree, images: Counter): Block[] {
  const parts = splitPhrasing(node, images, false);
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.kind === "image") blocks.push({ type: "image", image: part.image });
    else {
      const inlines = trimInlines(part.inlines);
      if (inlines.length) blocks.push({ type: "paragraph", inlines });
    }
  }
  return blocks;
}

type Part = { kind: "inlines"; inlines: Inline[] } | { kind: "image"; image: ClipImage };

function splitPhrasing(node: HtmlTree, images: Counter, inAnchor: boolean): Part[] {
  const parts: Part[] = [];
  let current: Inline[] = [];
  const flush = () => {
    if (current.length) parts.push({ kind: "inlines", inlines: current });
    current = [];
  };
  const pushInline = (inline: Inline | null) => {
    if (inline) current.push(inline);
  };
  const visit = (n: HtmlTree, anchor: boolean) => {
    if (n.tag === "#text") {
      pushInline(textInline(n.text));
      return;
    }
    if (DROP.has(n.tag) || n.tag === "br") {
      if (n.tag === "br") pushInline({ type: "text", text: " " });
      return;
    }
    if (n.tag === "img") {
      if (anchor) {
        pushInline(imageLink(n));
        return;
      }
      const image = blockImage(n, images);
      if (!image) return;
      flush();
      parts.push({ kind: "image", image });
      return;
    }
    if (n.tag === "a") {
      const href = n.attrs.href;
      const nested = splitPhrasing(n, images, true);
      const inlines = trimInlines(nested.flatMap((part) => (part.kind === "inlines" ? part.inlines : [])));
      if (!href) {
        for (const inline of inlines) pushInline(inline.type === "link" ? { type: "text", text: plain(inline.inlines) } : inline);
        return;
      }
      const label = trimInlines(inlines.map((inline) => (inline.type === "link" ? { type: "text" as const, text: plain(inline.inlines) } : inline)));
      pushInline(label.length ? { type: "link", href, inlines: label } : null);
      return;
    }
    if (n.tag === "strong" || n.tag === "b" || n.tag === "em" || n.tag === "i" || n.tag === "s" || n.tag === "strike" || n.tag === "del" || n.tag === "code") {
      const nested = splitPhrasing(n, images, anchor);
      for (const part of nested) {
        if (part.kind === "image") {
          flush();
          parts.push(part);
          continue;
        }
        for (const inline of wrap(n.tag, part.inlines)) pushInline(inline);
      }
      return;
    }
    for (const child of n.children) visit(child, anchor);
  };
  for (const child of node.children) visit(child, inAnchor);
  flush();
  return parts;
}

function wrap(tag: string, inlines: Inline[]): Inline[] {
  const trimmed = inlines;
  if (!trimmed.length) return [];
  if (tag === "strong" || tag === "b") return [{ type: "strong", inlines: trimmed }];
  if (tag === "em" || tag === "i") return [{ type: "em", inlines: trimmed }];
  if (tag === "s" || tag === "strike" || tag === "del") return [{ type: "strike", inlines: trimmed }];
  if (tag === "code") {
    const text = plain(trimmed);
    return text ? [{ type: "code", text }] : [];
  }
  return trimmed;
}

function inlinesFrom(node: HtmlTree): Inline[] {
  const parts = splitPhrasing(node, { n: 0, inline: 0 }, true);
  return parts.flatMap((part) => (part.kind === "inlines" ? part.inlines : []));
}

function imageLink(node: HtmlTree): Inline | null {
  const alt = node.attrs.alt?.trim() || "image";
  const src = node.attrs.src;
  if (!src) return { type: "text", text: alt };
  return { type: "link", href: src, inlines: [{ type: "text", text: alt }] };
}

function blockImage(node: HtmlTree, images: Counter): ClipImage | null {
  const alt = node.attrs.alt ?? "";
  const width = positive(node.attrs.width);
  const height = positive(node.attrs.height);
  const key = `i${++images.n}`;
  const skip = node.attrs["data-clip-skip"] as ImageMissReason | undefined;
  if (skip) return { key, alt, width, height, source: { kind: "skip", reason: skip } };
  const src = node.attrs.src ?? "";
  if (!src) return { key, alt, width, height, source: { kind: "skip", reason: "unreadable" } };
  if (src.startsWith("data:")) {
    const parsed = dataImage(src);
    if (!parsed) return { key, alt, width, height, source: { kind: "skip", reason: "unreadable" } };
    const bytes = Math.floor((parsed.base64.length * 3) / 4);
    if (bytes > INLINE_IMAGE_CAP || images.inline + bytes > INLINE_CLIP_CAP) {
      return { key, alt, width, height, source: { kind: "skip", reason: "inline-too-big" } };
    }
    images.inline += bytes;
    return { key, alt, width, height, source: { kind: "inline", mediaType: parsed.mediaType, base64: parsed.base64 } };
  }
  if (!/^https?:\/\//i.test(src)) return { key, alt, width, height, source: { kind: "skip", reason: "unsafe" } };
  return { key, alt, width, height, source: { kind: "remote", url: src } };
}

function dataImage(src: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!match) return null;
  return { mediaType: match[1]!, base64: match[2]!.replace(/\s+/g, "") };
}

function codeBlock(node: HtmlTree): Block {
  const code = node.children.find((child) => child.tag === "code") ?? node;
  const lang = language(code.attrs.class ?? node.attrs.class ?? "");
  return { type: "code", lang, text: rawText(code).replace(/\n$/, "") };
}

function language(className: string): string | null {
  return /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(className)?.[1] ?? null;
}

function rawText(node: HtmlTree): string {
  if (node.tag === "#text") return node.text;
  return node.children.map(rawText).join("");
}

function listFrom(node: HtmlTree, images: Counter): Block {
  const ordered = node.tag === "ol";
  const start = positive(node.attrs.start) ?? 1;
  const items = node.children.filter((child) => child.tag === "li").map((li) => listItem(li, images));
  return { type: "list", ordered, start, items };
}

function listItem(li: HtmlTree, images: Counter): ListItem {
  return { checked: null, blocks: itemBlocks(li, images) };
}

function itemBlocks(node: HtmlTree, images: Counter): Block[] {
  return childrenArePhrasing(node) ? paragraphBlocks(node, images) : childrenBlocks(node, images);
}

function tableRows(table: HtmlTree): (readonly (readonly Inline[])[])[] {
  const rows: HtmlTree[] = [];
  const walk = (node: HtmlTree, top: boolean) => {
    for (const child of node.children) {
      if (child.tag === "tr") rows.push(child);
      else if (child.tag !== "table" || top) walk(child, false);
    }
  };
  walk(table, true);
  return rows.map((row) => row.children.filter((cell) => cell.tag === "td" || cell.tag === "th").map((cell) => trimInlines(inlinesFrom(cell))));
}

function textInline(text: string): Inline | null {
  const collapsed = keepEdgeSpace(text);
  return collapsed ? { type: "text", text: collapsed } : null;
}

function keepEdgeSpace(text: string): string {
  if (!text) return "";
  const lead = /^\s/.test(text);
  const trail = /\s$/.test(text);
  const core = text.replace(/\s+/g, " ").trim();
  if (!core) return lead || trail ? " " : "";
  return `${lead ? " " : ""}${core}${trail ? " " : ""}`;
}

function trimInlines(inlines: readonly Inline[]): Inline[] {
  const copy = inlines.map((inline) => ({ ...inline })) as Inline[];
  const trimEnd = (inline: Inline, side: "lead" | "trail"): Inline => {
    if (inline.type !== "text") return inline;
    const text = side === "lead" ? inline.text.replace(/^\s+/, "") : inline.text.replace(/\s+$/, "");
    return { type: "text", text };
  };
  while (copy.length && copy[0]?.type === "text" && !copy[0].text.trim()) copy.shift();
  while (copy.length) {
    const last = copy.at(-1);
    if (last?.type !== "text" || last.text.trim()) break;
    copy.pop();
  }
  if (copy[0]) copy[0] = trimEnd(copy[0], "lead");
  if (copy.at(-1)) copy[copy.length - 1] = trimEnd(copy.at(-1)!, "trail");
  return copy.filter((inline) => inline.type !== "text" || inline.text.length > 0);
}

function plain(inlines: readonly Inline[]): string {
  return inlines.map((inline) => (inline.type === "text" || inline.type === "code" ? inline.text : plain(inline.type === "link" ? inline.inlines : inline.inlines))).join("");
}

function positive(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
