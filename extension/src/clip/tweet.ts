import type { Block, Clip, Inline } from "./types.ts";

export interface TweetTarget {
  handle: string;
  id: string;
  permalink: string;
}

export interface Tweet {
  author: string;
  handle: string;
  text: string;
  date: string | null;
  permalink: string;
  images: readonly string[];
}

export function tweetTarget(value: string): TweetTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|mobile)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/.exec(url.pathname);
  if (!match) return null;
  return { handle: match[1]!, id: match[2]!, permalink: `https://x.com/${match[1]}/status/${match[2]}` };
}

export function tweetFromOembed(html: string, permalink: string): Tweet | null {
  const target = tweetTarget(permalink);
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!paragraph || !target) return null;
  const text = plainHtml(paragraph[1] ?? "");
  if (!text) return null;
  const byline = /(?:&mdash;|—)\s*([^<(\n]+?)\s*\(@([A-Za-z0-9_]{1,15})\)/i.exec(html);
  const dated = /<a\b[^>]*href="[^"]*\/status\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const images = [...html.matchAll(/<img\b[^>]*src="(https?:\/\/[^"]+)"/gi)].map((match) => match[1]!).filter((src) => !/profile_images|emoji/.test(src));
  return {
    author: (byline?.[1] ?? target.handle).replace(/\s+/g, " ").trim(),
    handle: byline?.[2] ?? target.handle,
    text,
    date: dated ? plainHtml(dated[1] ?? "") || null : null,
    permalink: target.permalink,
    images,
  };
}

export function tweetBlocks(tweet: Tweet): Block[] {
  const blocks: Block[] = [
    { type: "paragraph", inlines: [strong(tweet.author), { type: "text", text: ` (@${tweet.handle})` }] },
    { type: "paragraph", inlines: [{ type: "text", text: tweet.text }] },
  ];
  if (tweet.date) blocks.push({ type: "paragraph", inlines: [{ type: "text", text: tweet.date }] });
  blocks.push({ type: "paragraph", inlines: [link(tweet.permalink, tweet.permalink)] });
  tweet.images.forEach((url, index) => {
    blocks.push({
      type: "image",
      image: { key: `t${index + 1}`, alt: "", width: null, height: null, source: { kind: "remote", url } },
    });
  });
  return blocks;
}

export function clipWithTweet(clip: Clip, tweet: Tweet): Clip {
  const title = tweet.text.replace(/\s+/g, " ").trim().slice(0, 80) || clip.title;
  return { ...clip, title, blocks: tweetBlocks(tweet) };
}

export async function fetchOembed(permalink: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(permalink)}`, { credentials: "omit", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { html?: unknown };
    return typeof body.html === "string" ? body.html : null;
  } catch {
    return null;
  }
}

function strong(text: string): Inline {
  return { type: "strong", inlines: [{ type: "text", text }] };
}

function link(href: string, text: string): Inline {
  return { type: "link", href, inlines: [{ type: "text", text }] };
}

function plainHtml(html: string): string {
  const withLinks = html.replace(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ");
  const text = withLinks.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return decode(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
