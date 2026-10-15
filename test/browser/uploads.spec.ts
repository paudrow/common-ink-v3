import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { anotherPerson, join, listedNotes, openAllNotes, perform, signInAsNewPerson, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string) => page.locator(".cm-line").filter({ hasText: text });
const below = (page: Page, embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
/** What an embed drew in its room below the line. */
const drawn = (page: Page, embed: string) => below(page, embed).locator(".embed-below-drawn");
const uploadsPage = (page: Page) => page.getByRole("region", { name: "Uploads" });
const rows = (page: Page) => page.getByRole("list", { name: "Uploads" }).getByRole("link");
const toast = (page: Page) => page.getByRole("group", { name: "Notice" });
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));
const UNAVAILABLE = "This file isn't available";
const IN_TRASH = "This file is in Trash";

/** A PNG of one colour, `width` by `height`, that a browser decodes. */
function png(width: number, height: number, [r, g, b] = [91, 91, 214]): Buffer {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([r!, g!, b!]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>window.parent.hacked = true</script><rect width="120" height="80" fill="teal"/></svg>');
/** The first bytes of an MP4 and of an MP3, which is all the server reads to say what a file is. Neither plays. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);

/** Sends a file as the signed-in person, the way the app does, to their first workspace unless one is named. */
function send(page: Page, name: string, bytes: Buffer, more: { folderId?: string; private?: boolean } = {}, workspaceId?: string): Promise<Upload> {
  return page.evaluate(
    async ({ name, base64, more, workspaceId }) => {
      const id = workspaceId ?? ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name, ...more })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, base64: bytes.toString("base64"), more, workspaceId },
  );
}

const workspaceOf = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/me")).json()) as Me)).workspaces[0]!.id;

async function open(page: Page, noteId: string, shows: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toContainText(shows);
}

/** Pastes or drops files on the note's text, as the browser's own event carries them. `size` stands in for a file's bytes where only how many there are matters. */
function give(page: Page, how: "paste" | "drop", files: { name: string; type: string; bytes?: Buffer; size?: number }[], also: Record<string, string> = {}) {
  return page.evaluate(
    ({ how, files, also }) => {
      const carried = new DataTransfer();
      for (const [type, text] of Object.entries(also)) carried.setData(type, text);
      for (const file of files) carried.items.add(new File([file.base64 === null ? new Uint8Array(file.size) : Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
      const target = document.querySelector(".cm-content")!;
      const last = [...target.querySelectorAll(".cm-line")].at(-1)!.getBoundingClientRect();
      const event =
        how === "paste"
          ? new ClipboardEvent("paste", { clipboardData: carried, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: carried, bubbles: true, cancelable: true, clientX: last.left + 2, clientY: last.top + last.height / 2 });
      target.dispatchEvent(event);
    },
    { how, files: files.map((f) => ({ name: f.name, type: f.type, base64: f.bytes ? f.bytes.toString("base64") : null, size: f.size ?? 0 })), also },
  );
}

const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const picture = (page: Page) => below(page, "image").locator("img");
const drawnWidth = (page: Page) => picture(page).evaluate((img: HTMLImageElement) => img.naturalWidth);

/** Where every line of the note is and how tall, and where each room below a line and what is drawn over it are. */
const measured = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 10) / 10);
    };
    return {
      lines: [...document.querySelectorAll(".cm-content .cm-line")].map((l) => box(l)),
      rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
      shown: [...document.querySelectorAll(".embed-below")].map(box),
    };
  });

async function goTo(page: Page, lineNumber: number) {
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 1; i < lineNumber; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
}

test("a file uploaded on the Uploads page is listed with its picture, and its details say what it is and how a note shows it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/uploads");
  await expect(uploadsPage(page)).toContainText("There are no uploads yet.");

  const chooser = page.waitForEvent("filechooser");
  await uploadsPage(page).getByRole("button", { name: "Upload files" }).click();
  await (await chooser).setFiles({ name: "harbour.png", mimeType: "image/png", buffer: png(320, 200) });

  await expect(rows(page)).toHaveText([/^harbour\.pngImage.*You, just now.*Only you/]);
  await expect.poll(() => rows(page).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  const [upload] = await perform(page, { type: "upload.list", includeArchived: false });
  await expect(page).toHaveURL(new RegExp(`/uploads/${upload!.id}$`));
  const detail = page.getByRole("complementary", { name: "harbour.png" });
  await expect(detail).toContainText("320 × 200");
  await detail.getByRole("button", { name: "More for harbour.png" }).click();
  await page.getByRole("menu", { name: "More for harbour.png" }).getByRole("menuitem", { name: "Copy embed" }).click();
  await expect(toast(page).filter({ hasText: upload!.id })).toContainText(`::image{${upload!.id} 320x200}`);
  await expect(detail.getByRole("region", { name: "Used in" })).toContainText("No note you can see uses this file.");
  const download = page.waitForEvent("download");
  await detail.getByRole("button", { name: "More for harbour.png" }).click();
  await page.getByRole("menu", { name: "More for harbour.png" }).getByRole("menuitem", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("harbour.png");

  await detail.getByRole("button", { name: "Preview harbour.png" }).click();
  await expect.poll(() => page.getByRole("dialog", { name: "Preview of harbour.png" }).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await page.keyboard.press("Escape");

  const note = await perform(page, { type: "note.create", text: `# Trip\n\n::image{${upload!.id} 320x200}\n` });
  await page.reload();
  await expect(detail.getByRole("region", { name: "Used in" }).getByRole("link", { name: "Trip" })).toBeVisible();
  await detail.getByRole("region", { name: "Used in" }).getByRole("link", { name: "Trip" }).click();
  await expect(page).toHaveURL(new RegExp(`${note.id}$`));
  await expect.poll(() => drawnWidth(page)).toBe(320);
});

test("the Uploads page narrows by name, kind, folder and archived, moves a file, archives it, and makes it private", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Press" });
  const picture = await send(page, "logo.png", png(40, 40), { folderId: folder.id });
  await send(page, "notes.txt", Buffer.from("plain words"));
  await send(page, "clip.mp4", MP4);
  await page.goto("/uploads");
  await expect(rows(page)).toHaveCount(3);

  const query = uploadsPage(page).getByRole("searchbox", { name: "Find uploads" });
  await query.fill("LOG");
  await expect(rows(page)).toHaveText([/^logo\.png/]);
  await query.fill("type:video");
  await expect(rows(page)).toHaveText([/^clip\.mp4Video/]);
  await query.fill("folder:Press");
  await expect(rows(page)).toHaveText([/^logo\.png/]);
  await query.fill("");

  await rows(page).filter({ hasText: "logo.png" }).click();
  const detail = page.getByRole("complementary", { name: "logo.png" });
  const more = detail.getByRole("button", { name: "More for logo.png" });
  const menu = page.getByRole("menu", { name: "More for logo.png" });
  await more.click();
  await menu.getByRole("menuitem", { name: "Move to folder…" }).click();
  await page.getByRole("menu", { name: "Move logo.png to" }).getByRole("menuitem", { name: "Unsorted" }).click();
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: picture.id })).folderId).not.toBe(folder.id);

  await more.click();
  await menu.getByRole("menuitem", { name: "Make private" }).click();
  await expect(rows(page).filter({ hasText: "logo.png" })).toContainText("Only you");
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: picture.id })).private).toBe(true);

  await more.click();
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect(rows(page)).toHaveText([/^clip\.mp4/, /^notes\.txt/]);
  await query.fill("is:archived");
  await expect(rows(page).filter({ hasText: "logo.png" })).toContainText("Archived");
  await more.click();
  await menu.getByRole("menuitem", { name: "Unarchive" }).click();
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: picture.id })).state).toBe("live");
});

test("a picture pasted into a note is sent to the note's folder and written with its size on a line of its own, and pasted text is still text", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Trips" });
  const note = await perform(page, { type: "note.create", text: "# Trip\n\nThe harbour at dusk.", folderId: folder.id });
  await open(page, note.id, "The harbour");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");

  await give(page, "paste", [], { "text/plain": " Plain words." });
  await expect(editor(page)).toContainText("The harbour at dusk. Plain words.");
  await expect.poll(() => perform(page, { type: "upload.list", includeArchived: true })).toEqual([]);

  await give(page, "paste", [{ name: "dusk.png", type: "image/png", bytes: png(320, 200) }]);
  await expect.poll(async () => (await perform(page, { type: "upload.list", includeArchived: false })).map((u) => [u.name, u.folderId, u.private])).toEqual([["dusk.png", folder.id, false]]);
  const [upload] = await perform(page, { type: "upload.list", includeArchived: false });
  await expect.poll(() => noteText(page, note.id)).toBe(`# Trip\n\nThe harbour at dusk. Plain words.\n::image{${upload!.id} 320x200}\n`);
  await expect.poll(() => drawnWidth(page)).toBe(320);
  const box = await below(page, "image").boundingBox();
  expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([320, 200]);
  // The cursor is on the line under the picture, so the line that writes it shows nothing of it.
  await expect(page.locator(".cm-line").nth(3)).toHaveText("");
  await page.keyboard.type("and after");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Trip\n\nThe harbour at dusk. Plain words.\n::image{${upload!.id} 320x200}\nand after`);
  // One change by the member, as typing is.
  const { changes } = await perform(page, { type: "history.list", noteIds: [note.id], diffs: false, limit: 10 });
  expect(changes.every((c) => c.author.kind === "member")).toBe(true);
});

test("a file dropped on a private note is uploaded private, a file that is no picture, video, recording, PDF or text is a chip that downloads, and a file over 50 MB is refused before it is sent", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Diary\n\nWords.\n" });
  await perform(page, { type: "note.setPrivate", id: note.id, private: true });
  await open(page, note.id, "Words.");
  const sent: string[] = [];
  page.on("request", (request) => request.method() === "POST" && /\/uploads$/.test(new URL(request.url()).pathname) && sent.push(request.url()));

  await give(page, "drop", [{ name: "huge.bin", type: "application/octet-stream", size: 50 * 1024 * 1024 + 1 }]);
  await expect(toast(page)).toContainText("huge.bin is 50 MB. A file can be at most 50 MB.");
  expect(sent).toEqual([]);

  await give(page, "drop", [{ name: "minutes.bin", type: "application/octet-stream", bytes: Buffer.from("What was said.") }]);
  await expect.poll(async () => (await perform(page, { type: "upload.list", includeArchived: false })).map((u) => [u.name, u.private, u.kind])).toEqual([["minutes.bin", true, "file"]]);
  const [upload] = await perform(page, { type: "upload.list", includeArchived: false });
  await expect.poll(() => noteText(page, note.id)).toBe(`# Diary\n\nWords.\n::file{${upload!.id}}\n`);
  const chip = editor(page).getByRole("link", { name: "minutes.bin" });
  await expect(chip).toContainText("14 bytes");
  const download = page.waitForEvent("download");
  await chip.click();
  await expect.poll(async () => (await download).suggestedFilename()).toBe("minutes.bin");
});

test("Upload a file in the / menu asks for a file and writes it where the menu was opened", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Trip\n\n" });
  await open(page, note.id, "Trip");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/upl", { delay: 20 });
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Upload a file/, /^Insert an upload/]);
  await settled(page);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "map.png", mimeType: "image/png", buffer: png(200, 100) });
  await expect.poll(async () => (await perform(page, { type: "upload.list", includeArchived: false })).length).toBe(1);
  const [upload] = await perform(page, { type: "upload.list", includeArchived: false });
  await expect.poll(() => noteText(page, note.id)).toBe(`# Trip\n\n::image{${upload!.id} 200x100}\n`);
  await expect.poll(() => drawnWidth(page)).toBe(200);
});

test("with the cursor on a picture's line its text is in that line and nothing moves, and typing elsewhere neither draws the picture again nor asks for it again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const wide = await send(page, "wide.png", png(320, 200));
  const tall = await send(page, "tall.png", png(300, 900));
  const workspaceId = await workspaceOf(page);
  const asked: string[] = [];
  page.on("request", (request) => request.url().includes(`/api/workspaces/${workspaceId}/uploads/`) && asked.push(new URL(request.url()).pathname.slice(-12)));
  await page.setViewportSize({ width: 1600, height: 1900 });
  const note = await perform(page, { type: "note.create", text: `# Pictures\n\nbefore it\n\n::image{${wide.id} 320x200}\n\nbetween them\n\n::image{${tall.id} 300x900}\n\nafter them\n` });
  await open(page, note.id, "after them");
  await expect(picture(page)).toHaveCount(2);
  await expect.poll(() => picture(page).evaluateAll((imgs: HTMLImageElement[]) => imgs.map((img) => img.naturalWidth))).toEqual([320, 300]);
  await expect.poll(async () => (await measured(page)).shown).toEqual((await measured(page)).rooms);
  const before = await measured(page);
  expect(before.rooms.map(([, , width, height]) => [width, height]), "each as large as the note says, narrower than the column").toEqual([
    [320, 200],
    [300, 900],
  ]);

  await picture(page).evaluateAll((imgs) => imgs.forEach((img) => ((img as HTMLImageElement & { marked?: boolean }).marked = true)));
  for (const [lineNumber, written] of [
    [5, `::image{${wide.id} 320x200}`],
    [9, `::image{${tall.id} 300x900}`],
  ] as const) {
    for (const elsewhere of [3, 11, 7]) {
      await goTo(page, elsewhere);
      await settled(page);
      await expect.poll(() => measured(page), `with the cursor on line ${elsewhere}`).toEqual(before);
    }
    await goTo(page, lineNumber);
    await settled(page);
    await expect(page.locator(".cm-line").nth(lineNumber - 1)).toHaveText(written);
    await expect.poll(() => measured(page), `with the cursor on line ${lineNumber}`).toEqual(before);
    await expect(picture(page)).toHaveCount(2);
  }

  await goTo(page, 11);
  await page.keyboard.type(" and more words");
  await goTo(page, 1);
  await page.keyboard.type(" here");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await settled(page);
  await expect.poll(() => picture(page).evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement & { marked?: boolean }).marked === true))).toEqual([true, true]);
  expect(asked.sort(), "each picture's bytes were asked for once").toEqual([wide.id, tall.id].sort());
  await expect.poll(() => measured(page)).toEqual(before);
});

test("a picture's room is its full size before a byte of it has arrived, and a video and a recording wait to be played", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const photo = await send(page, "slow.png", png(320, 200));
  const film = await send(page, "film.mp4", MP4);
  const song = await send(page, "song.mp3", MP3);
  const workspaceId = await workspaceOf(page);
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  await page.route(`**/api/workspaces/${workspaceId}/uploads/${photo.id}`, async (route) => {
    await held;
    await route.continue();
  });
  await page.setViewportSize({ width: 1600, height: 1400 });
  const note = await perform(page, { type: "note.create", text: `# Slow\n\n::image{${photo.id} 320x200}\n\n::video{${film.id} 640x360}\n\n::audio{${song.id}}\n\nafter\n` });
  await open(page, note.id, "after");
  await expect(picture(page)).toHaveCount(1);
  await settled(page);
  await expect.poll(() => picture(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(false);
  const waiting = await measured(page);
  expect(waiting.rooms.map(([, , width, height]) => [width, height])).toEqual([
    [320, 200],
    [640, 360],
    [640, 56],
  ]);
  release();
  await expect.poll(() => drawnWidth(page)).toBe(320);
  await settled(page);
  await expect.poll(() => measured(page)).toEqual(waiting);

  const video = below(page, "video").locator("video");
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect(video).toHaveJSProperty("controls", true);
  await expect(video).toHaveJSProperty("autoplay", false);
  const audio = below(page, "audio").locator("audio");
  await expect(audio).toHaveAttribute("preload", "none");
  await expect(audio).toHaveJSProperty("autoplay", false);
  await expect.poll(() => page.locator(".editor object, .editor embed, .editor iframe").count()).toBe(0);
});

test("quick open finds an upload by its file name and opens the Uploads page on it, and ranks notes as it did", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Harbour walk" });
  await perform(page, { type: "note.create", text: "# The old harbour" });
  const upload = await send(page, "harbour-map.png", png(40, 40));
  const trashed = await send(page, "harbour-old.png", png(40, 40));
  await perform(page, { type: "upload.trash", id: trashed.id });
  await page.goto("/");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await palette.getByRole("combobox").fill("harbour");
  await expect(palette.getByRole("option").locator(".palette-label")).toHaveText(["Harbour walk", "harbour-map.png", "The old harbour"]);
  await palette.getByRole("combobox").fill("walk");
  await expect(palette.getByRole("option").locator(".palette-label")).toHaveText(["Harbour walk"]);
  await palette.getByRole("combobox").fill("harbour-m");
  await expect(palette.getByRole("option")).toHaveText([/^harbour-map\.pngUpload/]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/uploads/${upload.id}$`));
  await expect(page.getByRole("complementary", { name: "harbour-map.png" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "harbour-map.png" })).toHaveAttribute("aria-current", "true");
});

test("a file moved to Trash says so in the notes that use it, comes back when restored, and is a file that isn't available once deleted for good", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "chart.png", png(320, 200));
  const note = await perform(page, { type: "note.create", text: `# Report\n\n::image{${upload.id} 320x200}\n\nafter\n` });
  await open(page, note.id, "after");
  await expect.poll(() => drawnWidth(page)).toBe(320);
  const room = (await measured(page)).rooms;

  await page.goto(`/uploads/${upload.id}`);
  const detail = page.getByRole("complementary", { name: "chart.png" });
  await detail.getByRole("button", { name: "More for chart.png" }).click();
  await page.getByRole("menu", { name: "More for chart.png" }).getByRole("menuitem", { name: "Move to Trash" }).click();
  const confirm = detail.getByRole("group", { name: "Move chart.png to Trash" });
  await expect(confirm).toContainText("1 note still uses this file. It will say it is in Trash until it is restored.");
  await confirm.getByRole("button", { name: "Move to Trash" }).click();
  await expect(toast(page)).toContainText("Moved to Trash. 1 note uses it and now says it is in Trash.");
  await expect(rows(page)).toHaveCount(0);

  await open(page, note.id, "after");
  await expect(drawn(page, "image")).toHaveText(`${IN_TRASH}chart.png`);
  await expect(picture(page)).toHaveCount(0);
  await expect.poll(async () => (await measured(page)).rooms, "the same room").toEqual(room);

  await page.goto("/trash");
  const files = page.getByRole("list", { name: "Files in Trash" });
  await expect(files.getByRole("listitem")).toHaveText([/^chart\.png.*Trashed by Ada Lovelace.*30 days left/]);
  await files.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator(".toast-card").filter({ hasText: "chart.png" })).toContainText("Restored from Trash.");
  await open(page, note.id, "after");
  await expect.poll(() => drawnWidth(page)).toBe(320);

  await perform(page, { type: "upload.trash", id: upload.id });
  await page.goto("/trash");
  await files.getByRole("button", { name: "Delete forever" }).click();
  await page.getByRole("group", { name: "Delete chart.png forever" }).getByRole("button", { name: "Delete forever" }).click();
  await expect(page.getByText("Trash is empty.")).toBeVisible();
  await open(page, note.id, "after");
  await expect(drawn(page, "image")).toHaveText(UNAVAILABLE);
  await expect(page.locator("body")).not.toContainText("chart.png");
  await expect.poll(async () => (await measured(page)).rooms).toEqual(room);
});

test("a member who can't see a file is shown a placeholder of the same size that says nothing of it, and is never sent its bytes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Editor");
  const { workspaceId } = await join(bob, page, "editor");
  const secret = await send(page, "salaries-2026.png", png(320, 200), { private: true });
  const paper = await send(page, "contract-draft.txt", Buffer.from("terms"), { private: true });
  const note = await perform(page, { type: "note.create", text: `# Board\n\n::image{${secret.id} 320x200}\n\nSee ::file{${paper.id}} too.\n\nafter\n` });

  const answered: [string, number][] = [];
  bob.on("response", (response) => /\/api\/.*\/uploads\//.test(response.url()) && answered.push([new URL(response.url()).pathname, response.status()]));
  await open(bob, note.id, "after");
  await expect(drawn(bob, "image")).toHaveText(UNAVAILABLE);
  const box = await below(bob, "image").boundingBox();
  expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([320, 200]);
  await expect(line(bob, "See")).toHaveText(`See ${UNAVAILABLE} too.`);
  await expect(bob.locator(".editor img[src], .editor a[download], .editor video, .editor audio")).toHaveCount(0);
  const html = await bob.content();
  for (const word of ["salaries", "contract-draft", "image/png", "bytes"]) expect(html, word).not.toContain(word);
  expect(answered).toEqual([]);

  const direct = await bob.request.get(`/api/workspaces/${workspaceId}/uploads/${secret.id}`);
  expect(direct.status()).toBe(404);
  await bob.goto("/uploads");
  await expect(uploadsPage(bob)).toContainText("There are no uploads yet.");
  await bob.goto(`/uploads/${secret.id}`);
  await expect(bob.getByRole("complementary", { name: "Upload" })).toContainText("This upload doesn't exist, or you can't see it.");

  // Shared with Bob, it is his to see, and his notes show it.
  await page.goto(`/uploads/${secret.id}`);
  await page.getByRole("complementary", { name: "salaries-2026.png" }).getByRole("button", { name: "More for salaries-2026.png" }).click();
  await page.getByRole("menu", { name: "More for salaries-2026.png" }).getByRole("menuitem", { name: "Share…" }).click();
  const dialog = page.getByRole("dialog", { name: "Share salaries-2026.png" });
  await expect(dialog).toContainText("A file has no link of its own.");
  await expect(dialog.getByRole("combobox", { name: "Link" })).toHaveCount(0);
  const bobEmail = await bob.evaluate(async () => ((await (await fetch("/api/me")).json()) as Me).person.email);
  await dialog.getByRole("textbox", { name: "Email" }).fill(bobEmail);
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("listitem", { name: "Bob Editor" })).toBeVisible();
  await bob.goto(`/note/${note.id}`);
  await expect.poll(() => drawnWidth(bob)).toBe(320);
});

test("a folder's link shows the pictures in the folder by the link's own address, and a note's link shows none", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Handbook" });
  const inside = await send(page, "office-map.png", png(320, 200), { folderId: folder.id });
  const outside = await send(page, "floor-plan.png", png(320, 200));
  const note = await perform(page, { type: "note.create", text: `# Welcome\n\n::image{${inside.id} 320x200}\n\n::image{${outside.id} 320x200}\n\nafter\n`, folderId: folder.id });
  const onFolder = await perform(page, { type: "grant.link", folderId: folder.id, link: "public" });
  const onNote = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  if (onFolder?.to.kind !== "link" || onNote?.to.kind !== "link") throw new Error("no link was made");

  const anyone = await visitor(page);
  const asked: [string, number][] = [];
  anyone.on("response", (response) => /\/api\/.*\/uploads\//.test(response.url()) && asked.push([new URL(response.url()).pathname, response.status()]));
  await anyone.goto(`/s/${onFolder.to.token}#${note.id}`);
  await expect(editor(anyone)).toContainText("after");
  await expect(picture(anyone)).toHaveCount(1);
  await expect.poll(() => drawnWidth(anyone)).toBe(320);
  await expect(drawn(anyone, "image").nth(1)).toHaveText(UNAVAILABLE);
  expect(asked).toEqual([[`/api/shared/${onFolder.to.token}/uploads/${inside.id}`, 200]]);
  await expect(anyone.locator("body")).not.toContainText("floor-plan");

  asked.length = 0;
  await anyone.goto(`/s/${onNote.to.token}`);
  await expect(editor(anyone)).toContainText("after");
  await expect(drawn(anyone, "image")).toHaveText([UNAVAILABLE, UNAVAILABLE]);
  await expect(picture(anyone)).toHaveCount(0);
  const html = await anyone.content();
  for (const word of ["office-map", "floor-plan"]) expect(html).not.toContain(word);
  expect(asked).toEqual([]);
  const { token } = onNote.to;
  await expect.poll(async () => (await anyone.request.get(`/api/shared/${token}/uploads/${inside.id}`)).status()).toBe(404);
});

test("an SVG draws as a picture in a note, and opened by its address it is a download that can run nothing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const upload = await send(page, "diagram.svg", SVG);
  expect([upload.kind, upload.type]).toEqual(["image", "image/svg+xml"]);
  const workspaceId = await workspaceOf(page);
  const note = await perform(page, { type: "note.create", text: `# Diagram\n\n::image{${upload.id} 120x80}\n\nafter\n` });
  await open(page, note.id, "after");
  await expect.poll(() => drawnWidth(page)).toBe(120);
  await expect.poll(() => page.evaluate(() => (window as { hacked?: boolean }).hacked)).toBeUndefined();

  const response = await page.request.get(`/api/workspaces/${workspaceId}/uploads/${upload.id}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(response.headers()["content-security-policy"]).toContain("sandbox");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});

test("deleting a folder that holds a file is refused, with the reason said in the folder tree", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Assets" });
  await send(page, "logo.png", png(40, 40), { folderId: folder.id });
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Folders" });
  await tree.getByRole("treeitem", { name: "Assets" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("alert")).toHaveText("\"Assets\" isn't empty. Move or delete what's in it first. It holds uploads, which the Uploads view lists.");
  await expect.poll(async () => (await perform(page, { type: "folder.list" })).folders.map((f) => f.name)).toContain("Assets");
});

test("with vim on, j and k move through the Uploads list and Enter opens the selected file's details", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  for (const name of ["one.png", "two.png", "three.png"]) await send(page, name, png(8, 8));
  await page.goto("/uploads");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await expect(rows(page)).toHaveCount(3);
  const names = await rows(page).locator(".upload-name").allInnerTexts();
  const selected = (n: number) => expect.poll(() => rows(page).nth(n).evaluate((row) => row.contains(document.activeElement) || row.closest("li")!.contains(document.activeElement))).toBe(true);
  await page.keyboard.press((await page.evaluate(() => document.activeElement instanceof HTMLInputElement)) ? "Escape" : "j");
  await selected(0);
  await page.keyboard.press("j");
  await selected(1);
  await page.keyboard.press("Shift+G");
  await selected(2);
  await page.keyboard.press("k");
  await selected(1);
  await page.keyboard.press("Enter");
  await expect(uploadsPage(page).getByRole("heading", { name: names[1]! })).toBeVisible();
});
