import { EMBED_FRAME_PATH } from "../core/frames.ts";
import { themeNow } from "./theme.ts";

/** How long a frame's document is given to answer, in milliseconds. It is the app's own and holds nothing. */
const WAIT = 4000;

const COLOUR = /^[\w\s(),.%#/-]+$/;

/**
 * What a frame's document starts with, so that a few words of HTML are read as the note around them
 * is: the app's background, ink and face, in the theme the app is in now. The HTML that follows can
 * say otherwise, and a doctype of its own after this one is passed over.
 */
function opening(): string {
  const { backgroundColor, color } = getComputedStyle(document.documentElement);
  const colours = COLOUR.test(backgroundColor) && COLOUR.test(color) ? `background:${backgroundColor};color:${color};` : "";
  return `<!doctype html><meta name="color-scheme" content="${themeNow()}"><style>:root{${colours}font:16px/1.5 system-ui,sans-serif}</style>`;
}

/**
 * A frame that runs `html` shut off from the app. The app never reads `html` as markup: it is handed
 * as a string to a document the Worker serves (`src/worker/frames.ts`) with headers that give it an
 * origin of its own and no network, and that document becomes it. So what runs there can't read the
 * page around it, the member's session, anything kept in the browser, or anything from the server.
 * Put the frame in the page, and call `stop` when it is taken out.
 *
 * The frame carries no `sandbox` attribute. The document's own headers shut it in, and `html` is
 * handed over only once the document has answered from an origin with no name, which is what being
 * shut in gives it. A browser that refuses a request made by a frame with the attribute, as the
 * Claude desktop app's does for a local address, then still shows the embed.
 *
 * `refused` is called when the document hasn't answered that way in a few seconds: the browser would
 * not load it, or it came without what shuts it in. Nothing of `html` has run then, and nothing will.
 *
 * `port` goes with the string to the document, which passes it to what it runs: it is the only way
 * what runs there and the app talk, and holding the other end is how the app knows which frame is
 * speaking. `scheme` is what the document shows behind what it runs. `grant` is a token from
 * `plugin.frame`, good once, for a document whose policy lets it reach the sites an admin allowed.
 * `name` names the frame, which is how the frames of the app's own plugins are told from a workspace's.
 */
export function sandboxed(html: string, { title, port, scheme, grant, refused, name }: { title: string; refused?: () => void; port?: MessagePort; scheme?: "light" | "dark"; grant?: string | null; name?: string }): { frame: HTMLIFrameElement; stop: () => void } {
  const frame = document.createElement("iframe");
  frame.title = title;
  if (name) frame.name = name;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  const ready = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== "null" || (event.data as { embedFrame?: unknown } | null)?.embedFrame !== "ready") return;
    stop();
    // The document's origin is its own, which has no name to address it by. Only this frame's window is sent to.
    frame.contentWindow!.postMessage({ html: opening() + html, ...(scheme && { scheme }) }, "*", port ? [port] : []);
  };
  const waited = setTimeout(() => {
    stop();
    refused?.();
  }, WAIT);
  const stop = () => {
    removeEventListener("message", ready);
    clearTimeout(waited);
  };
  addEventListener("message", ready);
  frame.src = grant ? `${EMBED_FRAME_PATH}/g/${encodeURIComponent(grant)}` : EMBED_FRAME_PATH;
  return { frame, stop };
}
