import { devSignIn, sessionOf } from "../auth.ts";
import { landing } from "./landing.ts";
import { renderPage, type DocsNav, type SitePage } from "./layout.ts";
import { DOCS, PROSE } from "./pages.gen.ts";

/** A page of the site at an address. At `/` the site answers only someone signed out: anyone else is shown the app there. */
interface SiteRoute {
  page: SitePage;
  signedOutOnly: boolean;
}

const prose = Object.entries(PROSE).map(([slug, { title, description, html }]): SitePage => ({ path: `/${slug}`, title, description, kind: "prose", body: () => html }));

const docPath = (slug: string): `/${string}` => (slug === "index" ? "/docs" : `/docs/${slug}`);
const nav: DocsNav = DOCS.map(({ group, pages }) => ({ group, pages: pages.map(({ slug, title }) => ({ path: docPath(slug), title })) }));
const docs = DOCS.flatMap(({ pages }) => pages).map(({ slug, title, description, html }): SitePage => ({ path: docPath(slug), title, description, kind: "docs", nav, body: () => html }));

/** Every address the site answers with a page. Routing, the sitemap and the test that no page of the app is shadowed all read this. */
export const SITE: ReadonlyMap<string, SiteRoute> = new Map<string, SiteRoute>([
  ["/", { page: landing, signedOutOnly: true }],
  // The landing for anyone, so it can be seen signed in, and on this machine and Previews, where nobody is signed out.
  ["/welcome", { page: landing, signedOutOnly: false }],
  ...[...prose, ...docs].map((page): [string, SiteRoute] => [page.path, { page, signedOutOnly: false }]),
]);

export const SITEMAP_PATH = "/sitemap.xml";

const SIGN_IN = "/auth/google?next=%2F";

/** Each page once, at its own address: the landing is listed at `/`, which `/welcome` names as its canonical. */
const sitemap = (origin: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...new Set([...SITE.values()].map(({ page }) => page.path))].map((path) => `  <url><loc>${origin}${path}</loc></url>\n`).join("")}</urlset>\n`;

/** A dev server and a Preview sign anyone in as the dev user, so search engines are kept off their copy of the site. */
const answer = (req: Request, env: Env, url: URL, body: string, type: string) =>
  new Response(req.method === "HEAD" ? null : body, {
    headers: { "Content-Type": type, "Cache-Control": "no-store", Vary: "Cookie", ...(devSignIn(env, url) ? { "X-Robots-Tag": "noindex" } : {}) },
  });

/** The site's answer to `req`, or null when the address is the app's. */
export async function siteResponse(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (url.pathname === SITEMAP_PATH) return answer(req, env, url, sitemap(url.origin), "application/xml; charset=utf-8");
  const route = SITE.get(url.pathname);
  if (!route) return null;
  const signedIn = (await sessionOf(req, env, url)) !== null;
  if (route.signedOutOnly && signedIn) return null;
  return answer(req, env, url, renderPage(route.page, { signedIn, origin: url.origin, signIn: SIGN_IN }), "text/html; charset=utf-8");
}
