import type { Block, Clip, Inline } from "./types.ts";

const GENERIC = /enjoy the videos and music you love/i;

export function watchTarget(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be" && url.pathname.length > 1) return `https://www.youtube.com/watch?v=${url.pathname.slice(1).split("/")[0]}`;
  if (host === "youtube.com" && url.pathname === "/watch" && url.searchParams.get("v")) return `https://www.youtube.com/watch?v=${url.searchParams.get("v")}`;
  return null;
}

export function thinVideo(title: string, text: string): boolean {
  const name = title.replace(/\s+/g, " ").trim();
  return !name || name === "Video" || name === "YouTube" || GENERIC.test(text) || GENERIC.test(name);
}

export interface WatchCard {
  title: string;
  author: string;
}

export function clipWithVideo(clip: Clip, card: WatchCard, watch: string): Clip {
  const blocks: Block[] = [];
  if (card.author) blocks.push(paragraph([{ type: "text", text: card.author }]));
  blocks.push(...descriptionOf(clip, watch));
  blocks.push(paragraph([{ type: "link", href: watch, inlines: [{ type: "text", text: watch }] }]));
  return { ...clip, title: card.title || clip.title, blocks };
}

function descriptionOf(clip: Clip, watch: string): Block[] {
  return clip.blocks.filter((block) => {
    if (block.type !== "paragraph") return false;
    const text = paragraphText(block);
    if (!text || text === watch || text === clip.source.pageUrl) return false;
    if (GENERIC.test(text) || text === "Video" || text === "YouTube") return false;
    return true;
  });
}

function paragraphText(block: Block): string {
  if (block.type !== "paragraph") return "";
  const parts: string[] = [];
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.type === "text" || inline.type === "code") parts.push(inline.text);
      else walk(inline.inlines);
    }
  };
  walk(block.inlines);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function fetchWatch(watch: string, fetchImpl: typeof fetch = fetch): Promise<WatchCard | null> {
  try {
    const response = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { credentials: "omit", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { title?: unknown; author_name?: unknown };
    if (typeof body.title !== "string" || !body.title.trim()) return null;
    return { title: body.title.replace(/\s+/g, " ").trim(), author: typeof body.author_name === "string" ? body.author_name.replace(/\s+/g, " ").trim() : "" };
  } catch {
    return null;
  }
}

function paragraph(inlines: Inline[]): Block {
  return { type: "paragraph", inlines };
}
