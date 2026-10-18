import { Readability } from "@mozilla/readability";
import { tweetFromOembed, tweetTarget, type Tweet } from "./tweet.ts";
import { watchTarget } from "./video.ts";

export interface Extracted {
  title: string;
  html: string;
}

const JUNK = [
  "body > header",
  "body > nav",
  "body > footer",
  "body > aside",
  "nav",
  "footer",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='complementary']",
  "script",
  "style",
  "noscript",
  "iframe",
  "form",
  "#comments",
  ".comments",
  "#respond",
  ".newsletter",
  ".cookie-banner",
  ".cookie-notice",
  ".cookie-consent",
  "#onetrust-banner-sdk",
  "#onetrust-consent-sdk",
  ".related",
  ".related-articles",
  ".related-posts",
  ".sidebar",
  "#sidebar",
  ".advertisement",
  ".ad-slot",
  ".ad-container",
  ".ads",
  "[data-ad]",
  ".taboola",
  ".outbrain",
  "[data-concert-ads-name]",
  "[class*='dfp_ad']",
  "[class*='dfp-ad']",
  ".m-ad",
  ".share-buttons",
  ".social-share",
  ".baseline-indicator",
  ".article-footer",
  ".ambox",
  ".tmbox",
  ".ombox",
  ".mbox-small",
  ".mw-editsection",
  ".navbox",
  ".reflist",
  ".hatnote",
  ".side-box",
  ".sistersitebox",
  ".skip-link",
  ".skip-to-content",
  "a[href='#content']",
  "a[href='#main-content']",
  "#toc",
  ".vector-toc",
  "#catlinks",
].join(",");

export function extractArticle(doc: Document, pageUrl: string): Extracted | null {
  const special = specialArticle(doc, pageUrl);
  if (special) return special;
  // Readability rewrites the document it is given, so it runs on a clone.
  const clone = doc.cloneNode(true);
  const titled = doc.title?.replace(/\s+/g, " ").trim() || "";
  if (clone.nodeType !== 9) return fallbackArticle(doc, titled);
  const copy = clone as Document;
  stripJunk(copy);
  if (!copy.documentElement) return fallbackArticle(doc, titled);
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(copy).parse();
  } catch {
    return fallbackArticle(doc, titled);
  }
  const html = dropShoutedLinks(article?.content?.trim() ?? "");
  const title = article?.title?.replace(/\s+/g, " ").trim() || doc.title?.replace(/\s+/g, " ").trim() || "";
  if (html && !chromeOnly(html)) return { title, html };
  return fallbackArticle(doc, title);
}

function specialArticle(doc: Document, pageUrl: string): Extracted | null {
  return tweetArticle(doc, pageUrl) ?? youtubeArticle(doc, pageUrl) ?? githubArticle(doc, pageUrl) ?? wikipediaArticle(doc, pageUrl) ?? redditArticle(doc, pageUrl) ?? recipeArticle(doc);
}

function tweetArticle(doc: Document, pageUrl: string): Extracted | null {
  const quote = doc.querySelector("blockquote.twitter-tweet");
  const target = tweetTarget(pageUrl) ?? tweetTarget(canonical(doc) ?? "");
  if (quote) {
    const tweet = tweetFromOembed(quote.outerHTML, target?.permalink ?? pageUrl);
    if (tweet) return htmlTweet(tweet);
  }
  if (!target) return null;
  const text = meta(doc, "og:description") || meta(doc, "description");
  if (!text || /log in to x|sign up/i.test(text)) return null;
  const title = meta(doc, "og:title") ?? "";
  const named = /^(.*?)\s+\(@([A-Za-z0-9_]{1,15})\)/.exec(title);
  return htmlTweet({
    author: named?.[1]?.trim() || target.handle,
    handle: named?.[2] || target.handle,
    text,
    date: posted(doc, target.id),
    permalink: target.permalink,
    images: ogImages(doc),
  });
}

function htmlTweet(tweet: Tweet): Extracted {
  const permalink = `<a href="${escapeAttr(tweet.permalink)}">${escapeText(tweet.permalink)}</a>`;
  const dated = tweet.date ? `<p>${escapeText(tweet.date)}</p>` : "";
  const permalinkHtml = `<p>${permalink}</p>`;
  const images = tweet.images.map((url) => `<p><img src="${escapeAttr(url)}" alt=""></p>`).join("");
  return {
    title: tweet.text.slice(0, 80),
    html: `<p><strong>${escapeText(tweet.author)}</strong> (@${escapeText(tweet.handle)})</p><p>${escapeText(tweet.text)}</p>${dated}${permalinkHtml}${images}`,
  };
}

/** The post's own time, from the status link X shows it on, or the published time when that link isn't in the page. */
function posted(doc: Document, id: string): string | null {
  for (const anchor of doc.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!href.includes(`/status/${id}`)) continue;
    const text = anchor.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (text && text.length < 80 && /\d/.test(text)) return text;
  }
  return writtenDate(meta(doc, "article:published_time"));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function writtenDate(iso: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : null;
}

function youtubeArticle(doc: Document, pageUrl: string): Extracted | null {
  const watch = watchTarget(pageUrl) ?? watchTarget(canonical(doc) ?? "");
  if (!watch) return null;
  const title = (meta(doc, "og:title") || doc.title || "").replace(/\s+-\s+YouTube$/, "").trim();
  if (!title || title === "YouTube") return null;
  const channel = meta(doc, "author") || ownerName(doc) || channelFromDom(doc) || "";
  const description = meta(doc, "og:description") || meta(doc, "description") || "";
  const channelHtml = channel ? `<p>${escapeText(channel)}</p>` : "";
  const about = description && description !== title && !/enjoy the videos and music you love/i.test(description) ? `<p>${escapeText(description)}</p>` : "";
  return { title, html: `<h1>${escapeText(title)}</h1>${channelHtml}${about}<p><a href="${escapeAttr(watch)}">${escapeText(watch)}</a></p>` };
}

function githubArticle(doc: Document, pageUrl: string): Extracted | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.hostname.replace(/^www\./, "") !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[2];
  if (parts.length < 2 || (kind && kind !== "blob" && kind !== "tree")) return null;
  const readme = doc.querySelector("#readme .markdown-body, article.markdown-body");
  if (!readme) return null;
  const heading = readme.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
  const title = heading || meta(doc, "og:title") || doc.title || "README";
  return { title, html: readme.innerHTML };
}

function wikipediaArticle(doc: Document, pageUrl: string): Extracted | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith("wikipedia.org") || !url.pathname.startsWith("/wiki/")) return null;
  const root = doc.querySelector("#mw-content-text .mw-parser-output");
  if (!root) return null;
  const copy = root.cloneNode(true) as Element;
  for (const node of [...copy.querySelectorAll(".mw-editsection, .navbox, .reflist, .hatnote, .side-box, .sistersitebox, .mw-empty-elt, #toc, .vector-toc, table.infobox, .shortdescription, sup.reference, .ambox, .tmbox, .ombox, .mbox-small")]) node.remove();
  const title = doc.querySelector("#firstHeading")?.textContent?.replace(/\s+/g, " ").trim() || doc.title.replace(/ - Wikipedia$/, "").trim();
  return { title, html: `<h1>${escapeText(title)}</h1>${copy.innerHTML}` };
}

function redditArticle(doc: Document, pageUrl: string): Extracted | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|old|np)\./, "");
  if (host !== "reddit.com") return null;
  const shreddit = doc.querySelector("shreddit-post");
  if (shreddit) {
    const title = shreddit.getAttribute("post-title")?.trim() || doc.title;
    const body = shreddit.querySelector("[slot='text-body']")?.innerHTML ?? "";
    const author = shreddit.getAttribute("author") ?? "";
    const by = author ? `<p>u/${escapeText(author)}</p>` : "";
    return { title, html: `<h1>${escapeText(title)}</h1>${by}${body}` };
  }
  const title = doc.querySelector("a.title")?.textContent?.replace(/\s+/g, " ").trim();
  const body = doc.querySelector(".expando .usertext-body")?.innerHTML;
  if (!title && !body) return null;
  const heading = title || doc.title;
  return { title: heading, html: `<h1>${escapeText(heading)}</h1>${body ?? ""}` };
}

function recipeArticle(doc: Document): Extracted | null {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const recipe = findRecipe(data);
    if (!recipe?.name) continue;
    const ingredients = strings(recipe.recipeIngredient);
    const steps = stepsOf(recipe.recipeInstructions);
    if (!ingredients.length && !steps.length) continue;
    const description = typeof recipe.description === "string" ? `<p>${escapeText(recipe.description)}</p>` : "";
    const list = ingredients.length ? `<h2>Ingredients</h2><ul>${ingredients.map((item) => `<li>${escapeText(item)}</li>`).join("")}</ul>` : "";
    const method = steps.length ? `<h2>Instructions</h2><ol>${steps.map((item) => `<li>${escapeText(item)}</li>`).join("")}</ol>` : "";
    return { title: recipe.name, html: `<h1>${escapeText(recipe.name)}</h1>${description}${list}${method}` };
  }
  return null;
}

function findRecipe(value: unknown): { name?: string; description?: string; recipeIngredient?: unknown; recipeInstructions?: unknown } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipe(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Recipe") && typeof record.name === "string") return record as { name: string; description?: string; recipeIngredient?: unknown; recipeInstructions?: unknown };
  if (Array.isArray(record["@graph"])) return findRecipe(record["@graph"]);
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stepsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const steps: string[] = [];
  for (const item of value) {
    if (typeof item === "string") steps.push(item);
    else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") steps.push((item as { text: string }).text);
  }
  return steps.map((step) => step.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function chromeOnly(html: string): boolean {
  const text = visibleText(html);
  return !text || /^(skip|jump) to (the )?(main |page )?content$/i.test(text);
}

function fallbackArticle(doc: Document, title: string): Extracted | null {
  const root = doc.querySelector("article, main, [role='main']");
  const html = root?.innerHTML.trim() ?? "";
  if (html && !chromeOnly(html) && visibleText(html).length >= 80) return { title, html };
  const description = meta(doc, "og:description") || meta(doc, "description");
  if (description && !chromeOnly(description) && description.length >= 40) return { title, html: `<p>${escapeText(description)}</p>` };
  return null;
}

function dropShoutedLinks(html: string): string {
  return html.replace(/<p\b[^>]*>\s*<a\b[^>]*>\s*(?:<(?:strong|b)>)?([^<]{20,})(?:<\/(?:strong|b)>)?\s*<\/a>\s*<\/p>/gi, (whole, text: string) => {
    const letters = text.replace(/[^A-Za-z]/g, "");
    return letters.length > 20 && letters === letters.toUpperCase() ? "" : whole;
  });
}

function stripJunk(doc: Document): void {
  for (const node of [...doc.querySelectorAll(JUNK)]) {
    if (node === doc.documentElement || node === doc.body) continue;
    node.remove();
  }
}

function canonical(doc: Document): string | null {
  return doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? meta(doc, "og:url");
}

function meta(doc: Document, name: string): string | null {
  const node = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
  const content = node?.getAttribute("content")?.replace(/\s+/g, " ").trim();
  return content || null;
}

function ogImages(doc: Document): string[] {
  for (const node of doc.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')) {
    const image = node.getAttribute("content")?.trim() ?? "";
    if (/^https?:\/\//.test(image) && !/profile_images|\/emoji\//.test(image)) return [image];
  }
  return [];
}

function channelFromDom(doc: Document): string | null {
  const owner = doc.querySelector("ytd-video-owner-renderer a[href^='/@'], #owner a[href^='/@']");
  const text = owner?.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text;
  const alt = doc.querySelector("ytd-video-owner-renderer [alt]")?.getAttribute("alt")?.trim();
  if (alt) return alt;
  const href = owner?.getAttribute("href") ?? "";
  return /^\/@([^/?]+)/.exec(href)?.[1] ?? null;
}

function ownerName(doc: Document): string | null {
  const match = /"ownerChannelName":"((?:\\.|[^"\\])*)"/.exec(doc.documentElement?.innerHTML ?? "");
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}
