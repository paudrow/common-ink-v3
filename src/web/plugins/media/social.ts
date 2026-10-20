import type { Theme } from "../../plugin-api.ts";
import { addressIn, siteOf } from "./address.ts";

/**
 * A site whose posts can be shown: one that publishes a frame for a post whose address can be worked
 * out from the post's own, with nothing fetched, and that works shut in a sandbox. A site that only
 * offers a script to run in the page isn't here, since nothing of a third party runs in the app.
 */
interface Site {
  name: string;
  /** How tall a post is given until its frame says how tall it is, in pixels. */
  height: number;
  /** The origin its frames are served from, which is the only one a height is taken from. */
  origin: string;
  /** What names the post at `url` on this site, or null when `url` isn't one of its posts. */
  post(url: URL, site: string): string | null;
  /** The frame for that post, drawn in `theme`. */
  frame(post: string, theme: Theme): string;
  /** The height a message from the frame gives, if it is one that gives a height. */
  tall(message: unknown): unknown;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);

const SITES: readonly Site[] = [
  {
    name: "X",
    height: 360,
    origin: "https://platform.twitter.com",
    post: (url, site) => (["x.com", "twitter.com"].includes(site) ? (/^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,25})\/?$/.exec(url.pathname)?.[1] ?? null) : null),
    frame: (id, theme) => `https://platform.twitter.com/embed/Tweet.html?dnt=true&id=${id}&theme=${theme}`,
    tall(message) {
      const call = record(record(message)?.["twttr.embed"]);
      return call?.method === "twttr.private.resize" && Array.isArray(call.params) ? record(call.params[0])?.height : undefined;
    },
  },
  {
    name: "Bluesky",
    height: 360,
    origin: "https://embed.bsky.app",
    // Its frame takes the account's DID and not its handle, and finding one from the other would mean asking Bluesky. A did:web may hold a port as %3A; no other escape, so %2F can't reach another path.
    post(url, site) {
      const post = site === "bsky.app" ? /^\/profile\/(did:(?:plc|web):(?:[A-Za-z0-9.:-]|%3[Aa]){1,253})\/post\/([a-z0-9]{1,20})\/?$/.exec(decodeURI(url.pathname)) : null;
      return post ? `${post[1]}/app.bsky.feed.post/${post[2]}` : null;
    },
    // It says its height only to a page that gave it an id to say it with.
    frame: (post, theme) => `https://embed.bsky.app/embed/${post}?id=ink&colorMode=${theme}`,
    tall: (message) => record(message)?.height,
  },
];

/** As wide as these sites draw a post, in pixels. */
export const POST_WIDTH = 550;

export interface Post {
  site: string;
  /** What names it among every post shown, whatever theme it is drawn in. */
  key: string;
  height: number;
  origin: string;
  frame(theme: Theme): string;
  /** How tall the post says it is, in pixels, when `message` from its frame says so. A frame can post a message as text or as a value. */
  tall(message: unknown): number | null;
}

/** The post an address names, when it is on a site whose posts can be shown. */
export function postIn(config: string): Post | null {
  const address = addressIn(config);
  if (!address || address.rest) return null;
  for (const site of SITES) {
    const post = site.post(address.url, siteOf(address.url));
    if (!post) continue;
    return {
      site: site.name,
      key: `${site.name}:${post}`,
      height: site.height,
      origin: site.origin,
      frame: (theme) => site.frame(post, theme),
      tall(message) {
        let read = message;
        if (typeof message === "string") {
          try {
            read = JSON.parse(message);
          } catch {
            return null;
          }
        }
        const height = site.tall(read);
        return typeof height === "number" && height >= 40 && height <= 4000 ? Math.ceil(height) : null;
      },
    };
  }
  return null;
}
