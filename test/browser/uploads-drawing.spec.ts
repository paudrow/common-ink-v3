import { expect, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { asViewerOfNote, perform, signInAsNewPerson, test, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const drawingBelow = (page: Page) => page.locator('.embed-below[data-embed="drawing"]');
const picture = (page: Page) => drawingBelow(page).locator("img.upload-drawing");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Edit Drawing" });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));
const DRAWN = /^\/drawing\(([a-z0-9]{12}) (\d+)x(\d+)\)$/m;

/** The PNG the drawing's picture shows, as its `data:` address, once it has loaded. */
const shown = (page: Page) => picture(page).evaluate((img: HTMLImageElement) => (img.complete && img.naturalWidth > 0 ? img.src : ""));
/** How many pixels across and down the drawing's picture is. */
const pixels = (page: Page) => picture(page).evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
const PNG = /^data:image\/png;base64,/;

/** Draws a shape in the open editor by its tool, dragged from one point of the canvas to another, right of the panel of its properties. */
async function drawShape(page: Page, tool: "Rectangle" | "Ellipse", from: [number, number], to: [number, number]) {
  await dialog(page).getByTitle(new RegExp(`^${tool} `)).click();
  const canvas = (await dialog(page).locator("canvas.interactive").boundingBox())!;
  await page.mouse.move(canvas.x + from[0], canvas.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(canvas.x + to[0], canvas.y + to[1], { steps: 8 });
  await page.mouse.up();
}

/** Sends a file as the signed-in person. */
function send(page: Page, name: string, text: string, more: { folderId?: string } = {}): Promise<Upload> {
  return page.evaluate(
    async ({ name, text, more }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name, ...more })) }, body: text });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, text, more },
  );
}

/** A scene as an agent writes one: two elements with only what Excalidraw needs, and no picture saved with it. */
const AGENT_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [
    { id: "box", type: "rectangle", x: 0, y: 0, width: 200, height: 100, strokeColor: "#1e1e1e", backgroundColor: "#ffc9c9", fillStyle: "solid", strokeWidth: 2, roughness: 0, version: 1, seed: 1 },
    { id: "words", type: "text", x: 40, y: 140, width: 120, height: 25, text: "Hello", fontSize: 20, fontFamily: 5, version: 1, seed: 2 },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

test("/drawing writes an empty drawing, Edit drawing opens Excalidraw, and each save is a new upload the embed names, drawn in the note, kept after a reload, and taken back by undo", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Sketch\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Sketch");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/drawing", { delay: 20 });
  await expect(page.getByRole("option", { name: /^Drawing/ })).toHaveText("DrawingShapes, arrows and words drawn by hand in Excalidraw");
  await settled(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toBe("# Sketch\n\n/drawing()");

  await drawingBelow(page).getByRole("button", { name: "Edit drawing" }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator("canvas.interactive")).toBeVisible();
  await drawShape(page, "Rectangle", [400, 250], [620, 390]);
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toMatch(DRAWN);
  const [, first, width, height] = DRAWN.exec(await noteText(page, note.id))!;
  expect(Number(width), "the rectangle with room around it").toBeGreaterThan(220);
  expect(Number(height)).toBeGreaterThan(140);
  await expect.poll(() => shown(page)).toMatch(PNG);
  const once = await shown(page);
  expect(await pixels(page), "twice the size the note keeps for it").toEqual([Number(width) * 2, Number(height) * 2]);

  const scene = JSON.parse(await page.evaluate(async (id) => (await (await fetch(`/api/workspaces/${((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id}/uploads/${id}`)).text()), first!));
  expect(scene.type, "the upload is the scene, as Excalidraw writes its file").toBe("excalidraw");
  expect(scene.elements.map((e: { type: string }) => e.type)).toEqual(["rectangle"]);
  expect(scene.preview.image).toBe(once);

  await picture(page).hover();
  await drawingBelow(page).getByRole("button", { name: "Edit drawing" }).click();
  await expect(dialog(page).locator("canvas.interactive")).toBeVisible();
  await drawShape(page, "Ellipse", [700, 250], [860, 380]);
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => DRAWN.exec(await noteText(page, note.id))?.[1]).not.toBe(first);
  await expect.poll(() => shown(page)).not.toBe(once);
  const twice = await shown(page);
  const [, , wider] = DRAWN.exec(await noteText(page, note.id))!;
  expect(Number(wider), "wider by the ellipse beside the rectangle").toBeGreaterThan(Number(width));

  await page.reload();
  await expect.poll(() => shown(page)).toBe(twice);

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => DRAWN.exec(await noteText(page, note.id))?.[1], "undo names the drawing before").toBe(first);
  await expect.poll(() => shown(page)).toBe(once);
});

test("in the editor every key is Excalidraw's, its own dialogs show over it, and what is behind it can't be reached", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Keys\n\n/drawing()\n\nwords" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("words");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" more");
  await expect.poll(() => noteText(page, note.id)).toBe("# Keys\n\n/drawing()\n\nwords more");
  await drawingBelow(page).getByRole("button", { name: "Edit drawing" }).click();
  await drawShape(page, "Rectangle", [400, 250], [620, 390]);
  await expect(dialog(page).getByRole("button", { name: "Undo" })).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(dialog(page).getByRole("button", { name: "Undo" }), "Excalidraw undid the rectangle").toBeDisabled();
  expect(await noteText(page, note.id), "and the note's typing is still there").toBe("# Keys\n\n/drawing()\n\nwords more");
  await dialog(page).getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("dialog", { name: /Help/ }).or(page.locator(".HelpDialog"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".HelpDialog")).toHaveCount(0);
  expect(await page.locator("#root").evaluate((root) => root.closest("[inert]") !== null), "the app behind is inert").toBe(true);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.locator("#root").evaluate((root) => root.closest("[inert]") !== null)).toBe(false);
});

test("a drawing saved in a private note in a folder is kept in that folder and private, and one whose upload is no scene says it can't be read", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Plans" });
  const note = await perform(page, { type: "note.create", text: "# Private\n\n/drawing()\n", folderId: folder.id });
  await perform(page, { type: "note.setPrivate", id: note.id, private: true });
  await page.goto(`/note/${note.id}`);
  await drawingBelow(page).getByRole("button", { name: "Edit drawing" }).click();
  await drawShape(page, "Rectangle", [400, 250], [620, 390]);
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toMatch(DRAWN);
  const kept = await perform(page, { type: "upload.read", id: DRAWN.exec(await noteText(page, note.id))![1]! });
  expect([kept.name, kept.folderId, kept.private]).toEqual(["Drawing.excalidraw", folder.id, true]);

  const words = await send(page, "notes.excalidraw", "not a scene");
  const other = await perform(page, { type: "note.create", text: `# Other\n\n/drawing(${words.id} 300x200)\n` });
  await page.goto(`/note/${other.id}`);
  await expect(drawingBelow(page)).toContainText("This drawing can't be read");
  await expect(drawingBelow(page).getByRole("button", { name: "Edit drawing" })).toHaveCount(0);
});

/** The red, green and blue of the drawing's picture as it is drawn on screen, at a point given as fractions of its width and height. */
async function drawnAt(page: Page, x: number, y: number) {
  const shot = (await picture(page).screenshot()).toString("base64");
  return page.evaluate(
    async ({ shot, x, y }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const pen = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
      pen.drawImage(img, 0, 0);
      return [...pen.getImageData(Math.floor(img.width * x), Math.floor(img.height * y), 1, 1).data].slice(0, 3);
    },
    { shot, x, y },
  );
}

test("a drawing is shown in the app's theme as Excalidraw shows it while it is edited, light, dark and in Night shift, and the drawing kept is the same in each", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const drawn = await send(page, "Drawing.excalidraw", AGENT_SCENE);
  const written = `# Themed\n\n/drawing(${drawn.id} 232x197)\n`;
  const note = await perform(page, { type: "note.create", text: written });
  /** The paper between the box and the word, and the picture's address, with these settings. */
  const look = async (settings: Record<string, unknown>) => {
    await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: (await perform(page, { type: "settings.read" })).revision });
    await page.goto(`/note/${note.id}`);
    await expect.poll(() => shown(page)).toMatch(PNG);
    await settled(page);
    return { paper: await drawnAt(page, 0.5, 0.66), image: await shown(page) };
  };

  const light = await look({ "core.theme": "light" });
  expect(light.paper).toEqual([255, 255, 255]);
  // Excalidraw's dark theme turns white to its #121212.
  const dark = await look({ "core.theme": "dark" });
  expect(dark.paper).toEqual([18, 18, 18]);
  expect(dark.image, "the same picture, drawn another way").toBe(light.image);
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await look({})).paper, "the device's dark, with the theme left to it").toEqual([18, 18, 18]);
  expect((await look({ "core.theme": "light" })).paper, "the light theme, set over the device's dark").toEqual([255, 255, 255]);
  const night = await look({ "core.theme": "light", "night-shift.enabled": true });
  expect(night.paper).toEqual([18, 18, 18]);
  expect(night.image).toBe(light.image);
  const tinted = await look({ "core.theme": "light", "night-shift.enabled": true, "night-shift.tint": true });
  expect(tinted.paper, "dark, and tinted as every picture is").not.toEqual(night.paper);
  expect(tinted.paper[2], "with no blue, as the tint leaves none").toBe(0);
  expect(tinted.image).toBe(light.image);

  expect(await noteText(page, note.id)).toBe(written);
  expect((await perform(page, { type: "upload.read", id: drawn.id })).size).toBe(drawn.size);
});

test("a photo in a drawing stays the right way round in the dark, as Excalidraw's dark theme keeps it, and the drawing turns dark as the device does", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const white = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
    const pen = canvas.getContext("2d")!;
    pen.fillStyle = "#ffffff";
    pen.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  });
  const scene = JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "photo", type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "white", status: "saved", scale: [1, 1], strokeColor: "transparent", version: 1, seed: 3 },
      { id: "box", type: "rectangle", x: 140, y: 0, width: 100, height: 100, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeWidth: 2, roughness: 0, version: 1, seed: 4 },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: { white: { id: "white", mimeType: "image/png", dataURL: white, created: 1 } },
  });
  const drawn = await send(page, "Photo.excalidraw", scene);
  const note = await perform(page, { type: "note.create", text: `# Photo\n\n/drawing(${drawn.id} 272x132)\n` });
  await page.goto(`/note/${note.id}`);
  await expect.poll(() => shown(page)).toMatch(PNG);
  await settled(page);
  /** The middle of the photo, and the paper between it and the box. */
  const seen = async () => ({ photo: await drawnAt(page, 0.24, 0.5), paper: await drawnAt(page, 0.5, 0.5) });
  expect(await seen()).toEqual({ photo: [255, 255, 255], paper: [255, 255, 255] });

  const light = await shown(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => shown(page), "drawn again, dark").not.toBe(light);
  await settled(page);
  const dark = await seen();
  expect(Math.max(...dark.paper), "dark paper").toBeLessThan(40);
  expect(Math.min(...dark.photo), "a white photo, still light").toBeGreaterThan(200);
});

test("Cancel leaves a drawing as it was, and a drawing is sized with its handle as a picture is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const drawn = await send(page, "Drawing.excalidraw", AGENT_SCENE);
  const note = await perform(page, { type: "note.create", text: `# Sized\n\n/drawing(${drawn.id} 232x197)\n\nafter\n` });
  await page.goto(`/note/${note.id}`);
  await expect.poll(() => shown(page)).toMatch(PNG);

  await picture(page).hover();
  await drawingBelow(page).getByRole("button", { name: "Edit drawing" }).click();
  await drawShape(page, "Rectangle", [400, 250], [600, 400]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await noteText(page, note.id)).toBe(`# Sized\n\n/drawing(${drawn.id} 232x197)\n\nafter\n`);

  const size = page.getByRole("slider", { name: "Size of Drawing.excalidraw" });
  await size.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Sized\n\n/drawing(${drawn.id} 232x197 10%)\n\nafter\n`);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Sized\n\n/drawing(${drawn.id} 232x197 15%)\n\nafter\n`);
  await settled(page);
  const box = (await drawingBelow(page).boundingBox())!;
  expect(Math.round((box.width / box.height) * 100) / 100, "at the drawing's shape").toBe(Math.round((232 / 197) * 100) / 100);
});

test("a member who can't change the note sees a drawing an agent wrote, drawn from its scene, with no Edit drawing and no size handle", async ({ page }) => {
  const { admin } = await asViewerOfNote(page, "# Seen\n");
  const drawn = await send(admin, "Drawing.excalidraw", AGENT_SCENE);
  const note = await perform(admin, { type: "note.create", text: `# Plan\n\n/drawing(${drawn.id})\n\n/drawing()\n\nafter\n` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("after");
  await expect.poll(() => shown(page)).toMatch(PNG);
  expect(await pixels(page), "the box and the words under it, with room around them, twice over").toEqual([464, 394]);
  await picture(page).hover();
  await expect(page.getByRole("button", { name: "Edit drawing" })).toHaveCount(0);
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(drawingBelow(page).nth(1)).toContainText("An empty drawing");
});

test("a folder's link shows a drawing, with no Edit drawing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Handbook" });
  const drawn = await send(page, "Drawing.excalidraw", AGENT_SCENE, { folderId: folder.id });
  const note = await perform(page, { type: "note.create", text: `# Welcome\n\n/drawing(${drawn.id} 232x197)\n\nafter\n`, folderId: folder.id });
  const link = await perform(page, { type: "grant.link", folderId: folder.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const anyone = await visitor(page);
  await anyone.goto(`/s/${link.to.token}#${note.id}`);
  await expect(editor(anyone)).toContainText("after");
  await expect.poll(() => shown(anyone)).toMatch(PNG);
  expect(await pixels(anyone)).toEqual([464, 394]);
  await picture(anyone).hover();
  await expect(anyone.getByRole("button", { name: "Edit drawing" })).toHaveCount(0);
});
