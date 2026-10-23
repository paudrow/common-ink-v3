import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import { redeemFrame } from "../../src/core/pluginRecord.ts";
import worker from "../../src/worker/index.ts";
import { embedPolicy, embedResponse, FRAME_ORIGINS } from "../../src/worker/frames.ts";
import { secured } from "../../src/worker/headers.ts";
import { newMember } from "./members.ts";

const get = (url: string) => SELF.fetch(url, { redirect: "manual" });
const directives = (policy: string) => Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")]));
const NO_NETWORK = {
  sandbox: "allow-scripts",
  "default-src": "'none'",
  "script-src": "'unsafe-inline'",
  "style-src": "'unsafe-inline'",
  "img-src": "data: blob:",
  "media-src": "data: blob:",
  "font-src": "data:",
  "frame-src": "'none'",
  "form-action": "'none'",
  "base-uri": "'none'",
};
/** What the page at `url` may frame, from the one policy the Worker sends it. */
const framedAt = (url: string, env: { EMBED_ORIGIN?: string } = {}) => {
  const policies = secured(new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }), new URL(url), env).headers.get("Content-Security-Policy")!;
  expect(policies).not.toContain(",");
  return directives(policies)["frame-src"];
};
const withEmbedHost = (url: string) => worker.fetch(new Request(url) as never, { ...env, EMBED_ORIGIN: "https://embed.commonink.app" });

describe("the document an HTML embed is written into", () => {
  it("is served with an origin of its own and no network, whoever frames it and however", async () => {
    for (const host of ["https://commonink.app", "https://pr-12-common-ink-v3-previews.draftox.workers.dev", "http://localhost:5173"]) {
      const res = await get(`${host}/embed-frame`);
      expect(res.status, host).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(directives(res.headers.get("Content-Security-Policy")!)).toEqual({
        sandbox: "allow-scripts",
        "default-src": "'none'",
        "script-src": "'unsafe-inline'",
        "style-src": "'unsafe-inline'",
        "img-src": "data: blob:",
        "media-src": "data: blob:",
        "font-src": "data:",
        "frame-src": "'none'",
        "form-action": "'none'",
        "base-uri": "'none'",
        "frame-ancestors": "'self'",
      });
      // The embed is put in a frame of its own as that frame's document, and never written into this one.
      const shell = await res.text();
      expect(shell).toContain("frame.srcdoc = event.data.html");
      expect(shell).not.toMatch(/document\.write|innerHTML/);
    }
  });

  it("takes one message, from the page that frames it, and hands a port that came with it to the embed's frame unread", async () => {
    const shell = await (await get("https://commonink.app/embed-frame")).text();
    const script = /<script>([^]*)<\/script>/.exec(shell)![1]!;
    // The first message from the parent is the only one taken, and nothing else is listened for.
    expect(script.match(/addEventListener\("message"/g)).toHaveLength(1);
    expect(script).toContain('if (event.source !== parent || !event.data || typeof event.data.html !== "string") return;\n    removeEventListener("message", take);');
    // The port goes to the frame the shell made, once that frame has loaded, and the shell keeps no handler on it.
    expect(script).toContain('if (port) frame.addEventListener("load", function () { frame.contentWindow.postMessage({ inkPort: true }, "*", [port]); }, { once: true });');
    expect(script).not.toMatch(/onmessage|port\.start|port\.postMessage/);
    // The scheme is one of two words or nothing: what the page sent is never written into the document.
    expect(script).toContain('const scheme = event.data.scheme === "dark" ? "dark" : event.data.scheme === "light" ? "light" : null;');
    expect(script.match(/event\.data\.\w+/g)!.sort()).toEqual(["event.data.html", "event.data.html", "event.data.scheme", "event.data.scheme"]);
    expect(script).not.toMatch(/fetch|XMLHttpRequest|localStorage|cookie|eval|location/);
  });

  it("holds nothing of any note or member: it is the same for everyone, signed in or not", async () => {
    const [one, other] = [await get("https://commonink.app/embed-frame"), await SELF.fetch("https://commonink.app/embed-frame", { headers: { Cookie: "session=anything" } })];
    expect(await one.text()).toBe(await other.text());
  });

  it("has one switch for the network, which is off, and on lets through the sites it was given and no other", () => {
    const off = directives(embedPolicy({ network: null, ancestors: "'self'" }));
    const sites = ["https://api.example.com", "https://cdn.example.com:8443"];
    const on = directives(embedPolicy({ network: sites, ancestors: "'self'" }));
    expect(off).toEqual({ ...NO_NETWORK, "frame-ancestors": "'self'" });
    expect(directives(embedPolicy({ network: [], ancestors: "'self'" }))).toEqual(off);
    expect(on).toEqual({
      ...NO_NETWORK,
      "img-src": `data: blob: ${sites.join(" ")}`,
      "media-src": `data: blob: ${sites.join(" ")}`,
      "font-src": `data: ${sites.join(" ")}`,
      "connect-src": sites.join(" "),
      "frame-ancestors": "'self'",
    });
    // Either way it keeps an origin of its own, and can't send a form or be given another base.
    // And its frame can be sent nowhere: a grant of the network is not a grant to leave.
    // Nor is it a grant to load code: script is what the app wrote into the frame, with the network on too.
    for (const policy of [off, on]) expect([policy.sandbox, policy["default-src"], policy["script-src"], policy["frame-src"], policy["form-action"], policy["base-uri"]]).toEqual(["allow-scripts", "'none'", "'unsafe-inline'", "'none'", "'none'", "'none'"]);
  });

  it("writes into the policy only what reads as a site, so nothing given as one can end a directive or add one", () => {
    const given = ["https://ok.example.com", "https://evil.example.com; script-src *", "https://evil.example.com 'unsafe-eval'", "*", "https:", "https://*.example.com", "https://ok.example.com/path", "http://example.com", "javascript:alert(1)", "'self'", ""];
    const policy = embedPolicy({ network: given, ancestors: "'self'" });
    expect(directives(policy)).toEqual({ ...NO_NETWORK, "img-src": "data: blob: https://ok.example.com", "media-src": "data: blob: https://ok.example.com", "font-src": "data: https://ok.example.com", "connect-src": "https://ok.example.com", "frame-ancestors": "'self'" });
    expect(directives(embedPolicy({ network: given.slice(1), ancestors: "'self'" }))).toEqual({ ...NO_NETWORK, "frame-ancestors": "'self'" });
  });
});

describe("a plugin that comes with the app", () => {
  it("opens its frame with the sites it declares, and with none when it declares no network", async () => {
    const ada = await newMember();
    const frame = await perform(env.DB, ada, { type: "plugin.frame", id: "weather" });
    expect(frame.token).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(frame.origins).toEqual(["https://geocoding-api.open-meteo.com", "https://api.open-meteo.com", "https://api.bigdatacloud.net"]);
    expect(await perform(env.DB, ada, { type: "plugin.frame", id: "coin" })).toEqual({ token: null, origins: [] });
  });
});

describe("the embed's document under a frame's token", () => {
  const SITES = ["https://api.example.com", "https://cdn.example.com"];
  /** A workspace whose HTML embeds may reach `SITES`, and a way to ask for a frame's token there. */
  async function allowed() {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "plugin.permit", id: "html", capability: "network", allowed: true, origins: SITES });
    return async () => (await perform(env.DB, ada, { type: "plugin.frame", id: "html" })).token!;
  }

  it("is the same document, served once with the token's sites let through", async () => {
    const mint = await allowed();
    const token = await mint();
    const res = await get(`https://commonink.app/embed-frame/g/${token}`);
    expect(res.status).toBe(200);
    expect(directives(res.headers.get("Content-Security-Policy")!)).toEqual({
      ...NO_NETWORK,
      "img-src": `data: blob: ${SITES.join(" ")}`,
      "media-src": `data: blob: ${SITES.join(" ")}`,
      "font-src": `data: ${SITES.join(" ")}`,
      "connect-src": SITES.join(" "),
      "frame-ancestors": "'self'",
    });
    expect([res.headers.get("Content-Type"), res.headers.get("Cache-Control"), res.headers.get("X-Content-Type-Options"), res.headers.get("Referrer-Policy"), res.headers.get("Set-Cookie")]).toEqual(["text/html; charset=utf-8", "no-store", "nosniff", "no-referrer", null]);
    expect(await res.text()).toBe(await (await get("https://commonink.app/embed-frame")).text());

    // Used, it is no address at all, and neither is one that was never made. Neither says why.
    const again = await get(`https://commonink.app/embed-frame/g/${token}`);
    const never = await get(`https://commonink.app/embed-frame/g/${"A".repeat(43)}`);
    // It is answered under the policy of every address there (headers.ts), which lets no site through.
    expect([again.status, await again.text(), directives(again.headers.get("Content-Security-Policy")!)["connect-src"]]).toEqual([404, "Not found", undefined]);
    expect([never.status, await never.text()]).toEqual([404, "Not found"]);
    for (const path of ["/embed-frame/g/", "/embed-frame/g/short", `/embed-frame/g/${token}/more`, "/embed-frame/g", "/embed-frame/x"]) expect((await get(`https://commonink.app${path}`)).status, path).not.toBe(200);
  });

  it("is not found once its minute is up", async () => {
    const mint = await allowed();
    const [late, onTime] = [await mint(), await mint()];
    const at = (token: string, now: number) => embedResponse(new URL(`https://commonink.app/embed-frame/g/${token}`), {}, (asked) => redeemFrame(env.DB, asked, now));
    expect((await at(late, Date.now() + 61_000))!.status).toBe(404);
    expect((await at(onTime, Date.now() + 30_000))!.status).toBe(200);
  });

  it("with a host given to HTML embeds, is sent there by the app's host and redeemed there, once", async () => {
    const mint = await allowed();
    const token = await mint();
    const sent = await withEmbedHost(`https://commonink.app/embed-frame/g/${token}`);
    expect([sent.status, sent.headers.get("Location")]).toEqual([302, `https://embed.commonink.app/embed-frame/g/${token}`]);
    const frame = await withEmbedHost(`https://embed.commonink.app/embed-frame/g/${token}`);
    expect(frame.status).toBe(200);
    expect(directives(frame.headers.get("Content-Security-Policy")!)).toMatchObject({ "default-src": "'none'", "script-src": "'unsafe-inline'", "connect-src": SITES.join(" "), "frame-ancestors": "*" });
    expect((await withEmbedHost(`https://embed.commonink.app/embed-frame/g/${token}`)).status).toBe(404);
  });
});

describe("what the app's page may frame", () => {
  it("is the embed's document and the sites built-in embeds frame, and nothing else, in the page's one policy", async () => {
    for (const path of ["/", "/note/plan-3k2j5h8d9f0a", "/settings"]) expect(framedAt(`https://commonink.app${path}`), path).toBe(`https://commonink.app/embed-frame https://commonink.app/embed-frame/g/ ${FRAME_ORIGINS.join(" ")}`);
    expect(framedAt("http://localhost:5173/")).toMatch(/^http:\/\/localhost:5173\/embed-frame /);
    expect(FRAME_ORIGINS.every((origin) => new URL(origin).origin === origin && origin.startsWith("https://"))).toBe(true);
    const sent = await get("https://commonink.app/note/plan-3k2j5h8d9f0a");
    expect(directives(sent.headers.get("Content-Security-Policy")!)["frame-src"]).toBe(`https://commonink.app/embed-frame https://commonink.app/embed-frame/g/ ${FRAME_ORIGINS.join(" ")}`);
  });

  it("is nothing for what isn't a page", async () => {
    expect(directives((await get("https://commonink.app/api/me")).headers.get("Content-Security-Policy")!)["frame-src"]).toBeUndefined();
  });
});

describe("what the app is told of where HTML embeds are served", () => {
  it("is in what /api/me answers: a host of their own only where EMBED_ORIGIN names one", async () => {
    for (const [setUp, embedSite] of [[{}, false], [{ EMBED_ORIGIN: "https://embed.commonink.app" }, true]] as const) {
      const at = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://localhost${path}`, init) as never, { ...env, DEV_SIGN_IN: "1", SESSION_SECRET: "test-secret", ...setUp });
      const signedIn = await at("/auth/dev?email=setup@example.com&name=Setup");
      const cookie = signedIn.headers.get("Set-Cookie")!.split(";")[0]!;
      const me = (await (await at("/api/me", { headers: { Cookie: cookie } })).json()) as { person: unknown; setup: unknown };
      expect([me.person, me.setup]).toEqual([expect.objectContaining({ email: "setup@example.com" }), { embedSite, fileSite: false }]);
    }
  });
});

describe("a host given to HTML embeds alone", () => {
  it("answers with the embed's document and nothing else of the app", async () => {
    const frame = await withEmbedHost("https://embed.commonink.app/embed-frame");
    expect(frame.status).toBe(200);
    expect(directives(frame.headers.get("Content-Security-Policy")!)).toMatchObject({ sandbox: "allow-scripts", "default-src": "'none'", "frame-ancestors": "*" });
    for (const path of ["/", "/health", "/api/me", "/auth/dev?email=a@example.com", "/auth/google/callback", "/mcp", "/note/plan-3k2j5h8d9f0a", "/sw.js", "/api/agents"]) {
      expect((await withEmbedHost(`https://embed.commonink.app${path}`)).status, path).toBe(404);
    }
  });

  it("is where the app's own host sends the frame, and what the app's page may frame", async () => {
    const sent = await withEmbedHost("https://commonink.app/embed-frame");
    expect([sent.status, sent.headers.get("Location")]).toEqual([302, "https://embed.commonink.app/embed-frame"]);
    expect(framedAt("https://commonink.app/", { EMBED_ORIGIN: "https://embed.commonink.app" })).toBe(`https://commonink.app/embed-frame https://commonink.app/embed-frame/g/ https://embed.commonink.app/embed-frame https://embed.commonink.app/embed-frame/g/ ${FRAME_ORIGINS.join(" ")}`);
  });

  it("is production's workers.dev address, which answers nothing of the app's even where a deploy didn't name it, while a Preview's still does", async () => {
    const bare = (url: string) => worker.fetch(new Request(url) as never, { ...env, EMBED_ORIGIN: undefined });
    for (const path of ["/", "/api/me", "/s/x"]) {
      expect((await bare(`https://common-ink-v3.draftox.workers.dev${path}`)).status, path).toBe(404);
    }
    expect((await bare("https://pr-12-common-ink-v3-previews.draftox.workers.dev/api/me")).status).toBe(401);
  });

  it("must be an https address", async () => {
    await expect(worker.fetch(new Request("https://commonink.app/") as never, { ...env, EMBED_ORIGIN: "http://embed.commonink.app" })).rejects.toThrow("EMBED_ORIGIN must be an https address");
  });
});
