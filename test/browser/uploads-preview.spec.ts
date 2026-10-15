import { expect, test, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { perform, signInAsNewPerson } from "./helpers.ts";
import { pdf, pdfOf } from "./pdfs.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const cards = (page: Page) => page.locator('.embed-below[data-embed="file"]');
const card = (page: Page, name: string) => cards(page).filter({ has: page.locator(".upload-card-name", { hasText: name }) });
const overlay = (page: Page, name: string) => page.getByRole("dialog", { name: `Preview of ${name}` });

function send(page: Page, name: string, bytes: Buffer): Promise<Upload> {
  return page.evaluate(
    async ({ name, base64 }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, base64: bytes.toString("base64") },
  );
}

async function noteWith(page: Page, text: string) {
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("after");
  return note;
}

/** How many of a canvas's pixels are the blue of the band each test page has, which says pdf.js drew the page. */
const blueIn = (canvas: ReturnType<Page["locator"]>) =>
  canvas.evaluate((el: HTMLCanvasElement) => {
    const { data } = el.getContext("2d")!.getImageData(0, 0, el.width, el.height);
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 2]! > 150 && data[i]! < 140) blue++;
    return blue / (el.width * el.height);
  });

const CITIES = ["city,country", ...Array.from({ length: 20 }, (_, i) => `Town ${i + 1},Land ${i + 1}`)].join("\n");
const MINUTES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the minutes`).join("\n");

test("a PDF on a line of its own shows its first three pages drawn in the note and how many it has, and a press shows every page larger over the app, with Download", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const paper = await send(page, "paper.pdf", pdf({ pages: 5 }));
  await noteWith(page, `# Reading\n\n::file{${paper.id}}\n\nafter\n`);
  const shown = card(page, "paper.pdf");
  await expect(shown.locator("canvas")).toHaveCount(3);
  await expect(shown.locator(".upload-card-head")).toContainText("5 pages, the first 3 shown");
  for (let n = 0; n < 3; n++) await expect.poll(() => blueIn(shown.locator("canvas").nth(n)), `page ${n + 1} is drawn`).toBeGreaterThan(0.1);
  await expect(shown.locator("canvas").first()).toHaveAttribute("aria-label", "Page 1");
  await expect(page.locator("iframe, object, embed")).toHaveCount(0);

  await shown.getByRole("button", { name: "Preview paper.pdf" }).click();
  const larger = overlay(page, "paper.pdf");
  await expect(larger.locator("canvas")).toHaveCount(5);
  await expect(larger.getByRole("heading")).toContainText("5 pages");
  await expect.poll(() => blueIn(larger.locator("canvas").nth(4)), "the last page is drawn").toBeGreaterThan(0.1);
  expect((await larger.locator("canvas").first().boundingBox())!.width, "larger than in the note").toBeGreaterThan((await shown.locator("canvas").first().boundingBox())!.width);
  const saved = page.waitForEvent("download");
  await larger.getByRole("button", { name: "Download" }).click();
  expect((await saved).suggestedFilename()).toBe("paper.pdf");
  await page.keyboard.press("Escape");
  await expect(larger).toHaveCount(0);

  // The keyboard reaches the preview, and Enter opens it.
  await shown.getByRole("button", { name: "Preview paper.pdf" }).focus();
  await page.keyboard.press("Enter");
  await expect(overlay(page, "paper.pdf")).toBeVisible();
});

test("a CSV shows its first rows, text and markdown their first lines, a file with nothing to preview its name and Download, and among words each is still a chip", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const cities = await send(page, "cities.csv", Buffer.from(CITIES));
  const minutes = await send(page, "minutes.txt", Buffer.from(MINUTES));
  const readme = await send(page, "readme.md", Buffer.from("# Read me\n\n- **one**\n- two\n"));
  const archive = await send(page, "archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  await page.setViewportSize({ width: 1280, height: 1600 });
  await noteWith(page, `# Files\n\n::file{${cities.id}}\n\n::file{${minutes.id}}\n\n::file{${readme.id}}\n\n::file{${archive.id}}\n\nSee ::file{${cities.id}} here.\n\nafter\n`);
  await expect(cards(page)).toHaveCount(4);

  const table = card(page, "cities.csv").locator("table");
  await expect(table.locator("th")).toHaveText(["city", "country"]);
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText(["Town 1", "Land 1"]);
  await expect(card(page, "cities.csv").locator(".upload-card-head")).toContainText("the first 6 rows");
  await expect(card(page, "minutes.txt").locator("pre")).toHaveText(MINUTES.split("\n").slice(0, 8).join("\n"));
  await expect(card(page, "minutes.txt").locator(".upload-card-head")).toContainText("the first 8 lines");
  await expect(card(page, "readme.md").locator("pre")).toHaveText("# Read me\n\n- **one**\n- two");
  // Text is put in the page as text: its markup draws nothing.
  await expect(card(page, "readme.md").locator("pre *")).toHaveCount(0);
  const zip = card(page, "archive.zip");
  await expect(zip.locator(".upload-card-body")).toBeEmpty();
  await expect(zip.getByRole("link", { name: "Download archive.zip" })).toHaveAttribute("download", "archive.zip");
  // A short file's card is as tall as its text, and no taller.
  const [readmeCard, readmeText] = [(await card(page, "readme.md").boundingBox())!, (await card(page, "readme.md").locator("pre").boundingBox())!];
  expect(readmeCard.y + readmeCard.height - (readmeText.y + readmeText.height)).toBeLessThanOrEqual(2);
  await expect(editor(page).locator(".file-chip", { hasText: "cities.csv" })).toHaveCount(1);

  await card(page, "cities.csv").getByRole("button", { name: "Preview cities.csv" }).click();
  await expect(overlay(page, "cities.csv").locator("tbody tr")).toHaveCount(20);
  await page.keyboard.press("Escape");
  await card(page, "minutes.txt").getByRole("button", { name: "Preview minutes.txt" }).click();
  await expect(overlay(page, "minutes.txt").locator("pre")).toHaveText(MINUTES);
  await overlay(page, "minutes.txt").getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(`/file/${minutes.id}`);
});

test("pdf.js is loaded only once a PDF is shown, and only from the app's own address", async ({ page, baseURL }) => {
  const asked: string[] = [];
  page.on("request", (request) => asked.push(request.url()));
  await signInAsNewPerson(page, "Ada Lovelace");
  const cities = await send(page, "cities.csv", Buffer.from(CITIES));
  const paper = await send(page, "paper.pdf", pdf());
  await noteWith(page, `# Table\n\n::file{${cities.id}}\n\nafter\n`);
  await expect(card(page, "cities.csv").locator("tbody tr")).toHaveCount(6);
  const loaded = () => asked.filter((url) => /pdf/i.test(new URL(url).pathname));
  expect(loaded(), "nothing of pdf.js before a PDF is shown").toEqual([]);

  await noteWith(page, `# Paper\n\n::file{${paper.id}}\n\nafter\n`);
  await expect.poll(() => blueIn(card(page, "paper.pdf").locator("canvas"))).toBeGreaterThan(0.1);
  expect(loaded().some((url) => /pdf\.worker/.test(url)), "its worker").toBe(true);
  expect(loaded().filter((url) => !url.startsWith(baseURL!)), "from nowhere else").toEqual([]);
});

test("the Uploads page's panel is a preview of the selected file, the same as a note draws, with its details and Used in beneath, Open and … kept, and selecting with the keyboard changes it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const archive = await send(page, "archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  const cities = await send(page, "cities.csv", Buffer.from(CITIES));
  const paper = await send(page, "paper.pdf", pdf({ pages: 3 }));
  await perform(page, { type: "note.create", text: `# Trips\n\n::file{${paper.id}}\n` });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/uploads/${paper.id}`);
  const panel = page.getByRole("complementary", { name: "paper.pdf" });
  const preview = panel.getByRole("button", { name: "Preview paper.pdf" });
  await expect(preview.locator("canvas")).toHaveCount(1);
  await expect.poll(() => blueIn(preview.locator("canvas"))).toBeGreaterThan(0.1);
  await expect(panel.locator(".upload-meta")).toContainText("3 pages, the first one shown");
  await expect(panel.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "More for paper.pdf" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Used in" }).getByRole("link")).toHaveText(["Trips"]);
  // The preview leads, and the details and Used in are beneath it.
  const [shown, details, used] = [await preview.boundingBox(), await panel.locator(".upload-meta").boundingBox(), await panel.getByRole("region", { name: "Used in" }).boundingBox()];
  expect(shown!.y + shown!.height).toBeLessThanOrEqual(details!.y);
  expect(details!.y).toBeLessThan(used!.y);

  await preview.click();
  await expect(page.getByRole("dialog", { name: "Preview of paper.pdf" }).locator("canvas")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Selecting another file with the keyboard shows it instead.
  const row = (name: string) => page.getByRole("list", { name: "Uploads" }).getByRole("link").filter({ hasText: name });
  await row("cities.csv").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/uploads/${cities.id}`);
  const table = page.getByRole("complementary", { name: "cities.csv" }).getByRole("button", { name: "Preview cities.csv" }).locator("table");
  await expect(table.locator("th")).toHaveText(["city", "country"]);
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await row("archive.zip").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/uploads/${archive.id}`);
  await expect(page.getByRole("complementary", { name: "archive.zip" }).locator(".upload-type-icon")).toHaveText("ZIP");
});

const BAND = "<< /Length 37 >>\nstream\n0.36 0.36 0.84 rg 72 200 468 300 re f\nendstream";
/** PDFs pdf.js opens and then can't draw: a second page that is the number 42, a tree of pages that leads back to itself, and one with no pages at all. */
const UNDRAWABLE = {
  "second.pdf": pdfOf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 3 0 R] /Count 3 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>", BAND, "42"]),
  "cyclic.pdf": pdfOf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 3 /Parent 2 0 R >>", "<< /Type /Pages /Kids [2 0 R] /Count 1 /Parent 3 0 R >>"]),
  "empty.pdf": pdfOf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"]),
};

test("a PDF whose pages can't all be drawn, whose pages lead back to themselves, or that has none says quietly that it couldn't be drawn, in a note and over the app, and says no number of pages", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const sent = await Promise.all(Object.entries(UNDRAWABLE).map(([name, bytes]) => send(page, name, bytes)));
  await page.setViewportSize({ width: 1280, height: 1600 });
  await noteWith(page, `# Broken\n\n${sent.map((upload) => `::file{${upload.id}}`).join("\n\n")}\n\nafter\n`);
  await expect(cards(page)).toHaveCount(3);
  for (const { name } of sent) {
    await expect(card(page, name).locator(".upload-card-body"), name).toContainText("This PDF couldn't be drawn. Download it to read it.");
    await expect(card(page, name).locator("canvas"), name).toHaveCount(0);
    await expect(card(page, name).locator(".upload-card-head"), name).not.toContainText("page");
  }
  await card(page, "second.pdf").getByRole("button", { name: "Preview second.pdf" }).click();
  const larger = overlay(page, "second.pdf");
  await expect(larger).toContainText("This PDF couldn't be drawn. Download it to read it.");
  await expect(larger.locator("canvas")).toHaveCount(0);
  await expect(larger.getByRole("heading")).toHaveText("second.pdf");
});

test("a page far taller than it is wide, or far wider than it is tall, is drawn over the app no taller than a few screens and no thinner than a line of text, and a letter page as wide as the preview", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const tall = await send(page, "tall.pdf", pdf({ size: [100, 100000] }));
  const wide = await send(page, "wide.pdf", pdf({ size: [100000, 100] }));
  const letter = await send(page, "letter.pdf", pdf());
  await page.setViewportSize({ width: 1280, height: 1600 });
  await noteWith(page, `# Shapes\n\n::file{${tall.id}}\n\n::file{${wide.id}}\n\n::file{${letter.id}}\n\nafter\n`);
  await page.setViewportSize({ width: 1280, height: 800 });
  const drawn = async (name: string) => {
    await card(page, name).getByRole("button", { name: `Preview ${name}` }).click();
    const larger = overlay(page, name);
    await expect(larger.locator("canvas")).toHaveCount(1);
    await expect(larger.getByRole("heading")).toContainText("1 page");
    const box = (await larger.locator("canvas").boundingBox())!;
    const room = (await larger.locator(".upload-pages").boundingBox())!;
    await page.keyboard.press("Escape");
    await expect(larger).toHaveCount(0);
    return { box, room };
  };
  const shapes = { tall: await drawn("tall.pdf"), wide: await drawn("wide.pdf"), letter: await drawn("letter.pdf") };
  expect(shapes.tall.box.height, "the tall page is no taller than three screens").toBeLessThanOrEqual(3 * 800 + 1);
  expect(shapes.tall.box.width, "and is no thinner than a line of text").toBeGreaterThanOrEqual(15);
  expect(shapes.wide.box.height, "the wide page is no thinner than a line of text").toBeGreaterThanOrEqual(15);
  expect(shapes.wide.box.width, "and no wider than the preview").toBeLessThanOrEqual(shapes.wide.room.width);
  expect(Math.abs(shapes.letter.box.width - (shapes.letter.room.width - 24)), "a letter page is as wide as the preview inside its padding").toBeLessThanOrEqual(1);
  expect(Math.abs(shapes.letter.box.height - (shapes.letter.box.width * 792) / 612), "at its own shape").toBeLessThanOrEqual(2);
});

test("what the Uploads page says of a PDF's pages goes with its preview when the file is moved to Trash", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const paper = await send(page, "paper.pdf", pdf({ pages: 3 }));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/uploads/${paper.id}`);
  const panel = page.getByRole("complementary", { name: "paper.pdf" });
  await expect(panel.locator(".upload-meta")).toContainText("3 pages, the first one shown");
  await panel.getByRole("button", { name: "More for paper.pdf" }).click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(panel.getByText("This file is in Trash.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Preview paper.pdf" })).toHaveCount(0);
  await expect(panel.locator(".upload-meta")).not.toContainText("pages");
  await panel.getByRole("button", { name: "Restore" }).click();
  await expect(panel.locator(".upload-meta")).toContainText("3 pages, the first one shown");
});
