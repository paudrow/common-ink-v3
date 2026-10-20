import type { HtmlTree } from "./types.ts";

const TEXT = 3;
const ELEMENT = 1;
const FRAGMENT = 11;

export interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
  checked?: boolean;
}

export interface LiveImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface TreeContext {
  baseUrl: string;
  images: ReadonlyMap<string, LiveImage>;
}

export function absoluteUrl(base: string, href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) return null;
  if (/^data:/i.test(trimmed)) return /^data:image\//i.test(trimmed) ? trimmed : null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function liveImages(doc: Document): Map<string, LiveImage> {
  const map = new Map<string, LiveImage>();
  const base = doc.baseURI || doc.URL;
  for (const img of doc.querySelectorAll("img")) {
    const raw = img.getAttribute("src");
    if (!raw) continue;
    const key = absoluteUrl(base, raw);
    if (!key) continue;
    const current = img.currentSrc;
    const url = current && /^https?:/i.test(current) ? current : key;
    const width = img.naturalWidth > 0 ? img.naturalWidth : null;
    const height = img.naturalHeight > 0 ? img.naturalHeight : null;
    map.set(key, { url, width, height });
  }
  return map;
}

function attr(node: DomNode, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

function srcsetFirst(value: string): string | null {
  const candidate = value.split(",")[0]?.trim().split(/\s+/)[0];
  return candidate || null;
}

export function domTree(root: DomNode, ctx: TreeContext): HtmlTree {
  return walk(root, ctx) ?? { tag: "#fragment", attrs: {}, children: [], text: "" };
}

function walk(node: DomNode, ctx: TreeContext): HtmlTree | null {
  if (node.nodeType === TEXT) return { tag: "#text", attrs: {}, children: [], text: node.textContent ?? "" };
  if (node.nodeType !== ELEMENT && node.nodeType !== FRAGMENT) return null;

  const name = node.nodeName.toLowerCase();
  const tag = name === "#document-fragment" ? "#fragment" : name;
  const attrs: Record<string, string> = {};

  if (tag === "a") {
    const href = attr(node, "href");
    const abs = href ? absoluteUrl(ctx.baseUrl, href) : null;
    if (abs) attrs.href = abs;
  }

  if (tag === "img") {
    const raw = attr(node, "src") ?? "";
    const fromSrc = raw ? absoluteUrl(ctx.baseUrl, raw) : null;
    const live = fromSrc ? ctx.images.get(fromSrc) : undefined;
    const fallback = attr(node, "data-src") ?? (attr(node, "srcset") ? srcsetFirst(attr(node, "srcset") ?? "") : null);
    const resolved = live?.url ?? fromSrc ?? (fallback ? absoluteUrl(ctx.baseUrl, fallback) : null);
    if (resolved) attrs.src = resolved;
    const alt = attr(node, "alt");
    if (alt != null) attrs.alt = alt;
    const width = live?.width ?? positive(attr(node, "width"));
    const height = live?.height ?? positive(attr(node, "height"));
    if (width) attrs.width = String(width);
    if (height) attrs.height = String(height);
    const skip = attr(node, "data-clip-skip");
    if (skip) attrs["data-clip-skip"] = skip;
  }

  if (tag === "code" || tag === "pre") {
    const cls = attr(node, "class");
    if (cls) attrs.class = cls;
  }
  if (tag === "ol") {
    const start = attr(node, "start");
    if (start) attrs.start = start;
  }
  if (tag === "input") {
    const type = attr(node, "type");
    if (type) attrs.type = type;
    if (attr(node, "checked") != null || node.checked === true) attrs.checked = "";
  }

  const children: HtmlTree[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (!child) continue;
    const walked = walk(child, ctx);
    if (walked) children.push(walked);
  }
  return { tag, attrs, children, text: "" };
}

function positive(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
