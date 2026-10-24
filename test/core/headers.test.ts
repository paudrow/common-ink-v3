import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DATA as DATA_POLICY, secured, written } from "../../src/worker/headers.ts";
import STATIC_HEADERS from "../../public/_headers?raw";

const PAGE =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://*.googleusercontent.com; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' https:; manifest-src 'self'; frame-src https://commonink.app/embed-frame https://commonink.app/embed-frame/mail https://commonink.app/embed-frame/g/ https://www.youtube-nocookie.com https://platform.twitter.com https://embed.bsky.app; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const EMBED_FRAME =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const DATA = "default-src 'none'; frame-ancestors 'none'";
const SITE_PAGE =
  "default-src 'none'; script-src https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src https://cloudflareinsights.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

const sent = async (path: string, init?: RequestInit) => {
  const res = await SELF.fetch(`https://commonink.app${path}`, { redirect: "manual", ...init });
  await res.arrayBuffer();
  return [path, res.headers.get("Content-Security-Policy"), res.headers.get("X-Content-Type-Options"), res.headers.get("Referrer-Policy")];
};

describe("what the Worker tells a browser about each response", () => {
  it("gives the app's pages, the sign-in pages and the retiring service worker the app's policy", async () => {
    for (const path of ["/note/abcdefghijkl", "/settings", "/usage", "/auth/google", "/auth/nothing", "/sw.js"]) {
      expect(await sent(path)).toEqual([path, PAGE, "nosniff", "strict-origin-when-cross-origin"]);
    }
  });

  it("gives the site's pages a policy of their own, which runs nothing of the app's and lets Cloudflare's beacon count the visit", async () => {
    for (const path of ["/", "/welcome", "/privacy", "/terms", "/docs", "/docs/cli", "/sitemap.xml"]) {
      expect(await sent(path)).toEqual([path, SITE_PAGE, "nosniff", "strict-origin-when-cross-origin"]);
    }
  });

  it("gives JSON for the app and for agents a policy that runs and draws nothing, whatever the answer", async () => {
    for (const [path, init] of [["/api/me"], ["/health"], ["/api/faults", { method: "POST", body: "{}" }], ["/api/workspaces/aaaaaaaaaaaa/ops", { method: "POST", body: "{}" }], ["/api/agents"], ["/mcp", { method: "POST", body: "{}" }], ["/.well-known/oauth-protected-resource"], ["/.well-known/oauth-protected-resource/mcp"], ["/.well-known/oauth-authorization-server"], ["/oauth/register", { method: "POST", body: "{}" }], ["/oauth/token", { method: "POST", body: "grant_type=x" }], ["/oauth/revoke", { method: "POST", body: "token=x" }]] as const) {
      expect(await sent(path, init)).toEqual([path, DATA, "nosniff", "strict-origin-when-cross-origin"]);
    }
  });

  it("gives the one OAuth address that is a page, where an error is shown, the app's policy, and a redirect from it the same", async () => {
    for (const path of ["/oauth/authorize", "/oauth/authorize?client_id=nobody"]) expect(await sent(path)).toEqual([path, PAGE, "nosniff", "strict-origin-when-cross-origin"]);
  });

  it("gives the document an HTML embed runs in a sandbox of its own, and sends no referrer from it", async () => {
    for (const path of ["/embed-frame", "/embed-frame/x"]) expect(await sent(path)).toEqual([path, EMBED_FRAME, "nosniff", "no-referrer"]);
  });

  it("sends them on a redirect too", async () => {
    const res = await SELF.fetch("https://www.commonink.app/note/x", { redirect: "manual" });
    expect([res.status, res.headers.get("Content-Security-Policy")]).toEqual([301, PAGE.replaceAll("https://commonink.app/", "https://www.commonink.app/")]);
  });

  it("lets only Vite's dev server run its inline script, and keeps a policy or referrer rule a response brings with it", () => {
    const url = new URL("https://localhost/note/x");
    expect(secured(new Response("<p>"), url, { DEV_SERVER: "1" }).headers.get("Content-Security-Policy")).toBe(PAGE.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replaceAll("https://commonink.app/", "https://localhost/"));
    expect(secured(new Response("{}"), new URL("https://localhost/api/me"), { DEV_SERVER: "1" }).headers.get("Content-Security-Policy")).toBe(DATA);
    const own = new Response("<p>", { headers: { "Content-Security-Policy": "default-src 'none'" } });
    expect(secured(own, url, {}).headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    // A page a link opens sends no referrer, so its address goes to no other site.
    expect(secured(new Response("<p>", { headers: { "Referrer-Policy": "no-referrer" } }), new URL("https://localhost/s/abcdefghijklmnopqrstu"), {}).headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("gives the built files the Worker never sees what it gives everything else, so a script or a picture there is never read as anything else or run as a page", () => {
    expect(STATIC_HEADERS.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([
      "/assets/*",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      `  Content-Security-Policy: ${written(DATA_POLICY)}`,
      "  Cache-Control: public, max-age=31536000, immutable",
    ]);
  });

  it("puts a page in a browsing context group of its own, and leaves JSON and the embed's document out of it", async () => {
    const opener = async (path: string) => (await SELF.fetch(`https://commonink.app${path}`, { redirect: "manual" })).headers.get("Cross-Origin-Opener-Policy");
    expect([await opener("/"), await opener("/auth/google"), await opener("/oauth/authorize"), await opener("/api/me"), await opener("/embed-frame")]).toEqual(["same-origin", "same-origin", "same-origin", null, null]);
  });
});
