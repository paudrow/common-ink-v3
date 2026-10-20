import { expect } from "@playwright/test";
import { test } from "./helpers.ts";

const DATA = "default-src 'none'; frame-ancestors 'none'";

/*
 * The built files under /assets/ are served without the Worker, by public/_headers. Everything else
 * passes the Worker, which src/worker/headers.ts sets for every answer. Vite's dev server serves no
 * /assets/, so this asks only a built Worker: a Preview, or scripts that serve one.
 */
test("every file the app is built into is sent with nosniff, a referrer rule and a policy", async ({ request }) => {
  const page = await request.get("/");
  const built = [...new Set([...(await page.text()).matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]!))];
  test.skip(built.length === 0, "Vite's dev server serves no built files");

  const sent: Record<string, (string | undefined)[]> = {};
  for (const path of [...built, "/favicon.svg", "/favicon.ico", "/site.webmanifest", "/icon-192.png", "/no-eval.js"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const headers = res.headers();
    sent[path] = [headers["x-content-type-options"], headers["referrer-policy"], headers["content-security-policy"]?.split(";")[0]];
  }
  expect(Object.values(sent).every(([nosniff, referrer, policy]) => nosniff === "nosniff" && referrer === "strict-origin-when-cross-origin" && policy === "default-src 'none'"), JSON.stringify(sent, null, 1)).toBe(true);
  for (const path of built) expect((await request.get(path)).headers()["content-security-policy"], path).toBe(DATA);
  expect(built.some((path) => path.endsWith(".js")) && built.some((path) => path.endsWith(".css"))).toBe(true);
  expect(await (await request.get("/_headers")).text(), "the rules aren't served as a file").not.toContain("X-Content-Type-Options");
});
