import type { Page } from "@playwright/test";

export const PLAYER = "https://www.youtube-nocookie.com/";

const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/**
 * Stands in for the sites media is asked of, which the tests can't count on reaching. A video's
 * picture is a dot, it is called "Stand-in video", and its player is a page that knows when it was
 * loaded and counts for as long as it lives. A post is a page that says which theme it was asked for
 * in, and how tall it is when `postHeight` is given. Returns each address the player was asked for.
 */
export async function standIns(page: Page, { postHeight }: { postHeight?: number } = {}) {
  const played: string[] = [];
  await page.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: DOT }));
  await page.route("https://www.youtube.com/oembed**", (route) => route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ title: "Stand-in video" }) }));
  await page.route(`${PLAYER}**`, (route) => {
    played.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<body>stand-in<script>window.born = String(Math.random()); window.ticks = 0; setInterval(() => window.ticks++, 20);</script>" });
  });
  const says = (message: string) => (postHeight === undefined ? "" : `<script>parent.postMessage(${message}, "*");</script>`);
  await page.route("https://platform.twitter.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<body>post on X, ${new URL(route.request().url()).searchParams.get("theme")}${says(JSON.stringify({ "twttr.embed": { method: "twttr.private.resize", params: [{ height: postHeight }] } }))}` }),
  );
  await page.route("https://embed.bsky.app/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<body>post on Bluesky, ${new URL(route.request().url()).searchParams.get("colorMode")}${says(JSON.stringify({ id: "ink", height: postHeight }))}` }),
  );
  return played;
}
