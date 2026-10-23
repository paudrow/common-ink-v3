import { expect, type Page } from "@playwright/test";
import { fetched, frameOrigin, perform, showPanel, signInAsNewPerson, test } from "./helpers.ts";
import { frameFor, install, runCommand, toast, turnOn } from "./third-party-helpers.ts";
import { standIns } from "./media-helpers.ts";
import { pdf } from "./pdfs.ts";

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

  for (const path of ["/plugins", "/settings", "/agents", "/history", "/dashboard", "/search", "/todos", "/trash", "/calendar", "/contacts", "/no/such/place"]) {
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

const CONSTRUCTS = [
  "# Drawn $x^2$ heading",
  "",
  "A formula $\\frac{a}{b} + \\sqrt{2}$ in a line, **bold**, ~~gone~~, `code` and [a link](https://example.com).",
  "",
  "$$",
  "\\int_0^1 x\\,dx = \\mathcal{A} + \\mathbf{v}",
  "$$",
  "",
  "- [ ] open",
  "- [x] done",
  "  - nested",
  "",
  "> a quote",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | $y$ |",
  "",
  "```python",
  "def f(x):",
  "    return x + 1",
  "```",
  "",
  "The end.",
].join("\n");

test("formulas, tables, code, tasks and the rest of what a note draws come in under the page's policy, KaTeX's fonts with them", async ({ page }) => {
  const watch = await watchRefusals(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: CONSTRUCTS });
  await page.goto(`/note/${note.id}`);
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor.locator(".katex")).toHaveCount(4);
  await expect(editor.getByRole("table").locator(".katex")).toHaveCount(1);
  await expect(editor.locator(".math-block .katex-display")).toBeVisible();
  await expect(editor.getByRole("table")).toBeVisible();
  await expect(editor.getByRole("checkbox")).toHaveCount(2);
  // Each face these formulas use is loaded, from the app itself.
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded" && f.family.startsWith("KaTeX")).map((f) => f.family);
  });
  expect(faces).toEqual(expect.arrayContaining(["KaTeX_Main", "KaTeX_Math", "KaTeX_Caligraphic", "KaTeX_Size1"]));
  expect(await watch.refused()).toEqual([]);
});

const MEDIA = [
  "# Media",
  "",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "",
  "https://x.com/jack/status/20",
  "",
  "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l",
  "",
  ":::html{height=80}",
  '<p id="ran">HTML ran</p><script>document.getElementById("ran").textContent += " and its script too"</script>',
  ":::",
  "",
  "The end.",
].join("\n");

test("a video's picture and player, posts and an HTML embed are drawn and run under the page's one policy, which frames only them", async ({ page }) => {
  const watch = await watchRefusals(page);
  const played = await standIns(page, { postHeight: 200 });
  // Tall enough that all of it is on screen, so all of it is drawn.
  await page.setViewportSize({ width: 1280, height: 2400 });
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "html.run": "automatically" }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: MEDIA });
  const res = await page.goto(`/note/${note.id}`);
  const policy = res!.headers()["content-security-policy"]!;
  expect(policy.split(",")).toHaveLength(1);
  // The embed's document from the app's own address, and from the host kept for embeds where there is one.
  const hosts = [...new Set([new URL(page.url()).origin, await frameOrigin(page)])];
  const frames = hosts.flatMap((host) => [`${host}/embed-frame`, `${host}/embed-frame/g/`]);
  expect(policy).toContain(`frame-src ${[...frames, "https://www.youtube-nocookie.com", "https://platform.twitter.com", "https://embed.bsky.app"].join(" ")};`);

  const below = (embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
  // The video's picture and its title, from YouTube, then its player once play is pressed.
  await expect(below("video").locator("img.media-poster")).toHaveJSProperty("complete", true);
  await expect.poll(() => below("video").locator("img.media-poster").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await below("video").getByRole("button", { name: "Play video: Stand-in video" }).click();
  await expect.poll(() => played.length).toBe(1);
  await expect.poll(() => page.frames().some((f) => f.url().startsWith("https://www.youtube-nocookie.com/") && f.url() !== "about:blank")).toBe(true);
  // The posts, in their frames.
  await expect.poll(() => page.frames().filter((f) => /platform\.twitter\.com|embed\.bsky\.app/.test(f.url())).length).toBe(2);
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').first().locator("body")).toContainText("post on");
  // The HTML embed, run in its frame.
  await expect(below("html").frameLocator("iframe").frameLocator("iframe").locator("#ran")).toHaveText("HTML ran and its script too");
  expect(await watch.refused()).toEqual([]);
});

test("an HTML embed's document runs its own script and styles under the embed frame's policy, sandboxed, and can fetch nothing", async ({ page, baseURL }) => {
  const watch = await watchRefusals(page);
  // Main has no embed document yet, so the Worker's answer for its address is given an embed's body, keeping every header the Worker sent.
  await page.route("**/embed-frame", async (route) => {
    const sent = await fetched(route);
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
  // Framed by the app alone on its own address. A host kept for embeds answers nothing else, and is framed by whoever frames it.
  expect(policy).toContain((await frameOrigin(page)) === new URL(baseURL!).origin ? "frame-ancestors 'self'" : "frame-ancestors *");
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

test("a PDF is drawn by pdf.js under the page's policy, in a note and over the app, its library and its worker the app's own", async ({ page, baseURL }) => {
  const watch = await watchRefusals(page);
  const loaded: string[] = [];
  page.on("request", (request) => /pdf/i.test(new URL(request.url()).pathname) && loaded.push(request.url()));
  await signInAsNewPerson(page, "Ada Lovelace");
  const sent = await page.evaluate(async (base64) => {
    const id = (await (await fetch("/api/me")).json()).workspaces[0].id;
    const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "paper.pdf" })) }, body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) });
    return ((await res.json()) as { id: string }).id;
  }, pdf({ pages: 2, script: "app.alert('ran')" }).toString("base64"));
  const note = await perform(page, { type: "note.create", text: `# Paper\n\n::file{${sent}}\n\nThe end.` });
  await page.goto(`/note/${note.id}`);
  const card = page.locator('.embed-below[data-embed="file"]');
  await expect(card.locator("canvas")).toHaveCount(2);
  await expect(card.locator(".upload-card-head")).toContainText("2 pages");
  await card.getByRole("button", { name: "Preview paper.pdf" }).click();
  await expect(page.getByRole("dialog", { name: "Preview of paper.pdf" }).locator("canvas")).toHaveCount(2);
  expect(loaded.some((url) => /pdf\.worker/.test(url)), "its worker was loaded").toBe(true);
  expect(loaded.filter((url) => !url.startsWith(baseURL!)), "from the app's own address").toEqual([]);
  expect(await watch.refused()).toEqual([]);
});

test("a drawing is edited in Excalidraw and saved under the page's policy, Excalidraw and its fonts from the app's own address", async ({ page, baseURL }) => {
  const watch = await watchRefusals(page);
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(request.url()));
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n::drawing{}\n\nThe end." });
  await page.goto(`/note/${note.id}`);
  await page.getByRole("button", { name: "Edit drawing" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Drawing" });
  await editor.getByTitle(/^Text /).click();
  const canvas = (await editor.locator("canvas.interactive").boundingBox())!;
  await page.mouse.click(canvas.x + 400, canvas.y + 250);
  await page.keyboard.type("Hello 你好");
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.embed-below[data-embed="drawing"] img')).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(loaded.some((url) => /\/fonts\/Excalifont\//.test(url)), "the words' font was loaded").toBe(true);
  expect(loaded.some((url) => /\/fonts\/Xiaolai\//.test(url)), "and the font of the words in Chinese").toBe(true);
  const frames = await frameOrigin(page);
  expect(loaded.filter((url) => !url.startsWith(baseURL!) && !url.startsWith(`${frames}/embed-frame`) && !url.startsWith("data:")), "from the app's own address, or the frames' own").toEqual([]);
  expect(await watch.refused()).toEqual([]);
});

test("an upload's bytes keep their own sealed policy under the page's, in place or as a download, and a refusal is no page either", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const sealed = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
  const sent = (name: string, text: string) =>
    page.evaluate(
      async ({ name, text }) => {
        const id = (await (await fetch("/api/me")).json()).workspaces[0].id;
        const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) }, body: text });
        return { workspaceId: id as string, id: ((await res.json()) as { id: string }).id };
      },
      { name, text },
    );
  const pdf = await sent("paper.pdf", "%PDF-1.4\n%%EOF\n");
  const gif = await sent("dot.gif", "GIF89a\x01\x00\x01\x00\x00\x00\x00;");
  const html = await sent("page.html", "<script>alert(1)</script>");
  const headers = async (path: string) => {
    const res = await page.request.get(path);
    const h = res.headers();
    return [res.status(), h["content-security-policy"], h["content-disposition"]?.split(";")[0], h["x-content-type-options"], h["cross-origin-resource-policy"]];
  };
  // A picture is shown in place; a PDF, with no site kept for files, is a download.
  expect(await headers(`/api/workspaces/${gif.workspaceId}/uploads/${gif.id}`)).toEqual([200, sealed, "inline", "nosniff", "same-origin"]);
  expect(await headers(`/api/workspaces/${pdf.workspaceId}/uploads/${pdf.id}`)).toEqual([200, sealed, "attachment", "nosniff", "same-origin"]);
  expect(await headers(`/api/workspaces/${html.workspaceId}/uploads/${html.id}`)).toEqual([200, sealed, "attachment", "nosniff", "same-origin"]);
  const missing = await headers(`/api/workspaces/${pdf.workspaceId}/uploads/zzzzzzzzzzzz`);
  expect(missing.slice(0, 2)).toEqual([404, "default-src 'none'; frame-ancestors 'none'"]);
});

const SAYS = `
const say = (text) => { const p = document.createElement("p"); p.className = "said"; p.textContent = text; ink.root.append(p); };
ink.onCommand("hello", () => ink.notify("Hello from a frame"));
if (ink.context.kind === "view") say("A " + ink.context.slot + " view");
if (ink.context.kind === "embed") say("An embed");
`;

test("a workspace's plugins run under the same policy: shut off in frames, and with full trust in the page, refused nothing", async ({ page }) => {
  const watch = await watchRefusals(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  await install(
    page,
    {
      name: "Framed",
      description: "Draws in every place a frame goes.",
      capabilities: [{ name: "notes.read", reason: "To say which note it is in." }],
      commands: [{ id: "hello", title: "Say hello" }],
      views: [
        { slot: "inspector", id: "side", label: "Side" },
        { slot: "page", id: "whole", label: "Whole" },
        { slot: "bar", id: "low", label: "Low", width: 120 },
      ],
      embeds: [{ name: "boxed", title: "Boxed", height: 60 }],
    },
    SAYS,
    ["notes.read"],
  );
  await turnOn(page, "Framed");
  // Full trust: granted for this code, and turned on by Ada, it runs in the page itself.
  const code = "window.trustedRan = true; host.commands.register({ id: 'deep.hello', title: 'Deep hello', run: () => host.app().notify({ message: 'Hello from the page' }) });";
  const { id, plugins } = await perform(page, { type: "plugin.install", manifest: JSON.stringify({ name: "Deep", capabilities: [{ name: "full-trust", reason: "To run in the page." }] }), code });
  const codeHash = plugins.find((p) => p.id === id)!.codeHash!;
  await perform(page, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash });
  await perform(page, { type: "plugin.trust", id, on: true, codeHash });
  // And on in her settings, as the plugin's own switch leaves it.
  const settings = await perform(page, { type: "settings.read" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ ...JSON.parse(settings.text || "{}"), [`${id}.enabled`]: true }), baseRevision: settings.revision });

  const note = await perform(page, { type: "note.create", text: "# Framed\n\n::x-boxed{}\n\nend" });
  await page.goto(`/note/${note.id}`);
  await expect((await frameFor(page, "embed", "boxed")).locator(".said")).toHaveText("An embed");
  await expect((await frameFor(page, "view", "low")).locator(".said")).toHaveText("A bar view");
  await showPanel(page, "Framed plugin: Side");
  await expect((await frameFor(page, "view", "side")).locator(".said")).toHaveText("A inspector view");
  await runCommand(page, "Framed plugin: Say hello");
  await expect(toast(page)).toContainText("Hello from a frame");
  await expect.poll(() => page.evaluate(() => (window as unknown as { trustedRan?: boolean }).trustedRan ?? false)).toBe(true);
  await runCommand(page, "Deep hello");
  await expect(toast(page)).toContainText("Hello from the page");
  await page.goto(`/x/${(await perform(page, { type: "plugin.list" })).plugins.find((p) => p.manifest.name === "Framed")!.id}/whole`);
  await expect((await frameFor(page, "view", "whole")).locator(".said")).toHaveText("A page view");
  expect(await watch.refused()).toEqual([]);
});
