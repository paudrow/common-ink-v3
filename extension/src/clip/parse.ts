import type { Capture, ClipMode, HtmlTree } from "./types.ts";

const MODES = new Set<ClipMode>(["page", "selection", "link", "image", "element"]);
const MAX_NODES = 8_000;
const MAX_DEPTH = 40;
const MAX_TEXT = 200_000;

export class CaptureError extends Error {
  readonly name = "CaptureError";
  constructor(message: string) {
    super(message);
  }
}

export function parseCapture(value: unknown): Capture {
  const nodes = { n: 0 };
  if (!isRecord(value)) throw new CaptureError("The clip was empty.");
  const mode = value.mode;
  if (typeof mode !== "string" || !MODES.has(mode as ClipMode)) throw new CaptureError("The clip was empty.");
  const title = typeof value.title === "string" ? value.title.slice(0, 300) : "";
  const source = value.source;
  if (!isRecord(source) || typeof source.pageUrl !== "string" || typeof source.clippedOn !== "string") throw new CaptureError("The clip was empty.");
  const tree = parseTree(value.tree, 0, nodes);
  return {
    mode: mode as ClipMode,
    title,
    source: {
      pageTitle: typeof source.pageTitle === "string" ? source.pageTitle.slice(0, 300) : "",
      pageUrl: source.pageUrl.slice(0, 2_000),
      clippedOn: /^\d{4}-\d{2}-\d{2}$/.test(source.clippedOn) ? source.clippedOn : localDay(new Date()),
    },
    tree,
  };
}

function parseTree(value: unknown, depth: number, nodes: { n: number }): HtmlTree {
  if (nodes.n++ > MAX_NODES) throw new CaptureError("This page is too large to clip.");
  if (depth > MAX_DEPTH) throw new CaptureError("This page is too large to clip.");
  if (!isRecord(value) || typeof value.tag !== "string") throw new CaptureError("The clip was empty.");
  const attrs: Record<string, string> = {};
  if (isRecord(value.attrs)) {
    for (const [key, item] of Object.entries(value.attrs)) {
      if (typeof item === "string" && key.length < 40) attrs[key] = item.slice(0, 8_000);
    }
  }
  const children: HtmlTree[] = [];
  if (Array.isArray(value.children)) {
    for (const child of value.children) children.push(parseTree(child, depth + 1, nodes));
  }
  const text = typeof value.text === "string" ? value.text.slice(0, MAX_TEXT) : "";
  return { tag: value.tag.slice(0, 40).toLowerCase(), attrs, children, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
