import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { redirectFor } from "../../src/worker/hosts.ts";

const get = (url: string, init?: RequestInit) => SELF.fetch(url, { redirect: "manual", ...init });

describe("www goes to the apex", () => {
  it("answers 301, keeping the path and query", () => {
    for (const [from, to] of [
      ["https://www.commonink.app/", "https://commonink.app/"],
      ["https://www.commonink.app/note/abc?x=1&y=2", "https://commonink.app/note/abc?x=1&y=2"],
      ["https://www.commonink.app/auth/google?next=%2Fnote%2Fabc", "https://commonink.app/auth/google?next=%2Fnote%2Fabc"],
      ["https://www.commonink.app/api/me", "https://commonink.app/api/me"],
      ["https://www.commonink.app/sw.js", "https://commonink.app/sw.js"],
    ] as const) {
      expect(redirectFor(new URL(from)), from).toEqual({ location: to, status: 301 });
    }
  });

  it("is what the Worker answers, before sign-in and before the app's page", async () => {
    for (const path of ["/", "/note/abc?x=1", "/api/me", "/auth/google?next=%2F"]) {
      const res = await get(`https://www.commonink.app${path}`);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location"), path).toBe(`https://commonink.app${path}`);
    }
  });

  it("applies to POSTs too, so nothing is handled on www", async () => {
    const res = await get("https://www.commonink.app/api/workspaces/aaaaaaaaaaaa/ops", { method: "POST", body: "{}" });
    expect(res.status).toBe(301);
  });
});

describe("other hosts answer for themselves", () => {
  it("never redirects", async () => {
    for (const url of [
      "https://commonink.app/",
      "https://commonink.app/note/abc?x=1",
      "https://v3.commonink.app/",
      "https://v2.commonink.app/",
      "https://www.example.com/",
      "https://wwwcommonink.app/",
      "https://notwww.commonink.app/",
      "https://pr-12-common-ink-v3.draftox.workers.dev/",
      "https://common-ink-v3.draftox.workers.dev/?x=1",
      "http://localhost:5173/",
    ]) {
      expect(redirectFor(new URL(url)), url).toBeNull();
    }
    for (const url of ["https://commonink.app/api/me", "https://v3.commonink.app/api/me", "https://pr-12-common-ink-v3.draftox.workers.dev/api/me"]) {
      const res = await get(url);
      expect(res.status, url).toBe(401);
      expect(res.headers.get("Location"), url).toBeNull();
    }
  });

  it("leaves the old v1 paths to the app (v1 links are deliberately not redirected)", async () => {
    for (const path of ["/s/abc", "/notes", "/privacy.html", "/terms"]) {
      expect((await get(`https://commonink.app${path}`)).status, path).not.toBe(302);
    }
  });
});

describe("/sw.js retires the service worker v2 left behind", () => {
  for (const host of ["commonink.app", "v3.commonink.app", "pr-12-common-ink-v3.draftox.workers.dev"]) {
    it(`is JavaScript, never kept, on ${host}`, async () => {
      const res = await get(`https://${host}/sw.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^(text|application)\/javascript/);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  }

  it("deletes the v2 cache and unregisters itself, and is not the app's page", async () => {
    const body = await (await get("https://commonink.app/sw.js")).text();
    expect(body).not.toMatch(/<html/i);
    expect(body).toContain('.delete("common-ink-app-v1")');
    expect(body).toContain("self.registration.unregister()");
    expect(body).toContain("skipWaiting");
    expect(body).not.toContain("addEventListener(\"fetch\"");
  });

  it("answers HEAD the same way", async () => {
    const res = await get("https://commonink.app/sw.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/javascript/);
  });

  it("is only /sw.js", async () => {
    const res = await get("https://commonink.app/sw.js/other");
    expect(res.headers.get("Content-Type") ?? "").not.toMatch(/javascript/);
  });
});
