import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { unpackedExtensionId } from "../../scripts/extension-id.ts";
import { agentWith, signInAsNewPerson } from "./helpers.ts";

// The dev server allows the unpacked clipper, whose id the key in extension/manifest.json fixes.
const EXTENSION = unpackedExtensionId();
const RETURN = `https://${EXTENSION}.chromiumapp.org/`;

test("Allow sends the browser back to the clipper with its token, which Settings revokes", async ({ page }) => {
  await signInAsNewPerson(page, "Clip Allower");
  await page.goto(`/clipper/connect?${new URLSearchParams({ redirect: RETURN })}`);
  await expect(page.getByText(`Extension ID ${EXTENSION}`)).toBeVisible();
  // page.route doesn't see a redirect's request, and chromiumapp.org resolves nowhere: that the browser sets off for it shows form-action let it go.
  const allowed = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/clipper/connect");
  const sent = page.waitForRequest((req) => req.isNavigationRequest() && new URL(req.url()).origin === new URL(RETURN).origin);
  await page.getByRole("button", { name: "Allow" }).click();
  const back = new URL((await allowed).headers()["location"] ?? "https://invalid/");
  expect((await sent).url()).toBe(RETURN);
  const token = new URLSearchParams(back.hash.slice(1)).get("token") ?? "";
  expect(`${back.origin}/`).toBe(RETURN);
  expect(token).toMatch(/^cink_[A-Za-z0-9_-]{43}$/);

  const clipper = agentWith(page, token);
  expect(await clipper.status()).toBe(200);
  await expect(clipper.tool("list_notes", {})).rejects.toThrow(/^forbidden: /);

  await page.goto("/settings/account");
  const row = page.getByLabel("Clipper");
  await expect(row.getByText(EXTENSION)).toBeVisible();
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByText("No clipper is signed in.")).toBeVisible();
  expect(await clipper.status()).toBe(401);
});

test("an extension that isn't the clipper can't sign in", async ({ page }) => {
  await signInAsNewPerson(page, "Clip Refuser");
  const other = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/";
  const answer = await page.goto(`/clipper/connect?${new URLSearchParams({ redirect: other })}`);
  expect(answer?.status()).toBe(400);
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
});

test("the dev server offers the clipper as a zip to load unpacked, and a deploy does not", async ({ page }) => {
  await signInAsNewPerson(page, "Clip Tester");
  await page.goto("/settings/account");
  const row = page.getByLabel("Clipper");
  await expect(row.getByText("No clipper is signed in.")).toBeVisible();
  if (process.env.BASE_URL) {
    await expect(row.getByRole("link", { name: "Download" })).toHaveCount(0);
    const answer = await page.request.get("/dev/clipper.zip");
    expect(answer.headers()["content-type"]).not.toBe("application/zip");
    expect((await answer.body()).subarray(0, 2).toString()).not.toBe("PK");
    return;
  }
  await expect(row.getByText("Load unpacked")).toBeVisible();
  const download = page.waitForEvent("download");
  await row.getByRole("link", { name: "Download" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("common-ink-clipper-0.1.0.zip");
  const dir = mkdtempSync(path.join(tmpdir(), "clipper-download-"));
  await file.saveAs(path.join(dir, "clipper.zip"));
  execFileSync("unzip", ["-q", "clipper.zip", "-d", "out"], { cwd: dir });
  expect(unpackedExtensionId(path.join(dir, "out/manifest.json"))).toBe(EXTENSION);
  expect(readFileSync(path.join(dir, "out/manifest.json"), "utf8")).toBe(readFileSync("extension/manifest.json", "utf8"));
});

const article = `<!doctype html>
<html>
  <head><title>Harbor lights</title></head>
  <body>
    <header><nav>Site navigation Home</nav></header>
    <aside class="sidebar">Related stories</aside>
    <div class="cookie-banner">Cookie banner Accept</div>
    <article>
      <h1>Harbor lights</h1>
      <p>The council kept the harbor lights on through winter.</p>
      <ul>
        <li><input type="checkbox" checked> Lamps</li>
        <li><input type="checkbox"> Buoys</li>
      </ul>
    </article>
    <footer>Copyright footer</footer>
  </body>
</html>`;

test("clips a page into a note", async ({ baseURL }) => {
  test.setTimeout(90_000);
  execFileSync("node", ["--experimental-strip-types", "extension/build.ts"], { stdio: "inherit" });
  const extension = path.resolve("extension/dist");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(article);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("The article server did not bind.");
  const pageUrl = `http://127.0.0.1:${bound.port}/harbor`;
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "clipper-")), {
    // Playwright's own headless flag is the old headless, which does not load extensions. New headless does.
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    expect(extensionId).toBe(EXTENSION);
    const app = await context.newPage();
    await app.goto(`${baseURL}/auth/dev?${new URLSearchParams({ email: `clipper-${crypto.randomUUID()}@example.com`, name: "Clip Tester" })}`);
    const token = await app.evaluate(async () => {
      const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Clipper" }) });
      const body = (await res.json()) as { token?: string; message?: string };
      if (!res.ok || !body.token) throw new Error(body.message || "No token.");
      return body.token;
    });
    const story = await context.newPage();
    await story.goto(pageUrl);
    await story.waitForFunction(() => document.title === "Harbor lights");
    const tabs = await worker.evaluate(async () => {
      const browser = (globalThis as unknown as { chrome: { tabs: { query(query: Record<string, never>): Promise<{ id?: number; url?: string }[]> } } }).chrome;
      return browser.tabs.query({});
    });
    const tabId = tabs.find((tab) => tab.url === pageUrl)?.id;
    if (tabId == null) throw new Error(`No tab for ${pageUrl}`);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#host").fill(baseURL ?? "");
    await popup.getByText("Paste a token").click();
    await popup.locator("#token").fill(token);
    await popup.getByRole("button", { name: "Use token" }).click();
    await expect(popup.getByText("Signed in as Clip Tester")).toBeVisible();
    await popup.evaluate((id) => {
      const browser = (globalThis as unknown as { chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } } }).chrome;
      return browser.runtime.sendMessage({ type: "capture", mode: "page", tabId: id });
    }, tabId);
    const save = popup.getByRole("button", { name: "Save" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(popup.getByText("Saved.")).toBeVisible();
    const href = await popup.locator("a").getAttribute("href");
    const noteId = href?.match(/([a-z0-9]{12})$/)?.[1];
    expect(noteId).toBeTruthy();
    const read = await context.request.post(`${baseURL}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { noteId } } },
    });
    const body = (await read.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    const payload = body.result?.content?.[0]?.text ?? "";
    expect(body.result?.isError, payload).toBeFalsy();
    const text = (JSON.parse(payload) as { text: string }).text;
    expect(text).toContain("# Harbor lights");
    expect(text).toContain("The council kept the harbor lights on through winter.");
    expect(text).toContain("- Lamps");
    expect(text).toContain("- Buoys");
    expect(text).not.toContain("[ ]");
    expect(text).not.toContain("[x]");
    expect(text).not.toContain("Site navigation");
    expect(text).not.toContain("Related stories");
    expect(text).not.toContain("Cookie banner");
    expect(text).not.toContain("Copyright footer");
    expect(text).toContain(pageUrl);
  } finally {
    await context.close();
    server.close();
  }
});
