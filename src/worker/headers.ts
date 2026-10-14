// What a browser may do with each response the Worker answers: the Content-Security-Policy for its
// kind of route, and nosniff and a referrer rule for all. Sent by the Worker, so a Preview runs under
// the same policy as the app. Files under /assets/ are served without the Worker and get neither.
// HSTS is the zone's, not the Worker's.

/** A policy as each directive and its sources. A later PR that loads something new adds its source here. */
type Policy = Readonly<Record<string, readonly string[]>>;

/**
 * The app's pages and the sign-in pages. Everything is the app's own but two things: CodeMirror
 * writes its styles into `<style>` elements and the sign-in pages carry one, and the icons in
 * `style.css` are `data:` masks. The app frames nothing yet and is framed by nothing.
 */
export const PAGE: Policy = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": ["'none'"],
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
  path === "/mcp" || path.startsWith("/api/") ? DATA : path === "/embed-frame" || path.startsWith("/embed-frame/") ? EMBED_FRAME : PAGE;

/**
 * `res` with the headers for the route `url` asked for. Vite's dev server writes an inline script
 * into the page, which only it is allowed. A response that brings its own policy keeps it.
 */
export function secured(res: Response, url: URL, env: { DEV_SERVER?: string }): Response {
  const out = new Response(res.body, res);
  let policy = policyFor(url.pathname);
  if (policy === PAGE && env.DEV_SERVER === "1") policy = { ...PAGE, "script-src": [...PAGE["script-src"]!, "'unsafe-inline'"] };
  if (!out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", written(policy));
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", policy === EMBED_FRAME ? "no-referrer" : "strict-origin-when-cross-origin");
  return out;
}
