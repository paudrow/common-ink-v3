// What a note may show in a frame, and the document an HTML embed is written into.
//
// An HTML embed's markup is note content, so the app never reads it as markup. It is handed, as a
// string, to a frame holding the document served here, whose own response headers give it an origin
// of its own and no network. Those hold whatever the frame's attributes say, and whoever loads it.
// WebRTC is the exception: no header a browser honours today stops a peer connection.

import { EMBED_FRAME_PATH } from "../core/frames.ts";
import { readOrigin } from "../core/plugins.ts";

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
 * the sites a permission lets it load from and send to, and no other. Script is never among what
 * it loads: what runs in the frame is what the app wrote into it.
 */
export function embedPolicy({ network, ancestors }: { network: readonly string[] | null; ancestors: string }): string {
  const inline = "'unsafe-inline'";
  // Each site is read again as a site here, where it is written into a header, whatever kept it.
  const sites = (network ?? []).filter((site) => readOrigin(site) !== null).join(" ");
  const from = (...always: string[]) => [...always, ...(sites ? [sites] : [])].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${inline}`,
    `style-src ${inline}`,
    `img-src ${from("data:", "blob:")}`,
    `media-src ${from("data:", "blob:")}`,
    `font-src ${from("data:")}`,
    ...(sites ? [`connect-src ${sites}`] : []),
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

// A shell around the embed. It takes the embed's markup from the page that frames it, once, and puts
// it in a frame of its own as that frame's whole document (`srcdoc`), never as markup of this one.
// That frame has no address, takes this document's policy, and is governed by it: what the page
// around the app may frame doesn't reach it, so the embed can't send itself to a site the app allows.
// A port that came with the markup is handed on to that frame once it has loaded, unread: it is how
// the app and a plugin's frame talk, and this document is no part of that.
const DOCUMENT = `<!doctype html>
<meta charset="utf-8">
<title>HTML embed</title>
<style>html, body { height: 100%; margin: 0; background: #fff; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
<script>
if (parent !== window) {
  addEventListener("message", function take(event) {
    if (event.source !== parent || !event.data || typeof event.data.html !== "string") return;
    removeEventListener("message", take);
    const scheme = event.data.scheme === "dark" ? "dark" : event.data.scheme === "light" ? "light" : null;
    if (scheme) {
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.style.background = document.body.style.background = scheme === "dark" ? "#171716" : "#fff";
    }
    const port = event.ports && event.ports[0];
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = "HTML embed";
    if (port) frame.addEventListener("load", function () { frame.contentWindow.postMessage({ inkPort: true }, "*", [port]); }, { once: true });
    frame.srcdoc = event.data.html;
    document.body.append(frame);
  });
  parent.postMessage({ embedFrame: "ready" }, "*");
}
</script>
<body></body>
`;

const embedFrame = (ancestors: string, network: readonly string[] | null = null) =>
  new Response(DOCUMENT, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": embedPolicy({ network, ancestors }),
      // A document that lets sites through was answered for one token, once, and is nobody's to keep.
      "Cache-Control": network ? "no-store" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

/** The address of a host given to HTML embeds alone, when `EMBED_ORIGIN` names one. */
function embedOrigin(env: { EMBED_ORIGIN?: string }): string | null {
  if (!env.EMBED_ORIGIN) return null;
  const url = new URL(env.EMBED_ORIGIN);
  if (url.protocol !== "https:" && !/(^|\.)localhost$/.test(url.hostname)) throw new Error("EMBED_ORIGIN must be an https address");
  return url.origin;
}

/** Where a frame whose network is allowed is opened: the embed's document, under a token from plugin.frame. */
const GRANTED_PATH = `${EMBED_FRAME_PATH}/g/`;

/** The sites a frame's token lets through, the one time it is asked, or null: `redeemFrame`, with the record it reads. */
type Redeem = (token: string) => Promise<readonly string[] | null>;

/**
 * The embed's document at `path` on the host that serves it: with no network at its own address,
 * and under a token with the sites the token was made for, the one time it is asked. Anything
 * else, a token that is unknown, used or past its minute among it, is not found, and says no more.
 */
async function served(path: string, redeem: Redeem, ancestors: string): Promise<Response> {
  if (path === EMBED_FRAME_PATH) return embedFrame(ancestors);
  const sites = path.startsWith(GRANTED_PATH) ? await redeem(path.slice(GRANTED_PATH.length)) : null;
  return sites ? embedFrame(ancestors, sites) : new Response("Not found", { status: 404 });
}

/**
 * What to answer where HTML embeds are served, or null for a request that is the app's. With
 * `EMBED_ORIGIN` set, that host answers with the embed's document and nothing else, and the app's
 * own host sends the frame there. Without it the app's host serves the document itself.
 */
export async function embedResponse(url: URL, env: { EMBED_ORIGIN?: string }, redeem: Redeem): Promise<Response | null> {
  const origin = embedOrigin(env);
  if (origin && url.origin === origin) return served(url.pathname, redeem, "*");
  // Every address under the embed's is answered here, so none of them is ever the app's own page.
  if (url.pathname !== EMBED_FRAME_PATH && !url.pathname.startsWith(`${EMBED_FRAME_PATH}/`)) return null;
  return origin ? new Response(null, { status: 302, headers: { Location: origin + url.pathname, "Referrer-Policy": "no-referrer" } }) : served(url.pathname, redeem, "'self'");
}

/** The app's page with what it may frame: the HTML embed's document, at its own address and under a token, and the sites in `FRAME_ORIGINS`. */
export function framing(page: Response, url: URL, env: { EMBED_ORIGIN?: string }): Response {
  if (!page.headers.get("Content-Type")?.startsWith("text/html")) return page;
  const origin = embedOrigin(env);
  // A source that ends in / covers every address below it, so the second covers each token's.
  const framed = [url.origin, ...(origin ? [origin] : [])].flatMap((host) => [host + EMBED_FRAME_PATH, host + GRANTED_PATH]);
  const res = new Response(page.body, page);
  res.headers.append("Content-Security-Policy", `frame-src ${[...framed, ...FRAME_ORIGINS].join(" ")}`);
  return res;
}
