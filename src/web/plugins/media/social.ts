import { addressIn, siteOf } from "./address.ts";

/**
 * A site whose posts can be shown: one that publishes a frame for a post whose address can be worked
 * out from the post's own, with nothing fetched, and that works shut in a sandbox. A site that only
 * offers a script to run in the page isn't here, since nothing of a third party runs in the app.
 */
interface Site {
  name: string;
  /** How tall its posts are given, in pixels. A longer one scrolls inside. */
  height: number;
  /** The frame for the post at `url`, or null when `url` isn't one of its posts. */
  frame(url: URL, site: string): string | null;
}

const SITES: readonly Site[] = [
  {
    name: "X",
    height: 360,
    frame(url, site) {
      const id = ["x.com", "twitter.com"].includes(site) ? /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,25})\/?$/.exec(url.pathname)?.[1] : undefined;
      return id ? `https://platform.twitter.com/embed/Tweet.html?dnt=true&id=${id}` : null;
    },
  },
  {
    name: "Bluesky",
    height: 360,
    // Its frame takes the account's DID and not its handle, and finding one from the other would mean asking Bluesky.
    frame(url, site) {
      const post = site === "bsky.app" ? /^\/profile\/(did:(?:plc|web):[A-Za-z0-9.:%-]{1,253})\/post\/([a-z0-9]{1,20})\/?$/.exec(decodeURI(url.pathname)) : null;
      return post ? `https://embed.bsky.app/embed/${post[1]}/app.bsky.feed.post/${post[2]}` : null;
    },
  },
];

export interface Post {
  site: string;
  height: number;
  frame: string;
}

/** The post a config names, when it is on a site whose posts can be shown. `height=` in the config gives it another height. */
export function postIn(config: string): Post | null {
  const address = addressIn(config);
  if (!address) return null;
  const asked = Number(/(?:^|\s)height=(\d{2,4})(?:\s|$)/.exec(address.rest)?.[1]);
  for (const site of SITES) {
    const frame = site.frame(address.url, siteOf(address.url));
    if (frame) return { site: site.name, frame, height: asked ? Math.min(Math.max(asked, 120), 1600) : site.height };
  }
  return null;
}

export const SOCIAL_SITES = SITES.map((s) => s.name);
