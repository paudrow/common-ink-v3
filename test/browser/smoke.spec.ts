import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { openAllNotes, pinPanel, signInAsNewPerson, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5b)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("a person signs in, writes a note that outlasts a reload, finds it by search, uploads a file, and shares the note by a link someone with no session opens", async ({ page }) => {
  await signInAsNewPerson(page, "Mary Somerville");
  await expect(page.getByText("Mary's workspace")).toBeVisible();

  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("# Field notes\n\nThe heron came back at dusk.");
  await expect(page).toHaveURL(/\/note\/field-notes-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");
  const noteAddress = new URL(page.url()).pathname;

  await page.reload();
  await expect(page.locator(".cm-line")).toHaveText(["# Field notes", "", "The heron came back at dusk."]);

  await page.goto("/search");
  const search = page.getByRole("region", { name: "Search" });
  await search.getByRole("searchbox", { name: "Search notes" }).fill("heron");
  await expect(search.getByRole("navigation", { name: "Notes" }).locator(".card-title")).toHaveText(["Field notes"]);

  await page.goto("/uploads");
  const uploads = page.getByRole("region", { name: "Uploads" });
  const chooser = page.waitForEvent("filechooser");
  await uploads.getByRole("button", { name: "Upload files" }).click();
  await (await chooser).setFiles({ name: "heron.png", mimeType: "image/png", buffer: png(320, 200) });
  await expect(page.getByRole("list", { name: "Uploads" }).getByRole("link")).toHaveText([/^heron\.png/]);
  await expect.poll(() => page.getByRole("list", { name: "Uploads" }).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);

  await page.goto(noteAddress);
  await expect(editor(page)).toContainText("The heron came back at dusk.");
  await pinPanel(page, "Info");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Share" }).click();
  const share = page.getByRole("dialog", { name: /^Share / });
  await share.getByRole("combobox", { name: "Link" }).selectOption({ label: "Anyone with the link" });
  const address = await share.getByRole("textbox", { name: "Link address" }).inputValue();

  const anyone = await visitor(page);
  await anyone.goto(new URL(address).pathname);
  await expect(editor(anyone)).toContainText("The heron came back at dusk.");
  await expect(editor(anyone)).toHaveAttribute("contenteditable", "false");
  await expect(anyone.locator("body")).not.toContainText("Mary");
});
