import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { asViewerOfNote, perform, signInAsNewPerson, test, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lineAt = (page: Page, n: number) => page.locator(".cm-content .cm-line").nth(n - 1);
const below = (page: Page, embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
const pictures = (page: Page) => below(page, "image").locator("img");
const sizeOf = (page: Page, name: string) => page.getByRole("slider", { name: `Size of ${name}` });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

/** A PNG of one colour, `width` by `height`, that a browser decodes. */
function png(width: number, height: number, colour = [91, 91, 214]): Buffer {
  return painted(width, height, () => colour);
}

const RED = [220, 30, 30];
const GREEN = [30, 200, 60];
const BLUE = [40, 60, 220];
const YELLOW = [240, 220, 40];

/** A PNG in four colours, a quarter each: red at the top left, green at the top right, blue at the bottom left and yellow at the bottom right. */
const quartered = (width: number, height: number) => painted(width, height, (x, y) => (y < height / 2 ? (x < width / 2 ? RED : GREEN) : x < width / 2 ? BLUE : YELLOW));

/** A PNG `width` by `height` whose every pixel is the colour `colourAt` it. */
function painted(width: number, height: number, colourAt: (x: number, y: number) => number[]): Buffer {
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
  const rowAt = (y: number) => {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(colourAt(x, y), 1 + x * 3);
    return row;
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, (_, y) => rowAt(y))))), chunk("IEND", Buffer.alloc(0))]);
}

/** 20 seconds of a white box moving over blue, 320 by 180, as VP8 in WebM, which every Chromium plays. */
const VIDEO = readFileSync(new URL("fixtures/moving-box.webm", import.meta.url));
/** A second of silence as 8-bit PCM in a WAV. */
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

/** Sends a file as the signed-in person, the way the app does, into the folder named or else Unsorted. */
function send(page: Page, name: string, bytes: Buffer, more: { folderId?: string } = {}): Promise<Upload> {
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

/** Which of a quartered picture's four colours is drawn nearest each point of `of`, each a share of its width across and of its height down. */
async function coloursAt(page: Page, of: Locator, points: [number, number][]): Promise<string[]> {
  const shot = (await of.screenshot()).toString("base64");
  const pixels = await page.evaluate(
    async ({ shot, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      const context = canvas.getContext("2d")!;
      context.drawImage(img, 0, 0);
      return points.map(([x, y]) => [...context.getImageData(Math.round(x * (img.width - 1)), Math.round(y * (img.height - 1)), 1, 1).data.slice(0, 3)]);
    },
    { shot, points },
  );
  const named = Object.entries({ red: RED, green: GREEN, blue: BLUE, yellow: YELLOW });
  const off = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + Math.abs(n - b[i]!), 0);
  return pixels.map((pixel) => named.reduce((best, next) => (off(pixel, next[1]) < off(pixel, best[1]) ? next : best))[0]);
}

const CORNERS_AND_MIDDLE: [number, number][] = [
  [0.05, 0.05],
  [0.95, 0.05],
  [0.05, 0.95],
  [0.95, 0.95],
  [0.5, 0.5],
];

const QUARTERS: [number, number][] = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

async function open(page: Page, text: string, shows: string) {
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(shows);
  await page.evaluate(() => document.fonts.ready);
  return note;
}

/** Where every line of the note is and how tall, and where each room below a line and what is drawn over it are. */
const measured = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 10) / 10);
    };
    return {
      lines: [...document.querySelectorAll(".cm-content .cm-line")].map(box),
      rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
      shown: [...document.querySelectorAll(".embed-below")].map(box),
    };
  });

/** Where the text of a line starts and how wide it can be: the note's column. */
const columnOf = (page: Page, n: number) =>
  lineAt(page, n).evaluate((line) => {
    const style = getComputedStyle(line);
    const rect = line.getBoundingClientRect();
    return { left: rect.left + parseFloat(style.paddingLeft), width: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });

const boxOf = async (page: Page, embed: string, nth = 0) => {
  const box = (await below(page, embed).nth(nth).boundingBox())!;
  return { left: box.x, width: box.width, height: box.height };
};

async function goTo(page: Page, lineNumber: number, where: "Home" | "End" = "End") {
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 1; i < lineNumber; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press(where);
  await settled(page);
}

/** Each of `boxes` that starts below `top`, lower by `by`. */
const lowered = (boxes: number[][], top: number, by: number) => boxes.map(([left, y, width, height]) => [left!, y! > top ? Math.round((y! + by) * 10) / 10 : y!, width!, height!]);

test("a picture, a video and a recording are only themselves: their line takes no room until the cursor is on it, and then their text is above them, which are lower by that line and nothing else moves", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "harbour.png", png(1200, 800));
  const film = await send(page, "box.webm", VIDEO);
  const song = await send(page, "tone.wav", wav());
  await page.setViewportSize({ width: 1280, height: 1600 });
  const written = [`::image{${photo.id} 1200x800}`, `::video{${film.id} 320x180}`, `::audio{${song.id}}`];
  await open(page, `# Media\n\nbefore them\n\n${written[0]}\n\nbetween\n\n${written[1]}\n\nand\n\n${written[2]}\n\nSee ${written[0]} here.\n\nafter them\n`, "after them");
  await expect.poll(() => pictures(page).evaluateAll((imgs: HTMLImageElement[]) => imgs.map((img) => img.naturalWidth))).toEqual([1200, 1200]);
  await expect.poll(() => below(page, "video").locator("video").evaluate((v: HTMLVideoElement) => v.readyState >= 2)).toBe(true);
  await settled(page);

  // Their lines are out of the note's flow: of its 18 lines, 15 are drawn.
  await expect(page.locator(".cm-content .cm-line")).toHaveCount(15);
  for (const text of written) await expect(page.locator(".cm-content .cm-line", { hasText: text })).toHaveCount(0);
  const words = page.locator(".cm-line", { hasText: "here." });
  await expect(words).toHaveText("See  here.");
  await expect(editor(page).locator(".embed-frame, .embed-card, .media-name")).toHaveCount(0);
  await expect(pictures(page).first()).toHaveAttribute("title", /^harbour\.png\nImage · 1200 × 800 · \d+(\.\d)? KB$/);
  await expect(below(page, "video").locator("video")).toHaveAttribute("title", /^box\.webm\nVideo · \d+(\.\d)? KB$/);
  await expect(below(page, "audio").locator("audio")).toHaveAttribute("title", /^tone\.wav\nAudio · \d+(\.\d)? KB$/);
  // No frame of the host's around any of them.
  for (const embed of ["image", "video", "audio"]) expect(await below(page, embed).first().evaluate((el) => getComputedStyle(el).borderTopWidth), embed).toBe("0px");

  const before = await measured(page);
  const near = (a: number[][], b: number[][]) => a.length === b.length && a.every((box, i) => box.every((v, j) => Math.abs(v - b[i]![j]!) <= 0.25));
  for (const [n, text] of [
    [5, written[0]],
    [9, written[1]],
    [13, written[2]],
  ] as const) {
    await goTo(page, n);
    const shown = page.locator(".cm-content .cm-line", { hasText: text! });
    await expect(shown).toHaveText(text!);
    const line = (await shown.boundingBox())!;
    const on = await measured(page);
    const at = on.lines.findIndex(([, top]) => Math.abs(top! - line.y) < 0.5);
    expect(near(on.lines.filter((_, i) => i !== at), lowered(before.lines, line.y - 0.5, line.height)), `with the cursor on line ${n}, the lines under it are lower by it`).toBe(true);
    expect(near(on.rooms, lowered(before.rooms, line.y - 0.5, line.height)) && near(on.shown, lowered(before.shown, line.y - 0.5, line.height)), `with the cursor on line ${n}, what is under it is lower by it`).toBe(true);
    await goTo(page, n + 2);
    await expect(shown).toHaveCount(0);
    await expect.poll(() => measured(page), `with the cursor off line ${n}`).toEqual(before);
  }

  // On a line with words, it is as written only with the cursor on it, or touching it.
  await goTo(page, 15, "Home");
  await expect(words).toHaveText("See  here.");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(words).toHaveText("See  here.");
  await page.keyboard.press("ArrowRight");
  await expect(words).toHaveText(`See ${written[0]} here.`);
  await page.keyboard.press("End");
  await expect(words).toHaveText("See  here.");
  await expect.poll(() => measured(page), "with the cursor off the line").toEqual(before);
});

test("nothing moves while a picture arrives: its room is its whole width and shape before a byte of it has come", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "slow.png", png(1200, 800));
  const workspaceId = (await page.evaluate(async () => (await (await fetch("/api/me")).json()) as Me)).workspaces[0]!.id;
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  await page.route(`**/api/workspaces/${workspaceId}/uploads/${photo.id}`, async (route) => {
    await held;
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await open(page, `# Slow\n\nbefore it\n\n::image{${photo.id} 1200x800}\n\nafter it\n`, "after it");
  await expect(pictures(page)).toHaveCount(1);
  await settled(page);
  expect(await pictures(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(false);
  const waiting = await measured(page);
  const column = await columnOf(page, 3);
  const [left, , width, height] = waiting.rooms[0]!;
  expect([Math.abs(left! - column.left), Math.abs(width! - column.width), Math.abs(height! - (column.width * 800) / 1200)].every((off) => off < 0.6), "as wide as the column, at the picture's shape").toBe(true);
  release();
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await settled(page);
  await expect.poll(() => measured(page)).toEqual(waiting);
});

for (const width of [1280, 700]) {
  test(`at ${width} wide a picture is the column's width, or its own when that is narrower, at its own shape, and each size word and percent is its share of the column`, async ({ page }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    const wide = await send(page, "wide.png", png(1200, 800));
    const narrow = await send(page, "narrow.png", png(300, 200));
    // Tall enough that every picture is on screen, and so drawn.
    await page.setViewportSize({ width, height: 4200 });
    const words = ["", " huge", " small", " medium", " large", " full", " 42%"];
    const text = words.map((w) => `::image{${wide.id} 1200x800${w}}`).concat([`::image{${narrow.id} 300x200}`, `::image{${narrow.id} 300x200 large}`]);
    await open(page, `# Sizes\n\nwords\n\n${text.join("\n\n")}\n\nend\n`, "end");
    await settled(page);
    const column = await columnOf(page, 3);
    // A column at 1280 is wider than at 700, and narrower than the picture.
    expect(column.width).toBeGreaterThan(width === 1280 ? 600 : 300);
    expect(column.width).toBeLessThan(1200);
    const expected = [1, 1, 1 / 3, 1 / 2, 3 / 4, 1, 0.42].map((share) => column.width * share).concat([Math.min(300, column.width), Math.min(300, (column.width * 3) / 4)]);
    const ratios = [...words.map(() => 800 / 1200), 200 / 300, 200 / 300];
    await expect(pictures(page)).toHaveCount(expected.length);
    const boxes = (await below(page, "image").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })))).sort((a, b) => a.top - b.top);
    for (const [i, w] of expected.entries()) {
      const box = boxes[i]!;
      expect(Math.abs(box.left - column.left), `picture ${i} starts where the text does`).toBeLessThan(0.6);
      expect(Math.abs(box.width - w), `picture ${i} is ${w} wide`).toBeLessThan(0.6);
      expect(Math.abs(box.height - w * ratios[i]!), `picture ${i} keeps its shape`).toBeLessThan(0.6);
    }
  });
}

test("the size handle is seen on hover or focus, steps with the keys, drags to any width at the picture's shape, snaps near a size word unless Shift is held, writes it as the member's change that undo takes back, and moves only what is under the picture", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "harbour.png", png(1200, 800));
  await page.setViewportSize({ width: 1280, height: 1400 });
  const embed = (word = "") => `::image{${photo.id} 1200x800${word}}`;
  const text = (word = "") => `# Sizes\n\nbefore it\n\n${embed(word)}\n\nafter it\n\nand more\n`;
  const note = await open(page, text(), "and more");
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await settled(page);
  const handle = sizeOf(page, "harbour.png");
  const shown = () => handle.evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(shown).toBe("0");
  await pictures(page).hover();
  await expect.poll(shown).toBe("1");
  await page.mouse.move(5, 5);
  await expect.poll(shown).toBe("0");

  const column = await columnOf(page, 3);
  const full = await measured(page);
  /** The note as it was at full width, with the picture `share` of the column wide and everything under it moved by as much as it is shorter. */
  const at = (share: number) => {
    const height = Math.round(((column.width * share * 800) / 1200) * 10) / 10;
    const by = Math.round((height - full.rooms[0]![3]!) * 10) / 10;
    const top = full.rooms[0]![1]!;
    const sized = ([left, y, , ,]: number[]) => [left!, y!, Math.round(column.width * share * 10) / 10, height];
    return { lines: lowered(full.lines, top, by), rooms: [sized(full.rooms[0]!)], shown: [sized(full.shown[0]!)] };
  };
  const near = async (share: number) => {
    const now = await measured(page);
    const want = at(share);
    const off = (a: number[][], b: number[][]) => Math.max(...a.flatMap((box, i) => box.map((n, j) => Math.abs(n - b[i]![j]!))));
    return Math.max(off(now.lines, want.lines), off(now.rooms, want.rooms), off(now.shown, want.shown)) < 1;
  };

  await pictures(page).evaluate((img) => ((img as HTMLImageElement & { marked?: boolean }).marked = true));
  await handle.focus();
  await expect.poll(shown).toBe("1");
  await expect(handle).toHaveAttribute("aria-valuetext", "Full width");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 95%"));
  await expect(handle).toHaveAttribute("aria-valuetext", "95% of the column");
  await expect(handle).toHaveAttribute("aria-valuenow", "95");
  await expect.poll(() => near(0.95), "only the picture and what is under it moved").toBe(true);
  await expect(handle).toBeFocused();
  await page.keyboard.press("Home");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 10%"));
  await expect.poll(() => near(0.1)).toBe(true);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 15%"));
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 16%"));
  await expect(handle).toHaveAttribute("aria-valuetext", "16% of the column");
  await page.keyboard.press("End");
  await expect.poll(() => noteText(page, note.id)).toBe(text());
  await expect.poll(() => near(1)).toBe(true);
  // Presses come faster than the note redraws, as a key held down: each one is a step.
  const twice = (key: string) => handle.evaluate((el, key) => [0, 1].forEach(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))), key);
  await twice("ArrowLeft");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 90%"));
  await twice("ArrowRight");
  await expect.poll(() => noteText(page, note.id)).toBe(text());
  expect(await pictures(page).evaluate((img) => (img as HTMLImageElement & { marked?: boolean }).marked), "the same picture, never drawn again").toBe(true);

  /** Drags the picture's right edge, by its handle, to `share` of the column from its left edge, and lets go unless told not to. */
  const drag = async (share: number, { release = true } = {}) => {
    const bar = (await handle.boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(column.left + column.width * share - bar.width / 2, bar.y + bar.height / 2, { steps: 4 });
    if (release) await page.mouse.up();
  };
  const ghost = page.locator(".upload-size-ghost");

  // A drag shows the width it will draw, any width at the picture's shape, and writes it on release.
  await drag(0.8, { release: false });
  await expect.poll(async () => Math.round((await ghost.boundingBox())!.width)).toBe(Math.round(column.width * 0.8));
  expect(Math.abs((await ghost.boundingBox())!.height - (column.width * 0.8 * 800) / 1200)).toBeLessThan(1);
  expect(await noteText(page, note.id)).toBe(text());
  await page.mouse.move(column.left + column.width * 0.62 - (await handle.boundingBox())!.width / 2, (await handle.boundingBox())!.y + 10, { steps: 2 });
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 62%"));
  await expect.poll(() => near(0.62)).toBe(true);
  const drawn = (await pictures(page).boundingBox())!;
  expect(Math.abs(drawn.width - column.width * 0.62), "as wide as it was dragged").toBeLessThan(1);
  expect(Math.abs(drawn.width / drawn.height - 1200 / 800), "at its own shape").toBeLessThan(0.01);
  await expect(handle).toHaveAttribute("aria-valuetext", "62% of the column");

  // Near a size word's width it is that word, and with Shift held it is where it was let go.
  await drag(0.507);
  await expect.poll(() => noteText(page, note.id)).toBe(text(" medium"));
  await expect(handle).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.down("Shift");
  await drag(0.507);
  await page.keyboard.up("Shift");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 51%"));
  await drag(0.99);
  await expect.poll(() => noteText(page, note.id)).toBe(text());
  await expect.poll(() => near(1)).toBe(true);

  // Escape lets go of a drag, and nothing is written.
  const again = (await handle.boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(column.left + 10, again.y + again.height / 2, { steps: 4 });
  await expect(ghost).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(ghost).toHaveCount(0);
  await page.mouse.up();
  await settled(page);
  expect(await noteText(page, note.id)).toBe(text());

  // Each is the member's change, and undo takes them back one by one.
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(new Set((await perform(page, { type: "note.history", id: note.id })).map((c) => `${c.author.kind} ${c.author.name}`))).toEqual(new Set(["member Ada Lovelace"]));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 51%"));
  await expect.poll(() => near(0.51)).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => noteText(page, note.id)).toBe(text(" medium"));
});

test("a picture dragged to any width keeps its share of the column and its shape after a reload, in a narrower window and on a phone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "harbour.png", png(1200, 800));
  await page.setViewportSize({ width: 1280, height: 1400 });
  const text = (word = "") => `# Sizes\n\nbefore it\n\n::image{${photo.id} 1200x800${word}}\n\nafter it\n`;
  const note = await open(page, text(), "after it");
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await settled(page);
  const column = await columnOf(page, 3);
  const bar = (await sizeOf(page, "harbour.png").boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  // The handle is held at its middle, inside the picture's right edge, and the edge moves as far as the pointer.
  await page.mouse.move(column.left + column.width * 0.42 - bar.width / 2, bar.y + bar.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 42%"));
  await expect(page.getByRole("status")).toHaveText("Saved");

  /** The picture's width as a share of the column, and its width over its height. */
  const drawn = async () => {
    await settled(page);
    const box = (await pictures(page).boundingBox())!;
    const { width } = await columnOf(page, 3);
    return { share: Math.round((box.width / width) * 1000) / 1000, ratio: Math.round((box.width / box.height) * 1000) / 1000 };
  };
  expect(await drawn()).toEqual({ share: 0.42, ratio: 1.5 });
  await page.reload();
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  expect(await drawn(), "after a reload").toEqual({ share: 0.42, ratio: 1.5 });
  for (const width of [700, 390]) {
    await page.setViewportSize({ width, height: 1400 });
    await expect.poll(async () => (await columnOf(page, 3)).width).toBeLessThan(column.width);
    await expect.poll(drawn, `at ${width} wide`).toEqual({ share: 0.42, ratio: 1.5 });
  }
});

test("a member who can't change the note sees the picture cropped and the video, with no size handle and no Crop", async ({ page }) => {
  const { admin } = await asViewerOfNote(page, "# Seen\n\nwords\n");
  const photo = await send(admin, "harbour.png", quartered(1200, 800));
  const film = await send(admin, "box.webm", VIDEO);
  const note = await perform(admin, { type: "note.create", text: `# Shown\n\n::image{${photo.id} 1200x800 medium crop=600,400,600,400}\n\n::video{${film.id} 320x180}\n\nwords\n` });
  await page.goto(`/note/${note.id}`);
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await expect(below(page, "video").locator("video")).toHaveCount(1);
  await pictures(page).hover();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(page.locator(".upload-size")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Crop harbour.png" })).toHaveCount(0);
  await settled(page);
  const { width, height } = await boxOf(page, "image");
  expect(Math.round(width / height * 100) / 100, "at the crop's shape").toBe(1.5);
  expect(await coloursAt(page, below(page, "image"), CORNERS_AND_MIDDLE), "only the bottom right quarter").toEqual(["yellow", "yellow", "yellow", "yellow", "yellow"]);
});

test("a picture cropped with the handles writes the crop into its embed, is drawn as only that part at its shape, and undo takes it back in one step", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "harbour.png", quartered(1200, 800));
  await page.setViewportSize({ width: 1280, height: 1400 });
  const text = (words = "") => `# Crop\n\nbefore it\n\n::image{${photo.id} 1200x800${words}}\n\nafter it\n`;
  const note = await open(page, text(), "after it");
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await settled(page);
  const column = await columnOf(page, 3);
  expect(await coloursAt(page, below(page, "image"), QUARTERS), "the whole picture").toEqual(["red", "green", "blue", "yellow"]);

  const crop = page.getByRole("button", { name: "Crop harbour.png" });
  const seen = () => crop.evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(seen).toBe("0");
  await pictures(page).hover();
  await expect.poll(seen).toBe("1");
  await crop.click();
  const dialog = page.getByRole("dialog", { name: "Crop harbour.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: /Crop area/ })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Reset" })).toHaveCount(0);
  await expect.poll(() => dialog.getByRole("img", { name: "harbour.png" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  const stage = (await dialog.locator(".crop-stage").boundingBox())!;
  // The whole picture is drawn 960 wide in a window 1280 wide, so a pixel of the window is a pixel and a quarter of the picture.
  expect(stage.width).toBe(960);
  const said = dialog.locator(".crop-said");
  await expect(said).toHaveText("1200 × 800");

  const dragBy = async (part: Locator, dx: number, dy: number) => {
    const box = (await part.boundingBox())!;
    const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
  };
  await dragBy(dialog.getByRole("slider", { name: "Left edge" }), 480, 0);
  await expect(said).toHaveText("600 × 800");
  await dragBy(dialog.locator(".crop-corner-nw"), 80, 80);
  await expect(said).toHaveText("500 × 700");
  await dragBy(dialog.locator(".crop-box"), -80, -80);
  await expect(said).toHaveText("500 × 700");
  expect(await noteText(page, note.id), "nothing is written before Done").toBe(text());
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toBe(text(" crop=600,0,500,700"));
  await expect(crop).toBeFocused();

  await settled(page);
  const cropped = await boxOf(page, "image");
  expect(Math.abs(cropped.width - Math.min(500, column.width)), "as wide as the crop, or the column").toBeLessThan(1);
  expect(Math.abs(cropped.width / cropped.height - 500 / 700), "at the crop's shape").toBeLessThan(0.01);
  expect(await coloursAt(page, below(page, "image"), [...CORNERS_AND_MIDDLE, [0.5, 0.65]]), "only the right half, down to 700 of 800").toEqual(["green", "green", "yellow", "yellow", "green", "yellow"]);

  await expect(page.getByRole("status")).toHaveText("Saved");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => noteText(page, note.id)).toBe(text());
  await settled(page);
  const whole = await boxOf(page, "image");
  expect(Math.abs(whole.width / whole.height - 1.5), "the whole picture's shape again").toBeLessThan(0.01);
  expect(await coloursAt(page, below(page, "image"), QUARTERS)).toEqual(["red", "green", "blue", "yellow"]);
});

test("a crop is set from the keyboard, Escape leaves it as it was, it survives a new width and a new width survives it, and Reset takes it away", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "harbour.png", quartered(1200, 800));
  await page.setViewportSize({ width: 1280, height: 1400 });
  const text = (words = "") => `# Crop\n\nbefore it\n\n::image{${photo.id} 1200x800${words}}\n\nafter it\n`;
  const note = await open(page, text(" crop=600,0,600,800"), "after it");
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  const crop = page.getByRole("button", { name: "Crop harbour.png" });
  const dialog = page.getByRole("dialog", { name: "Crop harbour.png" });
  const said = dialog.locator(".crop-said");

  await crop.focus();
  await page.keyboard.press("Enter");
  await expect(said).toHaveText("600 × 800");
  const bottom = dialog.getByRole("slider", { name: "Bottom edge" });
  await bottom.focus();
  await expect(bottom).toHaveAttribute("aria-valuenow", "800");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");
  await expect(said).toHaveText("600 × 720");
  await expect(bottom).toHaveAttribute("aria-valuenow", "720");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(crop).toBeFocused();
  await settled(page);
  expect(await noteText(page, note.id), "Escape writes nothing").toBe(text(" crop=600,0,600,800"));

  await page.getByRole("slider", { name: "Size of harbour.png" }).focus();
  await page.keyboard.press("Home");
  await expect.poll(() => noteText(page, note.id), "a crop survives a new width").toBe(text(" 10% crop=600,0,600,800"));

  await crop.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("group", { name: /Crop area/ })).toBeFocused();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(said).toHaveText("600 × 800");
  await bottom.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("ArrowLeft");
  await expect(said).toHaveText("600 × 720");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id), "a new width survives a crop").toBe(text(" 10% crop=480,0,600,720"));
  await settled(page);
  const { width, height } = await boxOf(page, "image");
  expect(Math.abs(width / height - 600 / 720)).toBeLessThan(0.01);

  // A shape picked for a crop taller than wide stands as it does, and stays so as an edge moves.
  await crop.click();
  await dialog.getByRole("radio", { name: "4:3" }).check();
  await expect(said).toHaveText("600 × 800");
  await dialog.getByRole("slider", { name: "Right edge" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(said).toHaveText("588 × 784");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await noteText(page, note.id), "Cancel writes nothing").toBe(text(" 10% crop=480,0,600,720"));

  await crop.click();
  await dialog.getByRole("button", { name: "Reset" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toBe(text(" 10%"));
});

test("a folder's link shows a picture cropped, with no Crop", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Handbook" });
  const photo = await send(page, "office-map.png", quartered(1200, 800), { folderId: folder.id });
  const note = await perform(page, { type: "note.create", text: `# Welcome\n\n::image{${photo.id} 1200x800 crop=0,0,600,400}\n\nafter\n`, folderId: folder.id });
  const link = await perform(page, { type: "grant.link", folderId: folder.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const anyone = await visitor(page);
  await anyone.goto(`/s/${link.to.token}#${note.id}`);
  await expect(editor(anyone)).toContainText("after");
  await expect.poll(() => pictures(anyone).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await pictures(anyone).hover();
  await expect(anyone.getByRole("button", { name: /^Crop/ })).toHaveCount(0);
  await settled(anyone);
  const { width, height } = await boxOf(anyone, "image");
  expect(Math.round(width / height * 100) / 100).toBe(1.5);
  expect(await coloursAt(anyone, below(anyone, "image"), CORNERS_AND_MIDDLE), "only the top left quarter").toEqual(["red", "red", "red", "red", "red"]);
});

test("a video plays in the note from its first frame, and typing elsewhere, the cursor on and off its line, and a new size leave the same element playing on", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const film = await send(page, "box.webm", VIDEO);
  await page.setViewportSize({ width: 1280, height: 1400 });
  const embed = (word = "") => `::video{${film.id} 320x180${word}}`;
  const note = await open(page, `# Film\n\nbefore it\n\n${embed()}\n\nafter it\n`, "after it");
  const video = below(page, "video").locator("video");
  // Its first frame is there before it is played, under the browser's own controls.
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => [v.readyState >= 2, v.paused, v.videoWidth, v.controls, v.autoplay])).toEqual([true, true, 320, true, false]);
  await settled(page);
  const before = await measured(page);
  const box = await boxOf(page, "video");
  expect([Math.round(box.width), Math.round(box.height)], "its own size, narrower than the column").toEqual([320, 180]);

  await video.evaluate(async (v: HTMLVideoElement & { marked?: boolean }) => {
    v.marked = true;
    v.muted = true;
    await v.play();
  });
  const playing = () => video.evaluate((v: HTMLVideoElement & { marked?: boolean }) => ({ same: v.marked === true, playing: !v.paused && !v.ended, time: v.currentTime }));
  const goesOn = async (when: string) => {
    const was = (await playing()).time;
    await expect.poll(async () => {
      const now = await playing();
      return now.same && now.playing && now.time > was + 0.2;
    }, `the same video, still playing on, ${when}`).toBe(true);
  };
  await goesOn("once played");

  await goTo(page, 7);
  await page.keyboard.type(" and more words");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Film\n\nbefore it\n\n${embed()}\n\nafter it and more words\n`);
  await goesOn("after typing on another line");
  await goTo(page, 1);
  await page.keyboard.type(" here");
  await goesOn("after typing above it");

  await goTo(page, 5);
  await expect(lineAt(page, 5)).toHaveText(embed());
  await goesOn("with the cursor on its line");
  await goTo(page, 3);
  await expect(page.locator(".cm-content .cm-line", { hasText: embed() })).toHaveCount(0);
  await goesOn("with the cursor off its line");
  const typed = await measured(page);
  expect(typed.rooms).toEqual(before.rooms);
  expect(typed.shown).toEqual(before.shown);

  await sizeOf(page, "box.webm").focus();
  await page.keyboard.press("Home");
  await expect.poll(() => noteText(page, note.id)).toContain(embed(" 10%"));
  await expect.poll(async () => Math.round((await boxOf(page, "video")).width)).toBe(Math.round((await columnOf(page, 3)).width / 10));
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => noteText(page, note.id)).toContain(embed(" 15%"));
  await goesOn("at another size");
});

test("a full-width picture's size handle stays inside the column: the note can't be scrolled sideways, and a wide table still scrolls in its own frame", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.setViewportSize({ width: 1440, height: 900 });
  const shot = await send(page, "screenshot.png", png(1860, 460));
  const wide = Array.from({ length: 14 }, (_, i) => `column number ${i + 1}`);
  const text = ["# Wide", "", `::image{${shot.id} 1860x460}`, "", `| ${wide.join(" | ")} |`, `|${wide.map(() => "---").join("|")}|`, `| ${wide.map(() => "a cell").join(" | ")} |`, "", "after it"].join("\n");
  await open(page, text, "after it");
  await expect.poll(() => pictures(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1860);
  await settled(page);
  const sideways = () => page.locator(".cm-scroller").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await sideways()).toBe(0);
  await pictures(page).hover();
  expect(await sideways()).toBe(0);
  // The handle is still on the picture's right edge, to be dragged.
  const [picture, handle] = await Promise.all([below(page, "image").boundingBox(), sizeOf(page, "screenshot.png").boundingBox()]);
  expect(handle!.x + handle!.width).toBeLessThanOrEqual(picture!.x + picture!.width + 0.5);
  expect(handle!.x + handle!.width).toBeGreaterThan(picture!.x + picture!.width - 4);
  const table = page.locator(".md-table-frame > div");
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
