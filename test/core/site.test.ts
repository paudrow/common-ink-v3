/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { SITE, SITEMAP_PATH } from "../../src/worker/site/index.ts";
import { newMember } from "./members.ts";

const SECRET = "test-secret";
const ORIGIN = "https://ink.test";

const send = async (path: string, init: RequestInit = {}) => {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }) as never, { ...env, SESSION_SECRET: SECRET });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

const signedIn = async () => {
  const ada = await newMember();
  return { Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, SECRET, 3600))}` };
};

const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
/** Which page of the site this is, whatever its words: the landing's is the bare origin. */
const canonicalOf = (html: string) => /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1] ?? null;

describe("the site, for visitors", () => {
  it("shows a visitor the landing at /, and shows someone signed in the app there", async () => {
    const visitor = await send("/");
    expect([visitor.status, visitor.headers.get("Content-Type"), canonicalOf(visitor.text)]).toEqual([200, "text/html; charset=utf-8", "https://ink.test/"]);
    const member = await send("/", { headers: await signedIn() });
    const app = await env.ASSETS.fetch(new Request(`${ORIGIN}/`));
    expect([member.status, member.text]).toEqual([app.status, await app.text()]);
    expect(canonicalOf(member.text)).toBe(null);
  });

  it("shows the landing at /welcome to a visitor and to someone signed in, naming / as its address", async () => {
    const cookie = await signedIn();
    for (const headers of [{}, cookie]) {
      const res = await send("/welcome", { headers });
      expect([res.status, canonicalOf(res.text)]).toEqual([200, "https://ink.test/"]);
    }
  });

  it("offers a visitor Google sign-in back to /, and someone signed in their notes", async () => {
    const visitor = await send("/welcome");
    const member = await send("/welcome", { headers: await signedIn() });
    expect([visitor.text.includes('href="/auth/google?next=%2F">Sign in with Google</a>'), visitor.text.includes("Open your notes")]).toEqual([true, false]);
    expect([member.text.includes('href="/">Open your notes</a>'), member.text.includes("Sign in with Google")]).toEqual([true, false]);
  });

  it("keeps / the app on a dev host, where everyone is the dev user, and keeps search engines off its pages", async () => {
    const dev = { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1" };
    const home = await worker.fetch(new Request("http://localhost:5173/") as never, dev);
    const app = await env.ASSETS.fetch(new Request("http://localhost:5173/"));
    expect([home.status, await home.text()]).toEqual([app.status, await app.text()]);
    const welcome = await worker.fetch(new Request("http://localhost:5173/welcome") as never, dev);
    expect([welcome.status, welcome.headers.get("X-Robots-Tag")]).toEqual([200, "noindex"]);
    expect((await send("/welcome")).headers.get("X-Robots-Tag")).toBe(null);
  });

  it("shows each page written in site/ at its own address, titled by its heading", async () => {
    for (const [path, title] of [["/privacy", "Privacy policy"], ["/terms", "Terms of service"]]) {
      const res = await send(path!);
      expect([path, res.status, titleOf(res.text)?.includes(title!), canonicalOf(res.text)]).toEqual([path, 200, true, `https://ink.test${path}`]);
    }
  });

  it("answers a page's HEAD with its headers and no body, and keeps no copy of either", async () => {
    const res = await send("/privacy", { method: "HEAD" });
    expect([res.status, res.text, res.headers.get("Content-Type"), res.headers.get("Cache-Control"), res.headers.get("Vary")]).toEqual([200, "", "text/html; charset=utf-8", "no-store", "Cookie"]);
  });

  it("lists every page once in the sitemap, at the address it is asked from, and the landing at /", async () => {
    const res = await send(SITEMAP_PATH);
    expect([res.status, res.headers.get("Content-Type")]).toEqual([200, "application/xml; charset=utf-8"]);
    expect([...res.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])).toEqual(["https://ink.test/", "https://ink.test/privacy", "https://ink.test/terms"]);
  });

  it("leaves a request that is not GET or HEAD to the app", async () => {
    const res = await send("/privacy", { method: "POST", body: "{}" });
    const app = await env.ASSETS.fetch(new Request(`${ORIGIN}/privacy`, { method: "POST", body: "{}" }));
    expect([res.status, res.text]).toEqual([app.status, await app.text()]);
    expect(titleOf(res.text)?.includes("Privacy policy") ?? false).toBe(false);
  });
});

describe("where the site's pages are", () => {
  const plugins = import.meta.glob<string>("../../src/web/plugins/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
  const appPages = new Set(Object.values(plugins).flatMap((source) => [...source.matchAll(/\bpath:\s*"(\/[^"]*)"/g)].map((m) => m[1]!)));

  it("takes no address a page of the app is at, but / from visitors", () => {
    expect(["/calendar", "/dashboard", "/todos"].every((path) => appPages.has(path))).toBe(true);
    const always = [...SITE].filter(([, route]) => !route.signedOutOnly).map(([path]) => path);
    expect(always).toContain("/privacy");
    expect(always.filter((path) => appPages.has(path))).toEqual([]);
  });

  it("is under no address the app, links, sign-in or agents answer", () => {
    const taken = ["/note/", "/folder/", "/person/", "/s/", "/api/", "/auth/", "/oauth/"];
    const paths = [...SITE.keys(), SITEMAP_PATH];
    expect(paths).toContain("/terms");
    expect(paths.filter((path) => taken.some((prefix) => path.startsWith(prefix)))).toEqual([]);
  });
});
