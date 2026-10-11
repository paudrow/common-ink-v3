import type { Embed, Embedded, Plugin } from "../../plugin-api.ts";
import { linkIn } from "./link.ts";
import { postIn, SOCIAL_SITES } from "./social.ts";
import { playerFor, videoIn } from "./youtube.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** What stands in the line for an embed that is shown below it: its name, which takes the cursor to it as written. */
function named(into: HTMLElement, embed: Embedded, text: string) {
  const name = into.appendChild(el("span", "media-name", text));
  name.title = "Click to edit";
  name.addEventListener("mousedown", (event) => {
    event.preventDefault();
    embed.edit();
  });
}

const unread = (into: HTMLElement, text: string) => void into.append(el("span", "embed-unread", text));

/**
 * Another site's frame, loaded when the member asks for it and not before: opening a note tells no
 * other site that it was opened, or by whom, and a note with ten videos costs what one without does.
 * The frame is shut in a sandbox that lets it run and open its own links in a new tab, and nothing
 * else: it can't take the app's window anywhere. It is told the app's address and not the note's.
 */
function framed(into: HTMLElement, { title, action, from, src, allow }: { title: string; action: string; from: string; src: string; allow?: string }) {
  const load = into.appendChild(el("button", "media-load"));
  load.type = "button";
  load.append(el("span", "media-load-action", action), el("span", "media-load-from", `Loads from ${from}`));
  load.addEventListener("click", () => {
    const frame = document.createElement("iframe");
    frame.title = title;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
    frame.referrerPolicy = "strict-origin";
    if (allow) frame.allow = allow;
    frame.src = src;
    load.replaceWith(frame);
  });
}

/** A video is written as its address alone on a line. `::youtube{address}` is how notes used to write one: it is still drawn, and no menu writes it. */
const youtube: Embed = {
  name: "youtube",
  title: "YouTube video",
  menu: false,
  render(into, embed) {
    if (videoIn(embed.config)) named(into, embed, "YouTube video");
    else unread(into, "YouTube: write the video's address on a line of its own");
  },
  below: {
    box: ({ config }) => (videoIn(config) ? { ratio: 16 / 9 } : null),
    render(into, { config }) {
      const video = videoIn(config);
      if (video) framed(into, { title: "YouTube video", action: "Play video", from: "youtube-nocookie.com", src: playerFor(video), allow: "autoplay; encrypted-media; picture-in-picture; fullscreen" });
    },
    ofAddress: (address) => videoIn(address) !== null,
  },
};

/** A post is written as its address alone on a line too, and `::social{address}` is still drawn. */
const social: Embed = {
  name: "social",
  title: "Social post",
  menu: false,
  render(into, embed) {
    const post = postIn(embed.config);
    if (post) named(into, embed, `Post on ${post.site}`);
    else unread(into, `Social post: write the post's address on a line of its own. Posts on ${SOCIAL_SITES.join(" and ")} can be shown, Bluesky's by an address with the account's did:plc:… in it.`);
  },
  below: {
    box({ config }) {
      const post = postIn(config);
      return post && { height: post.height };
    },
    render(into, { config }) {
      const post = postIn(config);
      if (post) framed(into, { title: `Post on ${post.site}`, action: "Show post", from: new URL(post.frame).hostname, src: post.frame });
    },
    ofAddress: (address) => postIn(address) !== null,
  },
};

/** A link is markdown's `[title](address)`. `::link{address title}` is how notes used to write a card for one: it is still drawn, and no menu writes it. */
const link: Embed = {
  name: "link",
  title: "Link",
  menu: false,
  render(into, embed) {
    const found = linkIn(embed.config);
    if (!found) return unread(into, "Link: write it like [A title](https://example.com)");
    const card = into.appendChild(el("a", "link-card"));
    card.href = found.href;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.append(el("span", "link-card-title", found.title), el("span", "link-card-site", found.site));
  },
};

/**
 * Videos and posts in a note, each written as its address alone on a line and shown below that line.
 * The embeds notes used to write them with, and `::link{}`, are still drawn where a note has them.
 */
export const media: Plugin = {
  id: "media",
  name: "Media embeds",
  activate(host) {
    for (const embed of [youtube, social, link]) host.embeds.register(embed);
  },
};
