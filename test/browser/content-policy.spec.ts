import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

/** Every report of something the page's policy refused, from every document the page loads, and the console's word on any. */
async function watchRefusals(page: Page) {
  const refused: string[] = [];
  await page.exposeFunction("__refused__", (report: string) => refused.push(report));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __refused__(report: string): void }).__refused__(`${e.effectiveDirective} ${e.blockedURI}`)),
  );
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) refused.push(message.text());
  });
  return {
    /** What was refused, once a frame and a moment have gone by for a report to arrive. */
    async refused() {
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));
      return [...refused];
    },
  };
}

const NOTE = "# Policy\n\nTea ::timer{5m} and ::stopwatch{} here.\n\n:::kanban{}\n## To do\n- write\n\n## Done\n:::\n\nThe end.";

test("the app's pages draw and run under the policy the Worker sends, and it refuses what isn't the app's own", async ({ page }) => {
  const watch = await watchRefusals(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: NOTE });

  const res = await page.goto(`/note/${note.id}`);
  expect(res!.headers()["content-security-policy"]).toContain("script-src 'self'");
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor.getByRole("region", { name: "Done", exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();
  // CodeMirror's styles are in, and the icons drawn as data: masks show.
  await expect(page.locator(".cm-editor")).toHaveCSS("display", "flex");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("i");
  await page.keyboard.type(" /");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  for (const path of ["/plugins", "/settings", "/agents", "/history", "/dashboard", "/no/such/place"]) {
    await page.goto(path);
    await expect(page.locator("#root")).not.toBeEmpty();
  }
  await page.goto("/auth/google");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await watch.refused()).toEqual([]);

  // The policy is enforced, and a refusal is seen when there is one.
  await page.goto("/settings");
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.src = "https://example.com/pixel.png";
    document.body.append(img);
  });
  await expect.poll(() => watch.refused()).toContainEqual("img-src https://example.com/pixel.png");
});

test("an HTML embed's document runs its own script and styles under the embed frame's policy, sandboxed, and can fetch nothing", async ({ page }) => {
  const watch = await watchRefusals(page);
  // Main has no embed document yet, so the Worker's answer for its address is given an embed's body, keeping every header the Worker sent.
  await page.route("**/embed-frame", async (route) => {
    const sent = await route.fetch();
    const body = `<!doctype html><meta charset="utf-8"><style>body { color: rgb(1, 2, 3) }</style><body><p id="said">waiting</p><img alt="dot" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="><script>
      document.getElementById("said").textContent = "ran in " + origin;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = "<p>inner</p><script>parent.postMessage('inner ran', '*')<\\/script>";
      addEventListener("message", (e) => (document.getElementById("said").textContent += ", " + e.data));
      document.body.append(frame);
    </script>`;
    await route.fulfill({ status: 200, headers: sent.headers(), body });
  });

  const res = await page.goto("/embed-frame");
  const policy = res!.headers()["content-security-policy"]!;
  expect(policy).toContain("sandbox allow-scripts");
  expect(policy).toContain("frame-ancestors 'self'");
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator("#said")).toHaveText("ran in null, inner ran");
  await expect(page.locator("body")).toHaveCSS("color", "rgb(1, 2, 3)");
  expect(await watch.refused()).toEqual([]);

  // Its origin is its own, and nothing can be fetched from it, the app's own address included.
  expect(await page.evaluate(() => { try { return localStorage.length; } catch { return "no storage"; } })).toBe("no storage");
  await page.evaluate(() => fetch("/api/me").catch(() => null));
  await expect.poll(() => watch.refused()).toContainEqual(expect.stringMatching(/^connect-src .*\/api\/me$/));
});

test("each kind of address gets its own policy, and all of them nosniff and a referrer rule", async ({ request }) => {
  const headers = async (path: string) => (await request.get(path, { maxRedirects: 0 })).headers();
  for (const path of ["/", "/note/abcdefghijkl", "/settings", "/auth/google", "/sw.js"]) {
    const h = await headers(path);
    expect([path, h["content-security-policy"]]).toEqual([path, expect.stringContaining("default-src 'none'; script-src 'self'")]);
    expect([path, h["content-security-policy"]]).toEqual([path, expect.stringContaining("frame-ancestors 'none'")]);
    expect([path, h["x-content-type-options"], h["referrer-policy"]]).toEqual([path, "nosniff", "strict-origin-when-cross-origin"]);
  }
  for (const path of ["/api/me", "/api/agents", "/mcp"]) {
    const h = await headers(path);
    expect([path, h["content-security-policy"], h["x-content-type-options"]]).toEqual([path, "default-src 'none'; frame-ancestors 'none'", "nosniff"]);
  }
});
