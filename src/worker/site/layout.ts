import { escape } from "../auth.ts";

/** Who is looking at a page of the site, which changes only its way in. */
export interface Visit {
  signedIn: boolean;
  /** The site's own origin, for the addresses a page names of itself. */
  origin: string;
  /** Where Sign in goes, back to `/` once it is done. */
  signIn: string;
}

export interface SitePage {
  path: `/${string}`;
  title: string;
  description: string;
  kind: "landing" | "prose";
  body: (visit: Visit) => string;
}

export const SUPPORT = "support@commonink.app";
const NAME = "Common Ink";

/** The drop, in the colour of the text around it. */
const MARK = `<svg class="drop" viewBox="21 11 58 80" aria-hidden="true"><path d="M50 14.5C50 14.5 25 43.5 25 60.5a25 25 0 0 0 50 0C75 43.5 50 14.5 50 14.5Z" fill="currentColor"/><path d="M37 60.5a13 13 0 0 0 9 12" stroke="var(--paper)" stroke-width="5" stroke-linecap="round" fill="none"/></svg>`;

/** The way in, said for who is looking: a visitor signs in, a member goes back to their notes. */
export const wayIn = (visit: Visit, className = "button") =>
  visit.signedIn ? `<a class="${className}" href="/">Open your notes</a>` : `<a class="${className}" href="${escape(visit.signIn)}">Sign in with Google</a>`;

const FONTS = ["ia-writer-mono/ia-writer-mono-latin-400-normal", "source-serif-4/source-serif-4-latin-400-normal"];

export function renderPage(page: SitePage, visit: Visit): string {
  const canonical = `${visit.origin}${page.path}`;
  const title = page.kind === "landing" ? `${NAME} | Notes you write with your agent` : `${page.title} | ${NAME}`;
  const main = page.kind === "prose" ? `<article class="prose"><h1>${escape(page.title)}</h1>${page.body(visit)}</article>` : page.body(visit);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(title)}</title>
<meta name="description" content="${escape(page.description)}">
<link rel="canonical" href="${escape(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${NAME}">
<meta property="og:url" content="${escape(canonical)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(page.description)}">
<meta property="og:image" content="${escape(visit.origin)}/social.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#fbfaf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171716" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${FONTS.map((font) => `<link rel="preload" href="/fonts/${font}.woff2" as="font" type="font/woff2" crossorigin>`).join("\n")}
<link rel="stylesheet" href="/site.css">
</head>
<body class="site-${page.kind}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <a class="brand" href="/">${MARK}${NAME}</a>
  <nav aria-label="Site">${wayIn(visit, "head-link")}</nav>
</header>
<main id="main">
${main}
</main>
<footer class="site-foot">
  <a class="brand" href="/">${MARK}${NAME}</a>
  <nav aria-label="Legal and contact">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href="https://github.com/paudrow/common-ink-v3/blob/main/SECURITY.md">Security</a>
    <a href="mailto:${SUPPORT}">${SUPPORT}</a>
  </nav>
  <p>&copy; ${new Date().getUTCFullYear()} Audrow Nash LLC</p>
</footer>
</body>
</html>
`;
}
