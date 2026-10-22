import { deflateSync, crc32 } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { asViewerOfNote, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

async function open(page: Page, text: string) {
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("last");
  return note;
}

/** A PNG of one colour, `width` by `height`. */
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
  const row = Buffer.alloc(1 + width * 3, 120);
  row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Sends a file as the signed-in person, the way the app does. */
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

test("an HTML block's settings set its height into its line and clear it out again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await open(page, "# Page\n\n:::html{}\n<p>Hi</p>\n:::\n\nlast\n");
  await editor(page).getByRole("button", { name: "Settings for HTML" }).click();
  const panel = page.getByRole("dialog", { name: "Settings for HTML" });
  const height = panel.getByRole("textbox", { name: "Height" });
  await expect(height).toHaveValue("");
  await expect(height).toHaveAttribute("placeholder", "320");
  await expect(panel.getByRole("button", { name: "Clear Height" })).toHaveCount(0);

  await height.fill("480");
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toContain(":::html{height=480}\n<p>Hi</p>");
  await expect(height).toHaveValue("480");
  await panel.getByRole("button", { name: "Clear Height" }).click();
  await expect.poll(() => noteText(page, note.id)).toContain(":::html{}\n<p>Hi</p>");
  await expect(height).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Clear Height" })).toHaveCount(0);
});

test("a timer's length is set in hours, minutes and seconds, each typed or stepped with the arrow keys or the wheel, and what its Start and Stop write stays on the timer", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await open(page, "# Tea\n\nSteep ::timer{5m at=1m} now.\n\nlast\n");
  await editor(page).getByRole("button", { name: "Settings for Timer" }).click();
  const panel = page.getByRole("dialog", { name: "Settings for Timer" });
  const length = panel.getByRole("group", { name: "Length" });
  const [hours, minutes, seconds] = ["Hours", "Minutes", "Seconds"].map((name) => length.getByRole("spinbutton", { name }));
  await expect(hours!).toHaveValue("0");
  await expect(minutes!).toHaveValue("5");
  await expect(seconds!).toHaveValue("0");
  await expect(hours!).toHaveAttribute("max", "9999");
  await expect(seconds!).toHaveAttribute("max", "59");
  await expect(panel.getByRole("textbox")).toHaveCount(0);

  await hours!.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h5m at=1m} now.");
  await expect(hours!).toHaveValue("1");
  await seconds!.hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h5m1s at=1m} now.");
  await page.mouse.wheel(0, 100);
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h5m at=1m} now.");
  await page.mouse.wheel(0, -100);
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h5m1s at=1m} now.");
  await expect(editor(page).getByRole("button", { name: "Timer, 1:04:01 left" })).toBeVisible();

  // A turn of the wheel over a part is its step and not the page's scroll; a sideways one is the page's. A flick of several steps changes the note once.
  const flick = await seconds!.evaluate(async (el) => {
    const drawn = () => document.querySelector('.cm-content .embed[data-embed="timer"]')?.textContent;
    const seen: (string | null | undefined)[] = [];
    const watching = new MutationObserver(() => drawn() !== seen.at(-1) && seen.push(drawn()));
    watching.observe(document.querySelector(".cm-content")!, { subtree: true, childList: true, characterData: true });
    const prevented: boolean[] = [];
    for (const deltaY of [-100, -100, -100, 0]) {
      prevented.push(!el.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaX: deltaY ? 0 : 100, cancelable: true, bubbles: true })));
      await new Promise((done) => setTimeout(done, 50));
    }
    await new Promise((done) => setTimeout(done, 1000));
    watching.disconnect();
    return { prevented, seen };
  });
  expect(flick).toEqual({ prevented: [true, true, true, false], seen: [expect.stringContaining("1:04:04")] });
  await expect(seconds!).toHaveValue("4");
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h5m4s at=1m} now.");
  // What the wheel turned short of a step is let go when the pointer leaves the part.
  const turnedBack = await seconds!.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, cancelable: true }));
    el.dispatchEvent(new PointerEvent("pointerleave"));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, cancelable: true }));
    return el.value;
  });
  expect(turnedBack).toBe("4");

  // Typed, each part is kept within its range.
  await minutes!.fill("75");
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h59m4s at=1m} now.");
  await expect(minutes!).toHaveValue("59");

  // The length can't be cleared or be no time at all: a timer can't be read without it.
  await expect(panel.getByRole("button", { name: "Clear Length" })).toHaveCount(0);
  for (const part of [hours!, minutes!, seconds!]) await part.fill("0");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toHaveText("Length can't be zero.");
  await expect.poll(() => noteText(page, note.id)).toContain("Steep ::timer{1h59m4s at=1m} now.");
  // And the field shows the length the note still has.
  await expect(hours!).toHaveValue("1");
  await expect(minutes!).toHaveValue("59");
  await expect(seconds!).toHaveValue("4");
});

test("a stopwatch's settings have its time so far and not the words its Start and Stop write", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await open(page, "# Run\n\nLap ::stopwatch{at=1m} done.\n\nlast\n");
  await editor(page).getByRole("button", { name: "Settings for Stopwatch" }).click();
  const panel = page.getByRole("dialog", { name: "Settings for Stopwatch" });
  await expect(panel.getByRole("textbox")).toHaveCount(1);
  await expect(panel.getByRole("textbox", { name: "Time so far" })).toHaveValue("1m");
  await panel.getByRole("textbox", { name: "Time so far" }).fill("2m");
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toContain("Lap ::stopwatch{at=2m} done.");
});

test("someone who can only read the note gets no settings button on any embed", async ({ page }) => {
  const { note, admin } = await asViewerOfNote(page, "# Tea\n\nSteep ::timer{5m} now.\n\n:::html{}\n<p>Hi</p>\n:::\n\nlast\n");
  const photo = await send(admin, "harbour.png", png(400, 300));
  await perform(admin, { type: "note.write", id: note.id, baseRevision: note.revision, text: `${note.text}\n::image{${photo.id} 400x300}\n\nend\n` });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("button", { name: "Run HTML" })).toBeVisible();
  await expect(editor(page).getByText("5:00")).toBeVisible();
  await expect(page.locator('.embed-below[data-embed="image"] img')).toBeVisible();
  await expect(page.getByRole("button", { name: /^Settings for / })).toHaveCount(0);
});

test("the settings close when what the note writes of their embed is taken out", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await open(page, "# Tea\n\nSteep ::timer{5m} now.\n\nlast\n");
  await editor(page).getByRole("button", { name: "Settings for Timer" }).click();
  const panel = page.getByRole("dialog", { name: "Settings for Timer" });
  await expect(panel).toBeVisible();
  await perform(page, { type: "note.write", id: note.id, baseRevision: note.revision, text: "# Tea\n\nSteep now.\n\nlast\n" });
  await expect(editor(page)).toContainText("Steep now.");
  await expect(panel).toHaveCount(0);
});

test("a picture's settings open from its corner, beneath it, and set and clear its width in its line", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.setViewportSize({ width: 1280, height: 1200 });
  const photo = await send(page, "harbour.png", png(400, 300));
  const note = await open(page, `# Photo\n\nabove\n\n::image{${photo.id} 400x300}\n\nlast\n`);
  const shown = page.locator('.embed-below[data-embed="image"]');
  await expect(shown.locator("img")).toBeVisible();
  const button = shown.getByRole("button", { name: /^Settings for / });
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await shown.hover();
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  const [settings, crop] = [(await button.boundingBox())!, (await shown.getByRole("button", { name: /^Crop / }).boundingBox())!];
  expect(settings.x >= crop.x + crop.width || crop.x >= settings.x + settings.width || settings.y >= crop.y + crop.height || crop.y >= settings.y + settings.height, "the settings button and the crop button don't overlap").toBe(true);
  await button.click();

  const panel = page.getByRole("dialog", { name: /^Settings for / });
  await expect(panel.getByRole("textbox", { name: "Upload" })).toHaveValue(photo.id);
  // Its size is measured by the app once it has loaded, and isn't set by hand.
  await expect(panel.getByRole("textbox", { name: "Width" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Size" })).toHaveCount(0);
  const [under, box] = [(await shown.boundingBox())!, (await panel.boundingBox())!];
  expect(box.y).toBeGreaterThanOrEqual(under.y + under.height);

  await panel.getByRole("textbox", { name: "Width" }).fill("medium");
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toContain(`::image{${photo.id} 400x300 medium}`);
  await panel.getByRole("textbox", { name: "Crop" }).fill("10,10,100,100");
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toContain(`::image{${photo.id} 400x300 medium crop=10,10,100,100}`);
  // Still beneath the picture, which is narrower now.
  const [now, moved] = [(await shown.boundingBox())!, (await panel.boundingBox())!];
  expect(now.width).toBeLessThan(under.width);
  expect(moved.y - (now.y + now.height)).toBeLessThan(8);
  await panel.getByRole("button", { name: "Clear Width" }).click();
  await expect.poll(() => noteText(page, note.id)).toContain(`::image{${photo.id} 400x300 crop=10,10,100,100}`);
  await expect(panel.getByRole("button", { name: "Clear Upload" })).toHaveCount(0);
});

test("a short HTML block shows its whole Run button while it asks, and is as tall as it says once it runs", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "html.run": "ask first" }), baseRevision: 0 });
  await open(page, "# Page\n\n:::html{height=40}\n<p>Hi</p>\n:::\n\nlast\n");
  const room = page.locator('.embed-below[data-embed="html"]');
  const run = room.getByRole("button", { name: /^Run HTML/ });
  await expect(run).toBeVisible();
  const whole = async (inner: string) => {
    const [outer, box] = [(await room.boundingBox())!, (await room.locator(inner).boundingBox())!];
    return box.y >= outer.y && box.y + box.height <= outer.y + outer.height;
  };
  await expect.poll(() => whole(".media-load-action")).toBe(true);
  await expect.poll(() => whole(".media-load-from")).toBe(true);
  expect((await room.boundingBox())!.height).toBeGreaterThan(60);
  await run.click();
  await expect(room.locator("iframe")).toBeVisible();
  await expect.poll(async () => Math.round((await room.boundingBox())!.height)).toBe(40);
});
