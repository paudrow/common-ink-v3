import { askSite, onTheme, themeNow, type AddressEmbed, type Plugin, type PluginHost } from "../../plugin-api.ts";
import { arriving } from "../lib/arriving.ts";
import { postIn, POST_WIDTH } from "./social.ts";
import { playerFor, posterFor, sharpPosterFor, titleFor, videoIn } from "./youtube.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/**
 * Another site's frame. It is shut in a sandbox that lets it run and open its own links in a new
 * tab, and nothing else: it can't take the app's window anywhere. It is told the app's address and
 * not the note's.
 */
function framed({ title, src, allow }: { title: string; src: string; allow?: string }): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
  frame.referrerPolicy = "strict-origin";
  if (allow) frame.allow = allow;
  frame.src = src;
  return frame;
}

/**
 * A video is shown as its picture with a play button over it, and what it is called. The picture and
 * the title are asked of YouTube without its player and without a cookie. The player is loaded in the
 * picture's place when play is pressed, and starts.
 */
const video: AddressEmbed = {
  name: "video",
  title: "Video",
  claims: (address) => videoIn(address) !== null,
  below: {
    box({ config }) {
      const found = videoIn(config);
      return found && (found.short ? { ratio: 9 / 16, maxWidth: 340 } : { ratio: 16 / 9 });
    },
    render(into, { config }) {
      const found = videoIn(config);
      if (!found) return;
      const play = into.appendChild(el("button", "media-play"));
      play.type = "button";
      play.setAttribute("aria-label", "Play video");
      const poster = play.appendChild(el("img", "media-poster"));
      poster.alt = "";
      poster.referrerPolicy = "no-referrer";
      poster.src = posterFor(found);
      const sharp = new Image();
      sharp.referrerPolicy = "no-referrer";
      sharp.addEventListener("load", () => sharp.naturalWidth > 120 && (poster.src = sharp.src));
      sharp.src = sharpPosterFor(found);
      const title = play.appendChild(el("span", "media-title"));
      play.append(el("span", "media-play-mark"));
      let called = "";
      const asking = new AbortController();
      void askSite(titleFor(found), asking.signal).then((said) => {
        const answer = (said as { title?: unknown } | null)?.title;
        if (typeof answer !== "string" || !answer) return;
        title.textContent = called = answer;
        play.setAttribute("aria-label", `Play video: ${called}`);
      });
      play.addEventListener("click", () => {
        asking.abort();
        play.replaceWith(framed({ title: called || "Video", src: playerFor(found), allow: "autoplay; encrypted-media; picture-in-picture; fullscreen" }));
      });
      return () => asking.abort();
    },
  },
};

/**
 * A post is shown at once, in the app's theme, as wide as its site draws one and as tall as its frame
 * says it is. That height is only known once it has loaded, so it is kept in the browser for the next
 * time. A change of theme asks for the post again in the other one.
 */
const post = (heights: Heights): AddressEmbed => ({
  name: "post",
  title: "Post",
  claims: (address) => postIn(address) !== null,
  below: {
    box({ config }) {
      const found = postIn(config);
      return found && { height: heights.of(found.key) ?? found.height, maxWidth: POST_WIDTH };
    },
    render(into, { config, resize }) {
      const found = postIn(config);
      if (!found) return;
      const frame = into.appendChild(framed({ title: `Post on ${found.site}`, src: found.frame(themeNow()) }));
      // A post says how tall it is once it is drawn. One that never says is shown a while after its page has loaded.
      const shown = arriving(into, frame);
      let late: ReturnType<typeof setTimeout> | undefined;
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      let waiting = true;
      const arrived = () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(late);
        clearTimeout(giveUp);
        shown.arrived();
      };
      // A frame that never loads would otherwise hold the gray placeholder for good. The post is still a link.
      const failed = () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(late);
        clearTimeout(giveUp);
        frame.remove();
        shown.arrived();
        const link = into.appendChild(el("a", "media-post-link", config));
        link.href = config;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        resize(LINK_HEIGHT);
      };
      const arm = () => {
        clearTimeout(giveUp);
        giveUp = setTimeout(failed, GIVES_UP);
      };
      frame.addEventListener("load", () => {
        if (!waiting) return;
        clearTimeout(late);
        clearTimeout(giveUp);
        late = setTimeout(arrived, SAYS_NOTHING);
      });
      frame.addEventListener("error", failed);
      arm();
      const said = (event: MessageEvent) => {
        if (!frame.isConnected || event.source !== frame.contentWindow || event.origin !== found.origin) return;
        const height = found.tall(event.data);
        if (height === null) return;
        heights.remember(found.key, height);
        resize(height);
        arrived();
      };
      addEventListener("message", said);
      const themed = onTheme((theme) => {
        clearTimeout(late);
        waiting = true;
        into.querySelector(".media-post-link")?.remove();
        if (!frame.isConnected) into.append(frame);
        shown.again();
        frame.src = found.frame(theme);
        arm();
      });
      return () => {
        clearTimeout(late);
        clearTimeout(giveUp);
        removeEventListener("message", said);
        themed();
      };
    },
  },
});

/** How long after its page has loaded a post that hasn't said how tall it is is shown anyway, in milliseconds. */
const SAYS_NOTHING = 2500;

/** How long a frame is given to load before the room shows a link to the post instead, in milliseconds. */
const GIVES_UP = 8000;

/** How tall the room is once it holds that link, in pixels. */
const LINK_HEIGHT = 48;

interface Heights {
  of(post: string): number | undefined;
  remember(post: string, height: number): void;
}

const MOST = 300;

/** How tall each post turned out to be, kept in this browser, so the next time it is shown its room is right before it has loaded. */
function heightsIn(storage: PluginHost["storage"]): Heights {
  // Read once: a room is asked for on every change to the note.
  const all = storage.get("heights");
  let kept: Record<string, unknown> = typeof all === "object" && all !== null ? { ...all } : {};
  return {
    of(post) {
      const height = kept[post];
      return typeof height === "number" && height >= 40 && height <= 4000 ? height : undefined;
    },
    remember(post, height) {
      const { [post]: was, ...rest } = kept;
      if (was === height) return;
      const entries = [...Object.entries(rest), [post, height] as const];
      storage.set("heights", (kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MOST)))));
    },
  };
}

/** Videos and posts in a note, each written as its address alone on a line and shown below that line. */
export const media: Plugin = {
  id: "media",
  name: "Media embeds",
  description: "A video's or a post's address alone on a line is shown below that line.",
  icon: "play",
  activate(host) {
    for (const embed of [video, post(heightsIn(host.storage))]) host.embeds.register(embed);
  },
};
