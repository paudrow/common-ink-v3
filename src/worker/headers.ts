// What a browser may do with each response the Worker answers: the Content-Security-Policy for its
// kind of route, and nosniff and a referrer rule for all. Sent by the Worker, so a Preview runs under
// the same policy as the app. Files under /assets/ are served without the Worker: public/_headers
// gives them nosniff, the referrer rule and DATA, and test/core/headers.test.ts holds the two in step.
// HSTS is the zone's, not the Worker's.

import { EMBED_FRAME_PATH } from "../core/frames.ts";
import { embedOrigin, FRAME_ORIGINS, GRANTED_PATH } from "./frames.ts";

/** A policy as each directive and its sources. A later PR that loads something new adds its source here. */
type Policy = Readonly<Record<string, readonly string[]>>;

/**
 * The app's pages and the sign-in pages. Everything is the app's own but what media and embeds
 * bring: CodeMirror writes its styles into `<style>` elements and the sign-in pages carry one, the
 * icons in `style.css` are `data:` masks, a video's picture is YouTube's, a Google contact's picture is
 * where Google keeps it (`*.googleusercontent.com`) and a sample contact's is `data:`, an upload is played and drawn
 * from the app's own address and measured from a `blob:` of the file before it is sent, `askSite` asks any https
 * site for what it tells anyone, and the page frames the sites in `FRAME_ORIGINS` and the document an
 * HTML embed runs in (`framed`). The app is framed by nothing.
 */
export const PAGE: Policy = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https://i.ytimg.com", "https://*.googleusercontent.com"],
  "media-src": ["'self'", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'", "https:"],
  "manifest-src": ["'self'"],
  "frame-src": [...FRAME_ORIGINS],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
};

/**
 * The document an HTML embed runs in. `sandbox` without `allow-same-origin` gives it an origin of its
 * own, so it shares no cookies or storage with the app, and it may fetch nothing and frame nothing.
 * Its inline script and styles are the embed itself. Only the app frames it.
 */
export const EMBED_FRAME: Policy = {
  sandbox: ["allow-scripts"],
  "default-src": ["'none'"],
  "script-src": ["'unsafe-inline'"],
  "style-src": ["'unsafe-inline'"],
  "img-src": ["data:", "blob:"],
  "media-src": ["data:", "blob:"],
  "font-src": ["data:"],
  "frame-src": ["'none'"],
  "form-action": ["'none'"],
  "base-uri": ["'none'"],
  "frame-ancestors": ["'self'"],
};

/** JSON for the app and for agents: nothing in it is ever run or drawn. */
export const DATA: Policy = { "default-src": ["'none'"], "frame-ancestors": ["'none'"] };

export const written = (policy: Policy) =>
  Object.entries(policy)
    .map(([directive, sources]) => [directive, ...sources].join(" "))
    .join("; ");

const policyFor = (path: string): Policy =>
  path === "/mcp" || path.startsWith("/api/") ? DATA : path === EMBED_FRAME_PATH || path.startsWith(`${EMBED_FRAME_PATH}/`) ? EMBED_FRAME : PAGE;

/**
 * The page's policy at `url`: it may also frame the HTML embed's document, at its own address and under
 * a token (a source that ends in / covers every address below it), from the app's own host and from
 * the embeds' host when `EMBED_ORIGIN` names one.
 */
const framed = (url: URL, env: { EMBED_ORIGIN?: string }): Policy => {
  const origin = embedOrigin(env);
  const hosts = [url.origin, ...(origin ? [origin] : [])];
  return { ...PAGE, "frame-src": [...hosts.flatMap((host) => [host + EMBED_FRAME_PATH, host + GRANTED_PATH]), ...PAGE["frame-src"]!] };
};

/**
 * `res` with the headers for the route `url` asked for. Vite's dev server writes an inline script
 * into the page, which only it is allowed. A response that brings its own policy or referrer rule keeps it.
 */
export function secured(res: Response, url: URL, env: { DEV_SERVER?: string; EMBED_ORIGIN?: string }): Response {
  const out = new Response(res.body, res);
  const kind = policyFor(url.pathname);
  let policy = kind === PAGE ? framed(url, env) : kind;
  if (kind === PAGE && env.DEV_SERVER === "1") policy = { ...policy, "script-src": [...policy["script-src"]!, "'unsafe-inline'"] };
  if (!out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", written(policy));
  out.headers.set("X-Content-Type-Options", "nosniff");
  if (!out.headers.has("Referrer-Policy")) out.headers.set("Referrer-Policy", kind === EMBED_FRAME ? "no-referrer" : "strict-origin-when-cross-origin");
  return out;
}
