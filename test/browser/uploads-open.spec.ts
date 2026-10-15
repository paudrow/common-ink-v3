import { expect, test, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { anotherPerson, join, perform, signInAsNewPerson } from "./helpers.ts";

// Chromium as it ships, with its own PDF viewer, which the headless shell Playwright starts by default doesn't have.
test.use({ channel: "chromium" });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const filePage = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const fileText = (page: Page) => page.getByRole("textbox", { name: "File text" });
const UNAVAILABLE = "This file isn't available";

/** Sends a file as the signed-in person, the way the app does, to their first workspace. */
function send(page: Page, name: string, bytes: Buffer, more: { private?: boolean } = {}): Promise<Upload> {
  return page.evaluate(
    async ({ name, base64, more }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name, ...more })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, base64: bytes.toString("base64"), more },
  );
}

const workspaceOf = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/me")).json()) as Me)).workspaces[0]!.id;

async function noteWith(page: Page, text: string) {
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("after");
  return note;
}

test("a text file's chip opens it in the app to be read, with who uploaded it, its size, Download and Copy into a new note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "minutes.txt", Buffer.from("What was said.\nWhat was done.\n"));
  await noteWith(page, `# Meeting\n\nSee ::file{${upload.id}} for it.\n\nafter\n`);

  const chip = editor(page).getByRole("link", { name: "minutes.txt" });
  await expect(chip).toHaveAttribute("href", `/file/${upload.id}`);
  await expect(chip).not.toHaveAttribute("download");
  await chip.click();
  await expect(page).toHaveURL(`/file/${upload.id}`);
  const shown = filePage(page, "minutes.txt");
  await expect(shown.getByRole("heading", { level: 1 })).toHaveText("minutes.txt");
  await expect(shown).toContainText("Uploaded by Ada Lovelace");
  await expect(shown).toContainText("30 bytes");
  await expect(shown).toContainText("Read only: a file you upload isn't changed here.");
  await expect(fileText(page)).toHaveText("What was said.What was done.");
  await expect(fileText(page)).toHaveAttribute("aria-readonly", "true");
  await fileText(page).click();
  await page.keyboard.type("changed");
  await expect(fileText(page)).toHaveText("What was said.What was done.");

  const download = shown.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("download", "minutes.txt");
  await expect(download).toHaveAttribute("href", `/api/workspaces/${await workspaceOf(page)}/uploads/${upload.id}`);

  await shown.getByRole("button", { name: "Copy into a new note" }).click();
  await expect(editor(page)).toContainText("What was said.");
  const copied = await perform(page, { type: "note.read", id: /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]! });
  expect(copied.text).toBe("What was said.\nWhat was done.\n");
});

test("the chip is reached with the keyboard, and Enter on it opens the file", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "plan.md", Buffer.from("# The plan\n\nGo **now**.\n"));
  await noteWith(page, `# Plans\n\n::file{${upload.id}}\n\nafter\n`);
  await editor(page).getByRole("link", { name: "plan.md" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/file/${upload.id}`);
  await expect(filePage(page, "plan.md")).toBeVisible();
});

test("markdown is drawn as a note is, a CSV is a table, JSON is coloured code, and text that isn't UTF-8 offers only Download", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const md = await send(page, "notes.md", Buffer.from("# Heading here\n\nSome **bold** words.\n\n- [ ] a task\n"));
  const csv = await send(page, "people.csv", Buffer.from('name,quote\r\nAda,"says ""hi"", then leaves"\r\nBob,"two\nlines"\r\nCy\r\n'));
  const json = await send(page, "data.json", Buffer.from('{\n  "name": "Ada",\n  "count": 3\n}\n'));
  const binary = await send(page, "photo.txt", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]));

  await page.goto(`/file/${md.id}`);
  const drawn = filePage(page, "notes.md");
  const lines = drawn.locator(".cm-line");
  await expect(lines.nth(0)).toContainText("Heading here");
  await expect.poll(() => lines.nth(2).evaluate((line) => (line as HTMLElement).innerText)).toBe("Some bold words.");
  const [heading, words] = [await lines.nth(0).boundingBox(), await lines.nth(2).boundingBox()];
  expect(heading!.height).toBeGreaterThan(words!.height * 1.3);
  await expect(drawn.getByRole("checkbox")).toHaveCount(1);
  await expect(drawn.getByRole("button", { name: "Copy into a new note" })).toBeVisible();

  await page.goto(`/file/${csv.id}`);
  const table = filePage(page, "people.csv").getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["name", "quote"]);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["Ada", 'says "hi", then leaves']);
  await expect(table.locator("tbody tr").nth(1).getByRole("cell")).toHaveText(["Bob", "two\nlines"]);
  await expect(table.locator("tbody tr").nth(2).getByRole("cell")).toHaveText(["Cy", ""]);

  await page.goto(`/file/${json.id}`);
  await expect(fileText(page)).toContainText('"name": "Ada"');
  await expect.poll(() => fileText(page).locator(".tok-propertyName").count()).toBe(2);
  await expect(fileText(page).locator(".tok-number")).toHaveText("3");

  await page.goto(`/file/${binary.id}`);
  const notText = filePage(page, "photo.txt");
  await expect(notText).toContainText("This file isn't text, so it can't be shown here.");
  await expect(notText.getByRole("link", { name: "Download" })).toBeVisible();
  await expect(notText.getByRole("button", { name: "Copy into a new note" })).toHaveCount(0);
  await expect(fileText(page)).toHaveCount(0);
});

test("HTML in an uploaded markdown file waits for Run, even for a member whose HTML runs by itself, and then runs shut off from the app", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "html.run": "automatically" }), baseRevision: 0 });
  const upload = await send(page, "page.md", Buffer.from(':::html{height=80}\n<p id="ran">ran</p><script>document.getElementById("ran").textContent = "ran in " + origin; try { parent.localStorage.setItem("marked", "md") } catch {}</script>\n:::\n\nafter\n'));
  await page.goto(`/file/${upload.id}`);
  const shown = filePage(page, "page.md");
  const run = shown.getByRole("button", { name: /Run HTML/ });
  await expect(run).toBeVisible();
  await expect(shown.locator("iframe")).toHaveCount(0);
  await run.click();
  await expect(shown.frameLocator("iframe").frameLocator("iframe").locator("#ran")).toHaveText("ran in null");
  expect(await page.evaluate(() => localStorage.getItem("marked"))).toBeNull();
});

test("a picture's chip opens it in a preview over the app, which Escape closes, giving the keyboard back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGOIjr4GRAAJ5QMZ8KRTiAAAAABJRU5ErkJggg==", "base64");
  const picture = await send(page, "dot.png", png);
  await noteWith(page, `# Look\n\nSee ::file{${picture.id}} here.\n\nafter\n`);

  const chip = editor(page).getByRole("link", { name: "dot.png" });
  await expect(chip).not.toHaveAttribute("download");
  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Preview of dot.png" });
  await expect.poll(() => dialog.getByRole("img", { name: "dot.png" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  await expect(dialog.getByRole("button", { name: "Close preview" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The keyboard is back in the note, on the chip it was opened from.
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[aria-label="Note text"]') != null)).toBe(true);
});

test("a CSV of very wide rows is drawn cut to 50 columns and 20,000 cells, and says so, so it can't freeze the page", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const wide = await send(page, "wide.csv", Buffer.from(`${",".repeat(4999)}\n${"x\n".repeat(300)}`));
  await page.goto(`/file/${wide.id}`);
  const table = filePage(page, "wide.csv").locator("table");
  await expect(table.locator("thead th")).toHaveCount(50);
  expect(await table.locator("th, td").count()).toBeLessThanOrEqual(20_000);
  await expect(filePage(page, "wide.csv")).toContainText("Showing the first 50 columns.");
});

test("a long file shows only its first 2 MB, asked for as that much and no more, and isn't offered as a note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "server.log", Buffer.from("a line of the log\n".repeat(185_000)));
  expect(upload.size).toBe(3_330_000);
  const asked: (string | null)[] = [];
  page.on("request", (request) => request.url().endsWith(`/uploads/${upload.id}`) && asked.push(request.headers()["range"] ?? null));

  await page.goto(`/file/${upload.id}`);
  const shown = filePage(page, "server.log");
  await expect(shown).toContainText("This is its first 2 MB of 3.2 MB.");
  await expect(fileText(page)).toContainText("a line of the log");
  await expect(shown.getByRole("button", { name: "Copy into a new note" })).toHaveCount(0);
  // Asked once in a build, and twice in development, where React runs each effect twice.
  expect([...new Set(asked)]).toEqual(["bytes=0-2097151"]);
});

test("a file the member can't see and one that isn't there are the same words, with nothing of the file, and its bytes are never sent", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Editor");
  await join(bob, page, "editor");
  const secret = await send(page, "salaries-2026.csv", Buffer.from("name,pay\nAda,100\n"), { private: true });

  const answered: [string, number][] = [];
  bob.on("response", (response) => /\/api\/.*\/uploads\//.test(response.url()) && answered.push([new URL(response.url()).pathname.split("/").at(-1)!, response.status()]));
  await bob.goto(`/file/${secret.id}`);
  await expect(filePage(bob, "File")).toHaveText(UNAVAILABLE);
  for (const word of ["salaries", "Ada Lovelace", "pay", "bytes"]) expect(await filePage(bob, "File").innerHTML(), word).not.toContain(word);

  await bob.goto("/file/zzzzzzzzzzzz");
  await expect(filePage(bob, "File")).toHaveText(UNAVAILABLE);
  expect(answered).toEqual([]);
});

test("a PDF's chip opens it in a tab of its own, shown by the browser's own viewer, served in place and sealed", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "paper.pdf", PDF("(A paper) Tj"));
  const address = `/api/workspaces/${await workspaceOf(page)}/uploads/${upload.id}`;
  await noteWith(page, `# Reading\n\n::file{${upload.id}}\n\nafter\n`);
  const chip = editor(page).getByRole("link", { name: "paper.pdf" });
  await expect(chip).toHaveAttribute("href", address);
  await expect(chip).toHaveAttribute("target", "_blank");
  await expect(chip).toHaveAttribute("rel", "noopener noreferrer");
  const served = (await page.request.get(address)).headers();
  expect([served["content-type"], served["content-disposition"], served["content-security-policy"]]).toEqual([
    "application/pdf",
    `inline; filename="paper.pdf"; filename*=UTF-8''paper.pdf`,
    "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  ]);

  const opened = page.context().waitForEvent("page");
  await chip.click();
  const tab = await opened;
  await expect(tab).toHaveURL(new RegExp(`${address}$`));
  await expect.poll(() => tab.frames().some((frame) => frame.url().startsWith("chrome-extension://"))).toBe(true);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
});

/** A PDF with one page whose words are `shows`, and the script of `action` run when it is opened. */
function PDF(shows: string, action = ""): Buffer {
  const words = `BT /F1 24 Tf 72 720 Td ${shows} ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${action ? ` /OpenAction << /S /JavaScript /JS (${action}) >>` : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${words.length} >>\nstream\n${words}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("nothing an upload holds runs script against the app, however it is opened: from its chip, as a picture, in a preview, in the app, from the Uploads page, or at its address", async ({ page, baseURL }) => {
  const marked: string[] = [];
  await page.context().route("**/api/marked**", (route) => {
    marked.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  const mark = (by: string) => `localStorage.setItem("marked","${by}");document.cookie="marked=${by}; path=/";fetch("/api/marked?${by}")`;
  await signInAsNewPerson(page, "Ada Lovelace");
  const html = await send(page, "evil.html", Buffer.from(`<!doctype html><title>evil</title><script>${mark("html")}</script><p id="said">hello</p>`));
  const svg = await send(page, "evil.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>${mark("svg")}</script><rect width="120" height="80" fill="teal"/></svg>`));
  const pdf = await send(page, "evil.pdf", PDF("(Evil) Tj", `app.launchURL\\("${baseURL}/api/marked?pdf", true\\); this.submitForm\\("${baseURL}/api/marked?pdf-form"\\);`));
  expect([html.type, svg.type, pdf.type]).toEqual(["application/octet-stream", "image/svg+xml", "application/pdf"]);
  const workspaceId = await workspaceOf(page);
  const address = (upload: Upload) => `/api/workspaces/${workspaceId}/uploads/${upload.id}`;
  await noteWith(page, `# Files\n\n::file{${html.id}} ::file{${svg.id}} ::file{${pdf.id}}\n\n::image{${svg.id} 120x80}\n\nafter\n`);

  // As a picture, the SVG is drawn and runs nothing.
  await expect.poll(() => page.locator(`.embed-below[data-embed="image"] img`).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);

  // The SVG's chip previews it as a picture, which runs nothing; the address behind the chip is a download (below).
  await editor(page).getByRole("link", { name: "evil.svg" }).click();
  const chipPreview = page.getByRole("dialog", { name: "Preview of evil.svg" });
  await expect.poll(() => chipPreview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);
  await expect(chipPreview.locator("iframe, object, embed")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(chipPreview).toHaveCount(0);

  // The PDF's chip opens it in a tab, in the browser's own viewer, where its script runs inside the viewer and nowhere else.
  const opened = page.context().waitForEvent("page");
  await editor(page).getByRole("link", { name: "evil.pdf" }).click();
  const tab = await opened;
  await expect.poll(() => tab.frames().some((frame) => frame.url().startsWith("chrome-extension://"))).toBe(true);
  await tab.waitForTimeout(1000);
  await tab.close();

  // The HTML file's chip opens it in the app as its source, which is words and nothing else.
  await editor(page).getByRole("link", { name: "evil.html" }).click();
  await expect(page).toHaveURL(`/file/${html.id}`);
  await expect(fileText(page)).toContainText('<script>localStorage.setItem("marked","html")');
  await expect(filePage(page, "evil.html").locator("script, iframe, object, embed")).toHaveCount(0);
  await expect(page.locator("#said")).toHaveCount(0);

  // Each address typed into a tab: HTML and SVG are saved and never shown, and the PDF is shown by the browser's viewer.
  for (const [upload, name] of [[html, "evil.html"], [svg, "evil.svg"]] as const) {
    const tab = await page.context().newPage();
    const download = tab.waitForEvent("download");
    const response = await tab.request.get(address(upload));
    expect(response.headers()["content-disposition"], name).toMatch(/^attachment; /);
    await tab.goto(address(upload)).catch(() => null);
    expect((await download).suggestedFilename()).toBe(name);
    expect(tab.url(), name).toBe("about:blank");
    await tab.close();
  }
  const typed = await page.context().newPage();
  await typed.goto(address(pdf));
  await expect.poll(() => typed.frames().some((frame) => frame.url().startsWith("chrome-extension://"))).toBe(true);
  await typed.waitForTimeout(1000);
  await typed.close();

  // The Uploads page's Open: the HTML file is read as words in the app, the SVG is previewed as a picture, the PDF opens in the viewer.
  const open = page.locator(".upload-detail").getByRole("button", { name: "Open", exact: true });
  await page.goto(`/uploads/${html.id}`);
  await open.click();
  await expect(page).toHaveURL(`/file/${html.id}`);
  await expect(fileText(page)).toContainText("<script>");
  await expect(filePage(page, "evil.html").locator("script, iframe, object, embed")).toHaveCount(0);
  await page.goto(`/uploads/${svg.id}`);
  await open.click();
  const previewed = page.getByRole("dialog", { name: "Preview of evil.svg" });
  await expect.poll(() => previewed.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);
  await expect(previewed.locator("iframe, object, embed")).toHaveCount(0);
  await page.goto(`/uploads/${pdf.id}`);
  const fromCard = page.context().waitForEvent("page");
  await open.click();
  const cardTab = await fromCard;
  await expect.poll(() => cardTab.frames().some((frame) => frame.url().startsWith("chrome-extension://"))).toBe(true);
  await cardTab.waitForTimeout(1000);
  await cardTab.close();

  // Nothing ran as the app: no mark in its storage or its cookies, and the watched address was never asked.
  await page.goto("/");
  await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
  expect(await page.evaluate(() => localStorage.getItem("marked"))).toBeNull();
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain("marked");
  expect(marked).toEqual([]);
});
