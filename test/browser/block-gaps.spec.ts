import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { perform, signInAsNewPerson, test } from "./helpers.ts";
import { standIns } from "./media-helpers.ts";
import { pdf } from "./pdfs.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const [length, sum] = [Buffer.alloc(4), Buffer.alloc(4)];
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([91, 91, 214]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

function wav(): Buffer {
  const data = Buffer.alloc(8000, 128);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

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

/** A block drawn from lines of a note: what the note writes, the element its top is, and the element its bottom is. */
interface Kind {
  name: string;
  /** What the note writes for it, after sending the upload it shows, if any. */
  written: (page: Page) => Promise<string>;
  top: string;
  bottom: string;
  /** Whether its source is shown in place of it, as a formula's is, and not above it. */
  replaced?: boolean;
}

const below = (embed: string) => `.embed-below[data-embed="${embed}"]`;

const uploaded = (name: string, bytes: () => Buffer, as: (id: string) => string) => async (page: Page) => as((await send(page, name, bytes())).id);
const written = (text: string) => async () => text;

const KINDS: readonly Kind[] = [
  { name: "picture", written: uploaded("picture.png", () => png(320, 180), (id) => `/image(${id} 320x180)`), top: below("image"), bottom: below("image") },
  { name: "video", written: uploaded("film.webm", () => readFileSync(new URL("fixtures/moving-box.webm", import.meta.url)), (id) => `/video(${id} 320x180)`), top: below("video"), bottom: below("video") },
  { name: "recording", written: uploaded("tone.wav", wav, (id) => `/audio(${id})`), top: below("audio"), bottom: below("audio") },
  { name: "PDF", written: uploaded("paper.pdf", () => pdf({ pages: 2 }), (id) => `/file(${id})`), top: below("file"), bottom: below("file") },
  { name: "CSV", written: uploaded("cities.csv", () => Buffer.from("city,country\nLisbon,Portugal\nOslo,Norway\n"), (id) => `/file(${id})`), top: below("file"), bottom: below("file") },
  { name: "text", written: uploaded("minutes.txt", () => Buffer.from("What was said.\nWhat was done.\n"), (id) => `/file(${id})`), top: below("file"), bottom: below("file") },
  { name: "video address", written: written("https://www.youtube.com/watch?v=NgRkyAlJx5s"), top: below("video"), bottom: below("video") },
  { name: "kanban", written: written("/kanban()\n~~~markdown\n## To do\n- write\n\n## Done\n~~~"), top: ".embed-frame-block .embed-card", bottom: ".embed-frame-block .embed-card" },
  { name: "HTML", written: written("/html(height=120)\n~~~html\n<p>hi</p>\n~~~"), top: ".embed-frame-block .embed-card", bottom: below("html") },
  { name: "table", written: written("| a | b |\n|---|---|\n| 1 | 2 |"), top: ".md-table-frame", bottom: ".md-table-frame" },
  { name: "formula", written: written("$$\nx^2 + y^2 = z^2\n$$"), top: ".math-block", bottom: ".math-block", replaced: true },
];

/** Where the words above and below a block are, where the block is, and the lines of the note between the words. */
const measure = (page: Page, kind: Kind) =>
  page.evaluate(({ top, bottom }) => {
    const lines = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")];
    const [a, b] = ["Para A.", "Para B."].map((text) => lines.find((l) => l.textContent === text)!.getBoundingClientRect());
    const first = document.querySelector(top)?.getBoundingClientRect();
    const last = [...document.querySelectorAll(bottom)].at(-1)?.getBoundingClientRect();
    const between = lines.filter((l) => l.getBoundingClientRect().top >= a!.bottom - 0.5 && l.getBoundingClientRect().bottom <= b!.top + 0.5);
    // Inside the blank line above it and the blank line below it.
    const shown = between.slice(1, -1);
    return {
      a: a!.top,
      b: b!.top,
      top: first?.top ?? null,
      above: first ? first.top - a!.bottom : null,
      below: last ? b!.top - last.bottom : null,
      shown: shown.map((l) => ({ text: l.textContent, bottom: l.getBoundingClientRect().bottom })),
      shownHeight: shown.reduce((sum, l) => sum + l.getBoundingClientRect().height, 0),
      blanks: [between[0], between.at(-1)].filter((l) => l?.textContent === "").length,
    };
  }, { top: kind.top, bottom: kind.bottom });

async function openKind(page: Page, kind: Kind) {
  const note = await perform(page, { type: "note.create", text: `# ${kind.name}\n\nPara A.\n\n${await kind.written(page)}\n\nPara B.` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Para B.");
  await expect(page.locator(kind.bottom).last()).toBeVisible();
  await page.locator(".cm-line", { hasText: "Para B." }).click();
  await page.keyboard.press("End");
  await settled(page);
}

// One test for each, so a slow server holds up one block's page loads, not all eleven of them in one test's time.
for (const kind of KINDS) {
  test(`a ${kind.name} is as far below the words above it as above the words below it, its lines take no room until the cursor is on them, and then they are above it and push down only by their height`, async ({ page }) => {
    await standIns(page);
    await signInAsNewPerson(page, "Ada Lovelace");
    await page.setViewportSize({ width: 1280, height: 1100 });
    await openKind(page, kind);
    const away = await measure(page, kind);
    expect(away.shown, `${kind.name}: nothing of its lines is in the note with the cursor away`).toEqual([]);
    expect(away.blanks, `${kind.name}: the blank lines around it`).toBe(2);
    expect(Math.abs(away.above! - away.below!), `${kind.name}: ${away.above}px above and ${away.below}px below`).toBeLessThanOrEqual(1);

    // Up from the words below it steps onto its last line, which shows its lines.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await settled(page);
    const on = await measure(page, kind);
    expect(on.shown.length, `${kind.name}: its lines are shown with the cursor on them`).toBeGreaterThan(0);
    expect(on.a, `${kind.name}: the words above don't move`).toBeCloseTo(away.a, 0);
    if (!kind.replaced) {
      expect(on.shown.at(-1)!.bottom, `${kind.name}: its lines are above it`).toBeLessThanOrEqual(on.top! + 1);
      expect(Math.abs(on.top! - away.top! - on.shownHeight), `${kind.name}: it is lower by its lines' height`).toBeLessThanOrEqual(1);
      expect(Math.abs(on.b - away.b - on.shownHeight), `${kind.name}: the words below are lower by its lines' height`).toBeLessThanOrEqual(1);
    }

    // Back off it, everything is where it was.
    await page.keyboard.press("ControlOrMeta+End");
    await settled(page);
    expect(await measure(page, kind), `${kind.name}: with the cursor away again`).toEqual(away);
  });
}

test("the arrow keys and vim's j and k each stop on the line of an upload or an address that is out of sight, which shows it, and step off it again", async ({ page }) => {
  await standIns(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  const picture = await send(page, "picture.png", png(320, 180));
  const video = "https://www.youtube.com/watch?v=NgRkyAlJx5s";
  const note = await perform(page, { type: "note.create", text: `# Steps\n\nPara A.\n/image(${picture.id} 320x180)\n${video}\nPara B.` });
  const shown = () => page.locator(".cm-content > .cm-line").evaluateAll((lines) => lines.map((l) => l.textContent).filter((t) => t!.startsWith("::") || t!.startsWith("https")));
  const steps = [
    [[], ["ArrowDown", "j"]],
    [[`/image(${picture.id} 320x180)`], ["ArrowDown", "j"]],
    [[video], ["ArrowDown", "j"]],
    [[], ["ArrowUp", "k"]],
    [[video], ["ArrowUp", "k"]],
    [[`/image(${picture.id} 320x180)`], ["ArrowUp", "k"]],
    [[], []],
  ] as const;
  for (const vim of [false, true]) {
    if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
    await page.goto(`/note/${note.id}`);
    await expect(page.locator(below("image"))).toBeVisible();
    await page.locator(".cm-line", { hasText: "Para A." }).click();
    if (vim) await page.keyboard.press("Escape");
    await expect.poll(shown).toEqual([]);
    let last: readonly string[] = [];
    for (const [expected, keys] of steps) {
      await expect.poll(shown, `${vim ? "vim" : "arrows"}: after ${last.join(", ") || "starting"}`).toEqual([...expected]);
      if (!keys.length) break;
      const key = vim ? keys[1]! : keys[0]!;
      await page.keyboard.press(key);
      last = [...last, key];
    }
  }
});

test("going to the end or the start of a note, as ControlOrMeta+End and ControlOrMeta+Home do, lands there and not on a line out of sight on the way, so what is typed goes there and the embed's line is left as it is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const minutes = await send(page, "minutes.txt", Buffer.from("What was said.\n"));
  const embed = `/file(${minutes.id})`;
  const noteText = async (id: string) => (await perform(page, { type: "note.read", id })).text;

  const toEnd = await perform(page, { type: "note.create", text: `# T\n\nPara A.\n${embed}\nPara B.` });
  await page.goto(`/note/${toEnd.id}`);
  await expect(page.locator(below("file"))).toBeVisible();
  await page.locator(".cm-line", { hasText: "Para A." }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("X");
  await expect.poll(() => noteText(toEnd.id)).toBe(`# T\n\nPara A.\n${embed}\nPara B.X`);

  const toStart = await perform(page, { type: "note.create", text: `# T\n${embed}\nPara B.` });
  await page.goto(`/note/${toStart.id}`);
  await expect(page.locator(below("file"))).toBeVisible();
  await page.locator(".cm-line", { hasText: "Para B." }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.type("Z");
  await expect.poll(() => noteText(toStart.id)).toBe(`# TZ\n${embed}\nPara B.`);
});
