// What a note may show in a frame, and the document an HTML embed is written into.
//
// An HTML embed's markup is note content, so the app never reads it as markup. It is handed, as a
// string, to a frame holding the document served here, whose own response headers give it an origin
// of its own and no network. Those hold whatever the frame's attributes say, and whoever loads it.
// WebRTC is the exception: no header a browser honours today stops a peer connection.

import { EMBED_FRAME_PATH } from "../core/frames.ts";

/**
 * The other sites a note may show in a frame, which is every site a built-in embed frames. A frame
 * in the app can't be sent anywhere else, by a plugin or by what is inside it.
 */
export const FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://platform.twitter.com", "https://embed.bsky.app"] as const;

/**
 * The policy an HTML embed's document is served with, which the frame the embed runs in takes over
 * from it. `sandbox` without `allow-same-origin` gives each an origin no other document has, so the
 * embed shares nothing with the app: no cookies, no storage, no reaching into the page around it.
 * Without `network` nothing in it can be fetched from anywhere, and `frame-src 'none'` means the
 * embed's frame can't be sent to any address at all, by the embed or by anything else. `network` is
 * the one switch a plugin permission (#16) turns.
 */
export function embedPolicy({ network, ancestors }: { network: boolean; ancestors: string }): string {
  const inline = "'unsafe-inline'";
  const fetched = network
    ? [`default-src https: data: blob: ${inline}`, "connect-src https: wss:"]
    : ["default-src 'none'", `script-src ${inline}`, `style-src ${inline}`, "img-src data: blob:", "media-src data: blob:", "font-src data:"];
  return ["sandbox allow-scripts", ...fetched, "frame-src 'none'", "form-action 'none'", "base-uri 'none'", `frame-ancestors ${ancestors}`].join("; ");
}

// A shell around the embed. It takes the embed's markup from the page that frames it, once, and puts
// it in a frame of its own as that frame's whole document (`srcdoc`), never as markup of this one.
// That frame has no address, takes this document's policy, and is governed by it: what the page
// around the app may frame doesn't reach it, so the embed can't send itself to a site the app allows.
const DOCUMENT = `<!doctype html>
<meta charset="utf-8">
<title>HTML embed</title>
<meta name="color-scheme" content="light dark">
<style>html, body { height: 100%; margin: 0; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
<script>
if (parent !== window) {
  addEventListener("message", function take(event) {
    if (event.source !== parent || !event.data || typeof event.data.html !== "string") return;
    removeEventListener("message", take);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = "HTML embed";
    frame.srcdoc = event.data.html;
    frame.addEventListener("load", function () { parent.postMessage({ embedFrame: "drawn" }, "*"); }, { once: true });
    document.body.append(frame);
  });
  parent.postMessage({ embedFrame: "ready" }, "*");
}
</script>
<body></body>
`;

const embedFrame = (ancestors: string) =>
  new Response(DOCUMENT, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": embedPolicy({ network: false, ancestors }),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

/** The address of a host given to HTML embeds alone, when `EMBED_ORIGIN` names one. */
export function embedOrigin(env: { EMBED_ORIGIN?: string }): string | null {
  if (!env.EMBED_ORIGIN) return null;
  const url = new URL(env.EMBED_ORIGIN);
  if (url.protocol !== "https:" && !/(^|\.)localhost$/.test(url.hostname)) throw new Error("EMBED_ORIGIN must be an https address");
  return url.origin;
}

/**
 * What to answer where HTML embeds are served, or null for a request that is the app's. With
 * `EMBED_ORIGIN` set, that host answers with the embed's document and nothing else, and the app's
 * own host sends the frame there. Without it the app's host serves the document itself.
 */
export function embedResponse(url: URL, env: { EMBED_ORIGIN?: string }): Response | null {
  const origin = embedOrigin(env);
  if (origin && url.origin === origin) return url.pathname === EMBED_FRAME_PATH ? embedFrame("*") : new Response("Not found", { status: 404 });
  if (url.pathname !== EMBED_FRAME_PATH) return null;
  return origin ? new Response(null, { status: 302, headers: { Location: origin + EMBED_FRAME_PATH } }) : embedFrame("'self'");
}
