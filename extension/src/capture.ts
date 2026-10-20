import { articleFromDocument } from "./clip/article.ts";
import { watchTarget } from "./clip/video.ts";
import { domTree, liveImages, type DomNode } from "./clip/dom.ts";
import { INLINE_CLIP_CAP, INLINE_IMAGE_CAP } from "./clip/tree.ts";
import type { Capture, ClipMode, ClipSource } from "./clip/types.ts";
import { CaptureError } from "./clip/parse.ts";

export interface CaptureHit {
  mode: ClipMode;
  target: Element | null;
  now: Date;
}

export async function captureDocument(doc: Document, hit: CaptureHit): Promise<Capture> {
  const source: ClipSource = {
    pageTitle: doc.title?.replace(/\s+/g, " ").trim() || doc.URL,
    pageUrl: doc.URL,
    clippedOn: localDay(hit.now),
  };
  const base = doc.baseURI || doc.URL;
  if (hit.mode === "page") {
    const article = articleFromDocument(doc) ?? (watchTarget(doc.URL) ? { title: "Video", html: "<p>Video</p>" } : null);
    if (!article) throw new CaptureError("This page has no article. Select text, or clip an element.");
    const parsed = new DOMParser().parseFromString(article.html, "text/html");
    await inlineBlobs(parsed.body);
    return { mode: "page", title: article.title || source.pageTitle, source, tree: domTree(parsed.body, { baseUrl: base, images: liveImages(doc) }) };
  }
  if (hit.mode === "selection") {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) throw new CaptureError("Select some text first.");
    const holder = doc.createElement("div");
    holder.appendChild(selection.getRangeAt(0).cloneContents());
    await inlineBlobs(holder);
    const title = selection.toString().replace(/\s+/g, " ").trim().slice(0, 80) || source.pageTitle;
    return { mode: "selection", title, source, tree: domTree(holder, { baseUrl: base, images: liveImages(doc) }) };
  }
  if (hit.mode === "link") {
    const anchor = hit.target?.closest("a");
    if (!anchor) throw new CaptureError("No link here.");
    const title = anchor.textContent?.replace(/\s+/g, " ").trim() || source.pageTitle;
    return { mode: "link", title, source, tree: domTree(anchor as unknown as DomNode, { baseUrl: base, images: new Map() }) };
  }
  if (hit.mode === "image") {
    const image = hit.target instanceof HTMLImageElement ? hit.target : hit.target?.closest("img");
    if (!image) throw new CaptureError("No image here.");
    await inlineBlobs(image);
    return { mode: "image", title: image.alt?.trim() || source.pageTitle, source, tree: domTree(image as unknown as DomNode, { baseUrl: base, images: liveImages(doc) }) };
  }
  const target = hit.target;
  if (!target || !target.isConnected) throw new CaptureError("No element here.");
  const tag = target.tagName.toLowerCase();
  if (tag === "html" || tag === "body") throw new CaptureError("Clip the page instead.");
  await inlineBlobs(target);
  const title = target.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) || source.pageTitle;
  return { mode: "element", title, source, tree: domTree(target as unknown as DomNode, { baseUrl: base, images: liveImages(doc) }) };
}

function imagesIn(root: Element): HTMLImageElement[] {
  const nested = [...root.querySelectorAll("img")];
  return root instanceof HTMLImageElement ? [root, ...nested] : nested;
}

async function inlineBlobs(root: Element): Promise<void> {
  let used = 0;
  for (const img of imagesIn(root)) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    if (!src.startsWith("blob:")) continue;
    try {
      const response = await fetch(src);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > INLINE_IMAGE_CAP || used + bytes.byteLength > INLINE_CLIP_CAP) {
        img.setAttribute("data-clip-skip", "inline-too-big");
        img.removeAttribute("src");
        continue;
      }
      used += bytes.byteLength;
      const type = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      img.setAttribute("src", `data:${type};base64,${toBase64(bytes)}`);
    } catch {
      img.setAttribute("data-clip-skip", "unreadable");
      img.removeAttribute("src");
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
