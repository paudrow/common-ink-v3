import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { embedPolicy, FRAME_ORIGINS } from "../../src/worker/frames.ts";
import { secured } from "../../src/worker/headers.ts";

const get = (url: string) => SELF.fetch(url, { redirect: "manual" });
const directives = (policy: string) => Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")]));
/** What the page at `url` may frame, from the one policy the Worker sends it. */
const framedAt = (url: string, env: { EMBED_ORIGIN?: string } = {}) => {
  const policies = secured(new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }), new URL(url), env).headers.get("Content-Security-Policy")!;
  expect(policies).not.toContain(",");
  return directives(policies)["frame-src"];
};
const withEmbedHost = (url: string) => worker.fetch(new Request(url) as never, { ...env, EMBED_ORIGIN: "https://embed.commonink.app" });

describe("the document an HTML embed is written into", () => {
  it("is served with an origin of its own and no network, whoever frames it and however", async () => {
    for (const host of ["https://commonink.app", "https://pr-12-common-ink-v3.draftox.workers.dev", "http://localhost:5173"]) {
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

  it("holds nothing of any note or member: it is the same for everyone, signed in or not", async () => {
    const [one, other] = [await get("https://commonink.app/embed-frame"), await SELF.fetch("https://commonink.app/embed-frame", { headers: { Cookie: "session=anything" } })];
    expect(await one.text()).toBe(await other.text());
  });

  it("has one switch for the network, which is off", () => {
    const off = directives(embedPolicy({ network: false, ancestors: "'self'" }));
    const on = directives(embedPolicy({ network: true, ancestors: "'self'" }));
    expect(off["default-src"]).toBe("'none'");
    expect(off["connect-src"]).toBeUndefined();
    expect(on["connect-src"]).toBe("https: wss:");
    // Either way it keeps an origin of its own, and can't send a form or be given another base.
    // And its frame can be sent nowhere: a grant of the network is not a grant to leave.
    for (const policy of [off, on]) expect([policy.sandbox, policy["frame-src"], policy["form-action"], policy["base-uri"]]).toEqual(["allow-scripts", "'none'", "'none'", "'none'"]);
  });
});

describe("what the app's page may frame", () => {
  it("is the embed's document and the sites built-in embeds frame, and nothing else, in the page's one policy", async () => {
    for (const path of ["/", "/note/plan-3k2j5h8d9f0a", "/settings"]) expect(framedAt(`https://commonink.app${path}`), path).toBe(`https://commonink.app/embed-frame ${FRAME_ORIGINS.join(" ")}`);
    expect(framedAt("http://localhost:5173/")).toMatch(/^http:\/\/localhost:5173\/embed-frame /);
    expect(FRAME_ORIGINS.every((origin) => new URL(origin).origin === origin && origin.startsWith("https://"))).toBe(true);
    const sent = await get("https://commonink.app/note/plan-3k2j5h8d9f0a");
    expect(directives(sent.headers.get("Content-Security-Policy")!)["frame-src"]).toBe(`https://commonink.app/embed-frame ${FRAME_ORIGINS.join(" ")}`);
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
    for (const path of ["/", "/api/me", "/auth/dev?email=a@example.com", "/mcp", "/note/plan-3k2j5h8d9f0a", "/sw.js", "/api/agents"]) {
      expect((await withEmbedHost(`https://embed.commonink.app${path}`)).status, path).toBe(404);
    }
  });

  it("is where the app's own host sends the frame, and what the app's page may frame", async () => {
    const sent = await withEmbedHost("https://commonink.app/embed-frame");
    expect([sent.status, sent.headers.get("Location")]).toEqual([302, "https://embed.commonink.app/embed-frame"]);
    expect(framedAt("https://commonink.app/", { EMBED_ORIGIN: "https://embed.commonink.app" })).toBe(`https://commonink.app/embed-frame https://embed.commonink.app/embed-frame ${FRAME_ORIGINS.join(" ")}`);
  });

  it("must be an https address", async () => {
    await expect(worker.fetch(new Request("https://commonink.app/") as never, { ...env, EMBED_ORIGIN: "http://embed.commonink.app" })).rejects.toThrow("EMBED_ORIGIN must be an https address");
  });
});
