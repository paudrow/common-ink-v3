import { expect, type Page } from "@playwright/test";
import { editOf, openAllNotes, perform, showPanel, signInAsNewPerson, test } from "./helpers.ts";
import { openPlugins } from "./plugins-helpers.ts";

const text = (page: Page) => page.getByRole("textbox", { name: "Note text" });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

test("a plugin whose views and embed throw is left out, the note keeps its typing, and the Plugins page says what failed", async ({ page }) => {
  await page.addInitScript(() => {
    const broken = (what: string) => () => {
      throw new Error(`${what} broke`);
    };
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Broken fixture",
        activate(host: { views: { register(slot: string, view: unknown): void }; embeds: { register(embed: unknown): void } }) {
          host.views.register("column", { id: "broken-column", component: broken("The column") });
          host.views.register("section", { id: "broken-section", component: broken("The section") });
          host.views.register("inspector", { id: "broken-tab", label: "Broken", icon: "info", for: ["note"], component: broken("The tab") });
          host.views.register("editor", { id: "broken-editor", component: broken("The editor area") });
          host.embeds.register({ name: "broken", title: "Broken embed", render: broken("The embed") });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nSee ::broken{} here.\n" });
  await page.goto(`/note/${note.id}`);

  await expect(text(page)).toContainText("See ::broken{} here.");
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  await openAllNotes(page);
  await editOf(page, "Alpha").click();
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed beside a broken plugin");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("typed beside a broken plugin");
  await showPanel(page, "Broken");
  await expect(page.getByRole("complementary", { name: "Inspector" }).locator(".inspector-body")).toBeEmpty();
  await expect(text(page)).toContainText("typed beside a broken plugin");

  await openPlugins(page);
  const failed = page.getByRole("listitem").filter({ hasText: "Broken fixture" }).getByRole("alert");
  for (const what of ["The column broke", "The section broke", "The tab broke", "The editor area broke", "The embed broke"]) await expect(failed).toContainText(what);
  // What failed is text to select and copy: the card's link, laid over the whole card, is not over it.
  await failed.scrollIntoViewIfNeeded();
  expect(
    await failed.evaluate((line) => {
      const { x, y, width, height } = line.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2) === line;
    }),
  ).toBe(true);
  await failed.click({ clickCount: 3 });
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toContain("Failed: The section broke");
  await expect(page).toHaveURL(/\/plugins$/);
  await page.getByRole("checkbox", { name: "Broken fixture" }).uncheck();
  await expect(failed).toHaveCount(0);
});

test("an editor extension that isn't one is left out, the note still opens and takes typing, and the Plugins page says so", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Broken fixture",
        activate(host: { editorExtensions: { register(extension: unknown): void } }) {
          host.editorExtensions.register({ id: "broken", extension: { not: "an extension" } });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha" });
  await page.goto(`/note/${note.id}`);

  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Alpha typed");

  await page.goto("/plugins");
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Broken fixture" }).getByRole("alert")).toContainText("Unrecognized extension value");
});

test("an editor extension given as a function is made for each editor with its own note, in both sides of a split", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { __INK_NOTES_SEEN__: string[] }).__INK_NOTES_SEEN__ = []);
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Per-note fixture",
        activate(host: { editorExtensions: { register(extension: unknown): void } }) {
          host.editorExtensions.register({ id: "per-note", extension: (editor: { noteId: string }) => (seen.push(editor.noteId), []) });
        },
      },
    ];
  });
  const seen = () => page.evaluate(() => [...new Set((window as unknown as { __INK_NOTES_SEEN__: string[] }).__INK_NOTES_SEEN__)].sort());
  await signInAsNewPerson(page, "Ada Lovelace");
  const alpha = await perform(page, { type: "note.create", text: "# Alpha" });
  const beta = await perform(page, { type: "note.create", text: "# Beta" });
  await page.goto(`/note/${alpha.id}`);
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("!");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: alpha.id })).text).toBe("# Alpha!");
  await expect.poll(() => seen()).toEqual([alpha.id]);

  await page.keyboard.press("ControlOrMeta+P");
  await page.keyboard.type("Beta");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Beta");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Split editor right");
  await page.keyboard.press("Enter");

  await expect(text(page)).toHaveCount(2);
  await expect(text(page).nth(0)).toContainText("# Alpha!");
  await expect(text(page).nth(1)).toContainText("# Beta");
  await expect.poll(() => seen()).toEqual([alpha.id, beta.id].sort());
  await text(page).nth(1).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: beta.id })).text).toBe("# Beta typed");
  await openPlugins(page);
  await expect(page.getByRole("checkbox", { name: "Per-note fixture" })).toBeChecked();
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Per-note fixture" }).getByRole("alert")).toHaveCount(0);
});

test("an editor extension whose function throws, or makes what isn't one, is left out of the editor, which still takes typing, and the Plugins page says so", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Broken fixture",
        activate(host: { editorExtensions: { register(extension: unknown): void } }) {
          host.editorExtensions.register({
            id: "throws",
            extension: (editor: { noteId: string }) => {
              throw new Error(`Nothing for the note ${editor.noteId}`);
            },
          });
          host.editorExtensions.register({ id: "wrong", extension: () => ({ not: "an extension" }) });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha" });
  await page.goto(`/note/${note.id}`);

  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Alpha typed");

  await openPlugins(page);
  const failed = page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Broken fixture" }).getByRole("alert");
  await expect(failed).toContainText(`Nothing for the note ${note.id}`);
  await expect(failed).toContainText("Unrecognized extension value");
});
