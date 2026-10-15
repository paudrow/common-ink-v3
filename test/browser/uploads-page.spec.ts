import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { anotherPerson, join, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const uploadsPage = (page: Page) => page.getByRole("region", { name: "Uploads" });
const rows = (page: Page) => page.getByRole("list", { name: "Uploads" }).getByRole("link");
const row = (page: Page, name: string) => rows(page).filter({ has: page.locator(".upload-name", { hasText: new RegExp(`^${name.replace(".", "\\.")}$`) }) });
const field = (page: Page) => uploadsPage(page).getByRole("searchbox", { name: "Find uploads" });
const whose = (page: Page, name: "Mine" | "Everyone's") => uploadsPage(page).getByRole("group", { name: "Whose uploads" }).getByRole("button", { name });
const builder = (page: Page) => uploadsPage(page).getByRole("group", { name: "Advanced filter" });
const condition = (page: Page, n: number) => builder(page).getByRole("group", { name: `Condition ${n}` });
const toast = (page: Page) => page.getByRole("group", { name: "Notice" });
const popover = (page: Page) => page.getByRole("dialog", { name: "Insert an upload" });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

/** A PNG of one colour, `width` by `height`, that a browser decodes. */
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
  const line = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([91, 91, 214]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => line)))), chunk("IEND", Buffer.alloc(0))]);
}

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

/** Opens `path` in a workspace the person is in, as the one they last chose. */
async function inWorkspace(page: Page, workspaceId: string, path: string) {
  await page.evaluate((id) => localStorage.setItem("ink.workspace", JSON.stringify(id)), workspaceId);
  await page.goto(path);
}

/** Ada's workspace with Bob in it as an editor, and a folder they both see. */
async function team(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Babbage");
  const { workspaceId } = await join(bob, page, "editor");
  const folder = await perform(page, { type: "folder.create", name: "Team" });
  return { bob, workspaceId, folder };
}

test("the page has one Upload files and no folder to upload to, and a file sent from it is the uploader's alone until it is in a note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/uploads");
  await expect(uploadsPage(page)).toContainText("There are no uploads yet.");
  await expect(uploadsPage(page).getByRole("combobox")).toHaveCount(0);
  await expect(uploadsPage(page).getByRole("button", { name: /upload/i })).toHaveText(["Upload files"]);

  const chooser = page.waitForEvent("filechooser");
  await uploadsPage(page).getByRole("button", { name: "Upload files" }).click();
  await (await chooser).setFiles({ name: "harbour.png", mimeType: "image/png", buffer: png(320, 200) });
  await expect(toast(page)).toContainText("Uploaded harbour.png. Only you can see it until you put it in a note.");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "harbour.png").locator(".upload-meta")).toHaveText(/^Image.*You, just now.*Only you$/);
  const [upload] = await perform(page, { type: "upload.list" });
  expect(upload!.private).toBe(true);
  expect(upload!.uses).toBe(0);
});

test("each row says who uploaded it and how far it is seen, to Ada and to Bob, and nothing of what Bob can't see", async ({ page }) => {
  const { bob, workspaceId, folder } = await team(page);
  const plan = await send(page, "plan.png", png(40, 30), { folderId: folder.id });
  const shared = await send(page, "shared.png", png(40, 30), { folderId: folder.id });
  const secret = await send(page, "secret.png", png(40, 30), { private: true });
  await send(page, "loose.png", png(40, 30), { folderId: folder.id });
  await send(bob, "bobs.png", png(40, 30), { folderId: folder.id }, workspaceId);
  await perform(page, { type: "note.create", folderId: folder.id, text: `# Plan\n\n::image{${plan.id} 40x30}\n` });
  // Ada's private note shows two files: hers to count, and nothing Bob is told of.
  const diary = await perform(page, { type: "note.create", folderId: folder.id, text: `# Diary\n\n::image{${shared.id} 40x30}\n\n::image{${secret.id} 40x30}\n` });
  await perform(page, { type: "note.setPrivate", id: diary.id, private: true });
  await perform(page, { type: "note.create", folderId: folder.id, text: `# Board\n\n::image{${shared.id} 40x30}\n` });

  await page.goto("/uploads");
  await expect(rows(page)).toHaveCount(5);
  const said = (on: Page, name: string) => row(on, name).locator(".upload-meta");
  await expect(said(page, "plan.png")).toHaveText(/You, just now.*In 1 note$/);
  await expect(said(page, "shared.png")).toHaveText(/You, just now.*In 2 notes$/);
  await expect(said(page, "secret.png")).toHaveText(/You, just now.*Only you$/);
  await expect(said(page, "loose.png")).toHaveText(/You, just now.*Not in a note$/);
  await expect(said(page, "bobs.png")).toHaveText(/Bob Babbage, just now.*Not in a note$/);

  await inWorkspace(bob, workspaceId, "/uploads");
  await expect(rows(bob)).toHaveCount(4);
  await expect(said(bob, "plan.png")).toHaveText(/Ada Lovelace, just now.*In 1 note$/);
  await expect(said(bob, "shared.png")).toHaveText(/Ada Lovelace, just now.*In 1 note$/);
  await expect(said(bob, "loose.png")).toHaveText(/Ada Lovelace, just now.*Not in a note$/);
  await expect(said(bob, "bobs.png")).toHaveText(/You, just now.*Not in a note$/);
  await expect(uploadsPage(bob)).not.toContainText("secret");
  await expect(uploadsPage(bob)).not.toContainText("Only you");
});

test("Mine and Everyone's write uploader:@me into the query and take it out, around what else was typed", async ({ page }) => {
  const { bob, workspaceId, folder } = await team(page);
  await send(page, "adas.png", png(8, 8), { folderId: folder.id });
  await send(page, "adas.txt", Buffer.from("words"), { folderId: folder.id });
  await send(bob, "bobs.png", png(8, 8), { folderId: folder.id }, workspaceId);
  await page.goto("/uploads");
  await expect(rows(page)).toHaveCount(3);
  await expect(whose(page, "Everyone's")).toHaveAttribute("aria-pressed", "true");
  await expect(whose(page, "Mine")).toHaveAttribute("aria-pressed", "false");

  await whose(page, "Mine").click();
  await expect(field(page)).toHaveValue("uploader:@me");
  await expect(whose(page, "Mine")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).locator(".upload-name")).toHaveText(["adas.txt", "adas.png"]);

  await field(page).fill("type:image uploader:@me");
  await expect(rows(page).locator(".upload-name")).toHaveText(["adas.png"]);
  await whose(page, "Everyone's").click();
  await expect(field(page)).toHaveValue("type:image");
  await expect(whose(page, "Everyone's")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).locator(".upload-name")).toHaveText(["bobs.png", "adas.png"]);
  // Typed, @me is the same switch.
  await field(page).fill("type:image uploaded-by:@me");
  await expect(whose(page, "Mine")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).locator(".upload-name")).toHaveText(["adas.png"]);
});

test("a query typed in the bar and one built in Advanced find the same uploads, each written in the other", async ({ page }) => {
  const { bob, workspaceId, folder } = await team(page);
  const used = await send(page, "used.png", png(8, 8), { folderId: folder.id });
  await send(page, "spare.png", png(8, 8), { folderId: folder.id });
  await send(page, "minutes.txt", Buffer.from("words"), { folderId: folder.id });
  await send(bob, "bobs.png", png(8, 8), { folderId: folder.id }, workspaceId);
  await perform(page, { type: "note.create", folderId: folder.id, text: `# Plan\n\n::image{${used.id} 8x8}\n` });
  await page.goto("/uploads");
  await expect(rows(page)).toHaveCount(4);

  await field(page).fill("type:image used:no");
  await expect(rows(page).locator(".upload-name")).toHaveText(["bobs.png", "spare.png"]);
  await uploadsPage(page).getByRole("button", { name: "Advanced" }).click();
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(2);
  await expect(condition(page, 1).getByRole("combobox", { name: "Field" })).toHaveValue("type");
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" })).toHaveValue("image");
  await expect(condition(page, 2).getByRole("combobox", { name: "Field" })).toHaveValue("used");
  await expect(condition(page, 2).getByRole("combobox", { name: "Value" })).toHaveValue("no");

  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await expect(condition(page, 3).getByRole("combobox", { name: "Field" }).getByRole("option")).toHaveText(["Words", "Folder", "Name", "Type", "Uploader", "Used", "Size", "Uploaded", "State", "Visibility"]);
  await condition(page, 3).getByRole("combobox", { name: "Field" }).selectOption({ label: "Uploader" });
  await condition(page, 3).getByRole("combobox", { name: "Value" }).fill("Bob Babbage");
  await expect(field(page)).toHaveValue('type:image used:no uploader:"Bob Babbage"');
  await expect(rows(page).locator(".upload-name")).toHaveText(["bobs.png"]);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("name-asc");
  await condition(page, 3).getByRole("button", { name: "Remove condition 3" }).click();
  await expect(field(page)).toHaveValue("type:image used:no sort:name-asc");
  await expect(rows(page).locator(".upload-name")).toHaveText(["bobs.png", "spare.png"]);

  // The arrow of a select in the builder sits where every other select's does: 8px in from its right edge, with the words kept clear of it.
  const arrow = await condition(page, 1).getByRole("combobox", { name: "Field" }).evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.paddingRight, style.backgroundPositionX];
  });
  expect(arrow).toEqual(["24px", "calc(100% - 8px)"]);
});

test("the details card shows Open and one … menu, which the keyboard opens and leaves, and does what the old buttons did", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const press = await perform(page, { type: "folder.create", name: "Press" });
  const upload = await send(page, "logo.png", png(40, 30));
  await page.goto(`/uploads/${upload.id}`);
  const card = page.getByRole("complementary", { name: "logo.png" });
  await expect(card.getByRole("region", { name: "Used in" })).toBeVisible();
  await expect(card.getByRole("button")).toHaveText(["", "", "Open", ""]);
  await expect(card.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Preview logo.png" })).toBeVisible();
  const more = card.getByRole("button", { name: "More for logo.png" });
  await expect(card.locator("select, input, textarea, a[download]")).toHaveCount(0);

  const menu = page.getByRole("menu", { name: "More for logo.png" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem")).toHaveText(["Download", "Share…", "Copy embed", "Move to folder…", "Make private", "Archive", "Move to Trash"]);
  await expect(menu.getByRole("menuitem", { name: "Download" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Share…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  // Shift+F10 anywhere in the card opens it too.
  await card.getByRole("button", { name: "Open", exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Download" })).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Make private" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: upload.id })).private).toBe(true);
  await expect(more).toBeFocused();
  await expect(card.locator(".upload-meta")).toContainText("Only you");

  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "Share with the folder" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Move to folder…" }).click();
  const folders = page.getByRole("menu", { name: "Move logo.png to" });
  await expect(folders.getByRole("menuitem")).toHaveText(["Unsorted (here)", "Press"]);
  await expect(folders.getByRole("menuitem", { name: "Press" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: upload.id })).folderId).toBe(press.id);
  await expect(more).toBeFocused();

  await page.keyboard.press("Enter");
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: upload.id })).state).toBe("archived");
  await more.click();
  await menu.getByRole("menuitem", { name: "Unarchive" }).click();
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: upload.id })).state).toBe("live");

  const download = page.waitForEvent("download");
  await more.click();
  await menu.getByRole("menuitem", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("logo.png");
});

test("Insert an upload in the / menu finds a file by the keyboard, writes it at the cursor, and puts it where the note's readers see it", async ({ page }) => {
  const { bob, workspaceId, folder } = await team(page);
  const harbour = await send(page, "harbour.png", png(320, 200), { private: true });
  await send(page, "minutes.txt", Buffer.from("words"), { private: true });
  await send(page, "older-harbour.png", png(20, 10), { private: true });
  const note = await perform(page, { type: "note.create", folderId: folder.id, text: "# Trip\n\nThe view:\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("The view:");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/ins", { delay: 20 });
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Insert an upload/]);
  await settled(page);
  await page.keyboard.press("Enter");

  const find = popover(page).getByRole("combobox", { name: "Find an upload" });
  await expect(find).toBeFocused();
  // The latest first, each with a picture or a kind's icon and when it came.
  await expect(popover(page).getByRole("option")).toHaveText([/^older-harbour\.png/, /^minutes\.txt/, /^harbour\.png/]);
  await expect(popover(page).getByRole("option").first().locator("img")).toHaveCount(1);
  await expect(popover(page).getByRole("option").nth(1).locator("img")).toHaveCount(0);
  await expect(popover(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("harbour");
  await expect(popover(page).getByRole("option")).toHaveText([/^older-harbour\.png/, /^harbour\.png/]);
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).getByRole("option", { name: /^harbour\.png/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(popover(page).getByRole("option", { name: /^harbour\.png/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toBe(`# Trip\n\nThe view:\n::image{${harbour.id} 320x200}\n`);
  await expect.poll(async () => (await perform(page, { type: "upload.read", id: harbour.id })).private).toBe(false);
  expect((await perform(page, { type: "upload.read", id: harbour.id })).folderId).toBe(folder.id);
  // The keyboard is back in the note, on the line after the picture.
  await page.keyboard.type("After.");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Trip\n\nThe view:\n::image{${harbour.id} 320x200}\nAfter.`);

  await inWorkspace(bob, workspaceId, `/note/${note.id}`);
  await expect.poll(() => bob.locator('.embed-below[data-embed="image"] img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
});

test("Escape closes the popover and leaves the note as it was before the /, and a file is written as a chip at the cursor", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const minutes = await send(page, "minutes.txt", Buffer.from("words"));
  const note = await perform(page, { type: "note.create", text: "# Board\n\nRead " });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Read");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/insert", { delay: 20 });
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Insert an upload/]);
  await settled(page);
  await page.keyboard.press("Tab");
  await expect(popover(page).getByRole("option")).toHaveText([/^minutes\.txt/]);
  await page.keyboard.type("nothing like it");
  await expect(popover(page)).toContainText("No uploads match.");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => noteText(page, note.id)).toBe("# Board\n\nRead ");
  await page.keyboard.type("on");
  await expect.poll(() => noteText(page, note.id)).toBe("# Board\n\nRead on");

  await page.keyboard.type(" /insert", { delay: 20 });
  await settled(page);
  await page.keyboard.press("Tab");
  await expect(popover(page).getByRole("option")).toHaveText([/^minutes\.txt/]);
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Board\n\nRead on ::file{${minutes.id}}`);
  await page.keyboard.type(" first.");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Board\n\nRead on ::file{${minutes.id}} first.`);
});

test("an inserted video, and a picture whose size the server couldn't read, are written with the size this browser reads, as a pasted one is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const video = await send(page, "box.webm", readFileSync(new URL("./fixtures/moving-box.webm", import.meta.url)));
  const svg = await send(page, "shape.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>'));
  expect([video.width, svg.width]).toEqual([null, null]);
  const note = await perform(page, { type: "note.create", text: "# Clips\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Clips");
  for (const [name, written] of [["box.webm", `::video{${video.id} 320x180}`], ["shape.svg", `::image{${svg.id} 120x80}`]] as const) {
    await editor(page).focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/insert", { delay: 20 });
    await settled(page);
    await page.keyboard.press("Tab");
    await page.keyboard.type(name.split(".")[0]!);
    await expect(popover(page).getByRole("option")).toHaveText([new RegExp(`^${name.replace(".", "\\.")}`)]);
    await page.keyboard.press("Enter");
    await expect.poll(() => noteText(page, note.id)).toContain(written);
  }
});
