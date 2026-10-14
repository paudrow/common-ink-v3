import { EMBED_FRAME_PATH } from "../core/frames.ts";
import { themeNow } from "./theme.ts";

/** How long a frame's document is given to answer, in milliseconds. It is the app's own and holds nothing, but a server just woken can be slow. */
const WAIT = 10_000;
/** How long after the HTML is handed over it is shown though its page hasn't said it is drawn, in milliseconds. */
const SHOWN_ANYWAY = 3000;

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
 * `drawn` is called once the document has put `html` on its page, or a few seconds after `html` was
 * handed over if the page never says so (HTML that stops its own loading).
 */
export function sandboxed(html: string, { title, refused, drawn }: { title: string; refused?: () => void; drawn?: () => void }): { frame: HTMLIFrameElement; stop: () => void } {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  let handed = false;
  const heard = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== "null") return;
    const said = (event.data as { embedFrame?: unknown } | null)?.embedFrame;
    if (said === "ready" && !handed) {
      handed = true;
      clearTimeout(waited);
      // The document's origin is its own, which has no name to address it by. Only this frame's window is sent to.
      frame.contentWindow!.postMessage({ html: opening() + html }, "*");
      waited = setTimeout(() => {
        stop();
        drawn?.();
      }, SHOWN_ANYWAY);
    } else if (said === "drawn" && handed) {
      stop();
      drawn?.();
    }
  };
  let waited = setTimeout(() => {
    stop();
    refused?.();
  }, WAIT);
  const stop = () => {
    removeEventListener("message", heard);
    clearTimeout(waited);
  };
  addEventListener("message", heard);
  frame.src = EMBED_FRAME_PATH;
  return { frame, stop };
}
