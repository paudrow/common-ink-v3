import { parseHTML } from "linkedom";
import { articleFromDocument } from "./article.ts";
import { domTree } from "./dom.ts";
import { clipToMarkdown } from "./render.ts";
import { clipFromTree } from "./tree.ts";
import type { ClipSource, PlacedMap } from "./types.ts";

export interface HtmlClipOptions {
  baseUrl: string;
  title: string;
  source: ClipSource;
  placed?: PlacedMap;
}

export function pageToMarkdown(html: string, source: ClipSource, placed?: PlacedMap): string {
  const { document } = parseHTML(html);
  const article = articleFromDocument(document, source.pageUrl);
  return htmlToMarkdown(article?.html ?? html, {
    baseUrl: source.pageUrl,
    title: article?.title || source.pageTitle,
    source,
    placed,
  });
}

export function htmlToMarkdown(html: string, options: HtmlClipOptions): string {
  // A fragment has no body. linkedom then leaves document.body empty and parks the fragment on the document element.
  const wrapped = /<(?:html|body)[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
  const { document } = parseHTML(wrapped);
  const tree = domTree(document.body, { baseUrl: options.baseUrl, images: new Map() });
  const clip = clipFromTree({ mode: "page", title: options.title, source: options.source, tree });
  return clipToMarkdown(clip, options.title, options.placed ?? {});
}
