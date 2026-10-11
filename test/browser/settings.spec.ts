import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

/** The member's settings as the server has them. */
const stored = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text) as Record<string, unknown>;
const write = async (page: Page, document: Record<string, unknown>) =>
  perform(page, { type: "settings.write", text: JSON.stringify(document), baseRevision: (await perform(page, { type: "settings.read" })).revision });

const tab = (page: Page, name: "Options" | "JSON") => page.getByRole("tab", { name, exact: true });
const group = (page: Page, name: string) => page.getByRole("tabpanel").getByRole("region", { name, exact: true });
const problems = (page: Page) => page.getByRole("list", { name: "Problems" }).getByRole("listitem");
const json = (page: Page) => page.getByRole("textbox", { name: "Settings JSON" });
const palette = (page: Page) => page.getByRole("dialog", { name: "Commands" });
const noteRow = (page: Page, title: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("link", { name: title, exact: true });
const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

/** Replaces the whole of the JSON, as a member who selects all and types would. */
async function typeJson(page: Page, text: string) {
  await tab(page, "JSON").click();
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

async function openSettings(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Alpha\n\nThe first lines of Alpha." });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

test("changing a setting in the options writes only that value, keeps the member's other keys, and takes it out again at its default", async ({ page }) => {
  await openSettings(page);
  await write(page, { "someone.elses": { kept: [1, 2] } });
  await page.reload();
  const row = group(page, "Common Ink");
  await expect(row.getByRole("combobox", { name: "Theme" })).toHaveValue("system");
  expect(await theme(page)).toBeNull();

  await row.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await theme(page)).toBe("dark");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.theme": "dark" });

  await row.getByRole("spinbutton", { name: "Editor text size" }).fill("150");
  await page.keyboard.press("Enter");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.theme": "dark", "core.editorTextSize": 150 });

  await row.getByRole("combobox", { name: "Theme" }).selectOption("system");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.editorTextSize": 150 });
  expect(await theme(page)).toBeNull();
  await row.getByRole("button", { name: "Reset Editor text size" }).click();
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] } });
  await expect(row.getByRole("spinbutton", { name: "Editor text size" })).toHaveValue("100");
});

test("a value the options won't take is refused there with the reason, and nothing is written", async ({ page }) => {
  await openSettings(page);
  const size = group(page, "Common Ink").getByRole("spinbutton", { name: "Editor text size" });

  await size.fill("500");
  await page.keyboard.press("Enter");

  await expect(group(page, "Common Ink")).toContainText("Expected 200 or less, not 500. Nothing was changed.");
  await expect(size).toHaveAttribute("aria-invalid", "true");
  expect(await stored(page)).toEqual({});
});

test("editing the JSON changes the options and the app, and editing the options changes the JSON", async ({ page }) => {
  await openSettings(page);
  await expect(noteRow(page, "Alpha")).toContainText("The first lines of Alpha.");

  await typeJson(page, '{\n  "note-list.snippets": false,\n  "core.editorTextSize": 120\n}');
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(noteRow(page, "Alpha")).not.toContainText("The first lines of Alpha.");
  expect(await stored(page)).toEqual({ "note-list.snippets": false, "core.editorTextSize": 120 });

  await tab(page, "Options").click();
  await expect(group(page, "Note list").getByRole("checkbox", { name: "Show snippets" })).not.toBeChecked();
  await expect(group(page, "Common Ink").getByRole("spinbutton", { name: "Editor text size" })).toHaveValue("120");

  await group(page, "Note list").getByRole("checkbox", { name: "Show snippets" }).check();
  await expect(noteRow(page, "Alpha")).toContainText("The first lines of Alpha.");
  await tab(page, "JSON").click();
  await expect(json(page)).toHaveText('{  "core.editorTextSize": 120}');
});

test("a plugin's options are listed under it with their schema, and apply without a reload", async ({ page }) => {
  await openSettings(page);
  const noteList = group(page, "Note list");

  await expect(noteList.getByRole("checkbox", { name: "On", exact: true })).toBeChecked();
  await expect(noteList.getByRole("checkbox", { name: "Show snippets" })).toBeChecked();
  await expect(noteList).toContainText("note-list.snippets");
  await expect(noteList).toContainText("Show the first lines of each note under its title.");
  await expect(noteList).toContainText("Default: on");

  await noteList.getByRole("checkbox", { name: "Show snippets" }).uncheck();
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(noteRow(page, "Alpha")).not.toContainText("The first lines of Alpha.");
  await expect.poll(() => stored(page)).toEqual({ "note-list.snippets": false });

  await noteList.getByRole("checkbox", { name: "On", exact: true }).uncheck();
  await expect(page.getByRole("navigation", { name: "Notes" })).toHaveCount(0);
  await expect(noteList).toContainText("Note list is off, so its options change nothing until it is on.");
  await expect(noteList.getByRole("checkbox", { name: "Show snippets" })).not.toBeChecked();
  await expect.poll(() => stored(page)).toEqual({ "note-list.snippets": false, "note-list.enabled": false });
});

test("a value the schema refuses and a key it doesn't know are flagged in the JSON and in the options, and the rest still applies", async ({ page }) => {
  await openSettings(page);

  await typeJson(page, '{"core.theme": "dark", "core.editorTextSize": 500, "core.theem": "light", "keybindings.view.toggleWritingMode": ["cmd+y"]}');

  await expect(problems(page)).toHaveText([
    "core.editorTextSize Expected 200 or less, not 500. The default is used.",
    'keybindings.view.toggleWritingMode "cmd" in "cmd+y" isn\'t a modifier. Use mod, alt, or shift, then one key. The default is used.',
    "core.theem There's no setting by this name. It may belong to a plugin that isn't installed.",
  ]);
  await expect(page.locator(".settings-json .cm-lintRange-error")).toHaveText(["500", '["cmd+y"]']);
  await expect(page.locator(".settings-json .cm-lintRange-warning")).toHaveText(['"core.theem"']);
  await page.locator(".settings-json .cm-lintRange-error").first().hover();
  await expect(page.locator(".cm-tooltip-lint")).toHaveText("Expected 200 or less, not 500. The default is used.");
  expect(await theme(page)).toBe("dark");
  expect(await stored(page)).toEqual({ "core.theme": "dark", "core.editorTextSize": 500, "core.theem": "light", "keybindings.view.toggleWritingMode": ["cmd+y"] });

  await tab(page, "Options").click();
  const core = group(page, "Common Ink");
  await expect(core.getByRole("spinbutton", { name: "Editor text size" })).toHaveValue("100");
  await expect(core.getByRole("spinbutton", { name: "Editor text size" })).toHaveAttribute("aria-invalid", "true");
  await expect(core).toContainText("Expected 200 or less, not 500. The default is used.");
  await expect(group(page, "Keybindings")).toContainText('"cmd" in "cmd+y" isn\'t a modifier.');
  await expect(group(page, "Not recognized")).toContainText("core.theem");

  await group(page, "Not recognized").getByRole("button", { name: "Remove core.theem" }).click();
  await core.getByRole("button", { name: "Reset Editor text size" }).click();
  await expect(problems(page)).toHaveCount(1);
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "keybindings.view.toggleWritingMode": ["cmd+y"] });
});

test("JSON that can't be read is flagged in both views and isn't saved, and the settings stay as they were", async ({ page }) => {
  await openSettings(page);
  await typeJson(page, '{"core.theme": "dark"}');
  await expect(page.getByRole("status")).toHaveText("Saved");

  await typeJson(page, '{"core.theme": "light",');

  await expect(page.getByRole("status")).toHaveText("Not saved until the JSON is fixed");
  await expect(problems(page)).toHaveText(["The JSON can't be read. Settings are one JSON object, such as {}. Your settings stay as they were until it can."]);
  await expect(page.locator(".settings-json .cm-lintRange-error")).not.toHaveCount(0);
  expect(await theme(page)).toBe("dark");
  expect(await stored(page)).toEqual({ "core.theme": "dark" });

  await tab(page, "Options").click();
  await expect(page.getByRole("alert")).toContainText("The JSON has a mistake in it, so nothing can be changed here until it is fixed.");
  await expect(group(page, "Common Ink").getByRole("combobox", { name: "Theme" })).toBeDisabled();

  await page.getByRole("button", { name: "Show the JSON" }).click();
  await expect(json(page)).toHaveText('{"core.theme": "light",');
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(' "core.editorTextSize": 90}');
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await theme(page)).toBe("light");
  expect(await stored(page)).toEqual({ "core.theme": "light", "core.editorTextSize": 90 });
});

test("a keybinding is rebound, unbound, and flagged when it takes another command's key", async ({ page }) => {
  await openSettings(page);
  const app = page.locator(".app");
  const keys = group(page, "Keybindings");
  await page.getByRole("searchbox", { name: "Filter settings" }).fill("writing mode");
  const writing = keys.getByRole("textbox", { name: "Toggle writing mode" });
  await expect(writing).toHaveValue("mod+.");

  await writing.fill("Shift+Mod+Y");
  await page.keyboard.press("Enter");
  await expect(writing).toHaveValue("mod+shift+y");
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleWritingMode": ["mod+shift+y"] });
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();

  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).not.toHaveAttribute("data-writing");
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(app).toHaveAttribute("data-writing", "true");
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(app).not.toHaveAttribute("data-writing");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Toggle writing");
  await expect(palette(page).getByRole("option").first()).toContainText(/Toggle writing mode.*(⇧⌘Y|Ctrl\+Shift\+Y)/);
  await page.keyboard.press("Escape");

  await writing.fill("mod+shift+p");
  await page.keyboard.press("Enter");
  await expect(problems(page)).toHaveText(["keybindings.view.toggleWritingMode mod+shift+p is also the key for Show all commands (commands.show). It runs Toggle writing mode. Show all commands is left with no key."]);
  await expect(keys).toContainText("mod+shift+p is also the key for Show all commands");
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(app).toHaveAttribute("data-writing", "true");
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");

  await writing.fill("");
  await page.keyboard.press("Enter");
  await expect(problems(page)).toHaveCount(0);
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleWritingMode": [] });
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).not.toHaveAttribute("data-writing");

  await keys.getByRole("button", { name: "Reset Toggle writing mode" }).click();
  await expect.poll(() => stored(page)).toEqual({});
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).toHaveAttribute("data-writing", "true");
});

test("settings follow the member to another browser, and plugins turned off are among them", async ({ page, browser }) => {
  const email = `browser-${crypto.randomUUID()}@example.com`;
  const signIn = (p: Page) => p.goto(`/auth/dev?${new URLSearchParams({ email, name: "Ada Lovelace" })}`);
  await signIn(page);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Disable plugin: Sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
  await page.goto("/settings");
  await group(page, "Common Ink").getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect.poll(() => stored(page)).toEqual({ "sidebar.enabled": false, "core.theme": "dark" });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ink.plugins.off")))).toEqual([]);

  const context = await browser.newContext();
  const other = await context.newPage();
  other.on("pageerror", (err) => errors.push(err.message));
  await signIn(other);
  await expect(other.getByRole("navigation", { name: "Notes" })).toBeVisible();
  await expect(other.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
  expect(await theme(other)).toBe("dark");

  await other.goto("/settings");
  await group(other, "Sidebar").getByRole("checkbox", { name: "On", exact: true }).check();
  await expect(other.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect.poll(() => stored(other)).toEqual({ "core.theme": "dark" });

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await context.close();
});

test("the Settings page is there by its address with every plugin off, and from the workspace menu and a command with them on", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins");
  await expect(page.getByRole("checkbox", { name: "Sidebar" })).toBeChecked();
  for (const box of await page.getByRole("checkbox").all()) await box.uncheck();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await group(page, "Sidebar").getByRole("checkbox", { name: "On", exact: true }).check();
  await group(page, "Command palette").getByRole("checkbox", { name: "On", exact: true }).check();

  await page.goto("/");
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: /Ada/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Go to Settings");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
});

test("a plugin that asks to change settings is refused and nothing is written, while its own option is its to read", async ({ page }) => {
  await page.addInitScript(() => {
    interface Handed {
      perform(op: unknown): Promise<unknown>;
      settings: { get(name: string): unknown };
      commands: { register(command: unknown): void };
      views: { register(slot: string, view: unknown): void };
    }
    const outcome = (asked: Promise<unknown>) => asked.then(() => "done", (err: Error) => err.message);
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "greedy",
        name: "Greedy",
        settings: { shout: { type: "boolean", default: false, title: "Shout" } },
        activate(host: Handed) {
          host.views.register("section", { id: "greeting", component: () => (host.settings.get("shout") ? "GREEDY SAYS HELLO" : "greedy says hello") });
          host.commands.register({
            id: "greedy.grab",
            title: "Greedy: change my settings",
            async run() {
              const wrote = await outcome(host.perform({ type: "settings.write", text: '{"core.theme":"dark","greedy.shout":true}' }));
              const read = await outcome(host.perform({ type: "settings.read" }));
              const listed = await outcome(host.perform({ type: "note.list" }));
              (window as unknown as { __GREEDY__: unknown }).__GREEDY__ = { wrote, read, listed, setter: Object.keys(host.settings) };
            },
          });
        },
      },
    ];
  });
  await openSettings(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toContainText("greedy says hello");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Greedy: change my settings");
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as unknown as { __GREEDY__?: unknown }).__GREEDY__)).toEqual({
    wrote: "Greedy can't settings.write: a plugin can't read or change the member's settings",
    read: "Greedy can't settings.read: a plugin can't read or change the member's settings",
    listed: "done",
    setter: ["get", "subscribe"],
  });
  expect(await stored(page)).toEqual({});
  expect(await theme(page)).toBeNull();
  await expect(sidebar).toContainText("greedy says hello");

  await group(page, "Greedy").getByRole("checkbox", { name: "Shout" }).check();
  await expect(sidebar).toContainText("GREEDY SAYS HELLO");
  await expect.poll(() => stored(page)).toEqual({ "greedy.shout": true });
});
