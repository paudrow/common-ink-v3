import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, perform, signInAsNewPerson } from "./helpers.ts";
import { install, openDetails, openPlugins, relist, type Written } from "./third-party-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const GREETER: Written = {
  name: "Greeter",
  version: "1.0",
  description: "Says hello.",
  capabilities: [{ name: "notes.read", reason: "To greet you by your notes." }],
  commands: [{ id: "greet", title: "Greet" }],
};
const GREETER_CODE = `ink.onCommand("greet", () => ink.notify("Hello"));\n`;

/** Installs a plugin as the admin on `page`, and has the app on that page read the record again, so its card is there without waiting on the next reading. */
async function installed(page: Page, ...args: Parameters<typeof install> extends [Page, ...infer Rest] ? Rest : never) {
  const id = await install(page, ...args);
  await relist(page);
  return id;
}

/** The Source section of the details that are open, scrolled to, which is when its files are fetched. */
async function source(page: Page) {
  const section = page.getByRole("region", { name: "Source" });
  await section.scrollIntoViewIfNeeded();
  return section;
}

const filesIn = (section: ReturnType<Page["getByRole"]>) => section.getByRole("combobox", { name: "Source file" });

test("a plugin compiled into the app shows its entry file and what that imports, in colors, to read and not to change", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openPlugins(page);
  await openDetails(page, "Vim mode");
  const section = await source(page);

  const files = filesIn(section);
  await expect(files).toHaveValue("vim/index.ts", { timeout: 15_000 });
  const listed = await files.getByRole("option").allTextContents();
  expect(listed[0]).toBe("vim/index.ts");
  // Vim loads its editing with `import("./editing.ts")`, which is followed like any other import.
  expect(listed).toEqual(expect.arrayContaining(["vim/editing.ts", "vim/jumplist.ts"]));
  expect(new Set(listed).size).toBe(listed.length);
  await expect(section.getByText(`1 of ${listed.length}`)).toBeVisible();

  const shown = section.getByRole("textbox", { name: "Source of vim/index.ts" });
  await expect(shown).toContainText('name: "Vim mode"');
  await expect(shown).toHaveAttribute("aria-readonly", "true");
  await expect(shown).toHaveAttribute("contenteditable", "false");
  await expect(shown.locator(".tok-keyword").first()).toBeVisible();
  await expect(shown.locator(".tok-string").first()).toBeVisible();

  await files.selectOption("vim/jumplist.ts");
  await expect(section.getByRole("textbox", { name: "Source of vim/jumplist.ts" })).toContainText("export");
  await expect(section.getByRole("textbox", { name: "Source of vim/index.ts" })).toHaveCount(0);

  // Only what is shown can be pressed: one list of files, however many there are.
  await expect(section.getByRole("button")).toHaveCount(0);
});

test("a third-party plugin shows its manifest and its code as the workspace has them, to a member who isn't an admin too", async ({ page }) => {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  await join(page, admin, "viewer");
  await install(admin, GREETER, GREETER_CODE);
  const note = await perform(admin, { type: "note.create", text: "# Shared\n" });

  for (const who of [admin, page]) {
    await who.goto(`/note/${note.id}`);
    await expect(who.getByRole("textbox", { name: "Note text" })).toBeVisible();
    await openPlugins(who);
    await openDetails(who, "Greeter");
    const section = await source(who);

    const files = filesIn(section);
    await expect(files.getByRole("option")).toHaveText(["manifest.json", "plugin.js"], { timeout: 15_000 });
    const manifest = section.getByRole("textbox", { name: "Source of manifest.json" });
    await expect(manifest).toContainText('"name": "Greeter"');
    await expect(manifest).toHaveAttribute("aria-readonly", "true");
    await expect(manifest.locator(".tok-propertyName").first()).toBeVisible();

    await files.selectOption("plugin.js");
    const code = section.getByRole("textbox", { name: "Source of plugin.js" });
    await expect(code).toContainText('ink.onCommand("greet"');
    await expect(code.locator(".tok-string").first()).toBeVisible();
  }
});

test("the source shown follows an update of the plugin, with its page left open", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE);
  await openPlugins(page);
  await openDetails(page, "Greeter");
  const section = await source(page);
  await filesIn(section).selectOption("plugin.js");
  await expect(section.getByRole("textbox", { name: "Source of plugin.js" })).toContainText("Hello");

  await perform(page, { type: "plugin.install", manifest: JSON.stringify({ ...GREETER, version: "1.1" }), code: `ink.onCommand("greet", () => ink.notify("Good day"));\n`, replaces: id });

  // The file that was open stays open, with what it holds now.
  await expect(async () => {
    await relist(page);
    await expect(section.getByRole("textbox", { name: "Source of plugin.js" })).toContainText("Good day", { timeout: 2000 });
  }).toPass();
  await filesIn(section).selectOption("manifest.json");
  await expect(section.getByRole("textbox", { name: "Source of manifest.json" })).toContainText('"version": "1.1"');

  // An update that changes the manifest alone leaves the code's name as it was, and is still followed.
  await perform(page, { type: "plugin.install", manifest: JSON.stringify({ ...GREETER, version: "1.2" }), code: `ink.onCommand("greet", () => ink.notify("Good day"));\n`, replaces: id });
  await expect(async () => {
    await relist(page);
    await expect(section.getByRole("textbox", { name: "Source of manifest.json" })).toContainText('"version": "1.2"', { timeout: 2000 });
  }).toPass();
});
