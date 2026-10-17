import { expect, test, type Page } from "@playwright/test";
import { noteCard, openAllNotes, perform, pinPanel, signInAsNewPerson } from "./helpers.ts";
import { category, group, json, openJson, openOptions, setPlugin, typeJson } from "./settings-helpers.ts";

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

const problems = (page: Page) => page.getByRole("list", { name: "Problems" }).getByRole("listitem");
const palette = (page: Page) => page.getByRole("dialog", { name: "Commands" });
const snippet = (page: Page, title: string) => noteCard(page, title).locator(".card-preview");
/** Goes back to the Settings page from the list of notes that was opened over it. */
async function backToSettings(page: Page) {
  await page.goBack();
  await expect(page).toHaveURL(/\/settings(\/|$)/);
}
const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

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
  const themeBox = page.getByRole("combobox", { name: "Theme" });
  const size = page.getByRole("spinbutton", { name: "Editor text size" });
  await category(page, "Appearance");
  await expect(themeBox).toHaveValue("system");
  await expect.poll(() => theme(page)).toBeNull();

  await themeBox.selectOption("dark");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(() => theme(page)).toBe("dark");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.theme": "dark" });

  const editor = await category(page, "Editor");
  await expect(themeBox).toHaveCount(0);
  await size.fill("150");
  await page.keyboard.press("Enter");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.theme": "dark", "core.editorTextSize": 150 });

  await category(page, "Appearance");
  await themeBox.selectOption("system");
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] }, "core.editorTextSize": 150 });
  await expect.poll(() => theme(page)).toBeNull();
  await category(page, "Editor");
  await editor.getByRole("button", { name: "Reset Editor text size" }).click();
  await expect.poll(() => stored(page)).toEqual({ "someone.elses": { kept: [1, 2] } });
  await expect(size).toHaveValue("100");
});

test("a value the options won't take is refused there with the reason, and nothing is written", async ({ page }) => {
  await openSettings(page);
  const size = group(page, "Editor").getByRole("spinbutton", { name: "Editor text size" });

  await size.fill("500");
  await page.keyboard.press("Enter");

  await expect(group(page, "Editor")).toContainText("Expected 200 or less, not 500. Nothing was changed.");
  await expect(size).toHaveAttribute("aria-invalid", "true");
  await expect.poll(() => stored(page)).toEqual({});
});

test("editing the JSON changes the options and the app, and editing the options changes the JSON", async ({ page }) => {
  await openSettings(page);
  await openAllNotes(page);
  await expect(snippet(page, "Alpha")).toHaveText("The first lines of Alpha.");
  await backToSettings(page);

  await typeJson(page, '{\n  "note-list.snippets": false,\n  "core.editorTextSize": 120\n}');
  await expect(page.getByRole("status")).toHaveText("Saved");
  await openAllNotes(page);
  await expect(noteCard(page, "Alpha")).toBeVisible();
  await expect(noteCard(page, "Alpha")).not.toContainText("The first lines of Alpha.");
  await expect.poll(() => stored(page)).toEqual({ "note-list.snippets": false, "core.editorTextSize": 120 });
  await backToSettings(page);

  await openOptions(page);
  await expect(group(page, "Editor").getByRole("spinbutton", { name: "Editor text size" })).toHaveValue("120");
  const noteList = await category(page, "Note list");
  await expect(noteList.getByRole("checkbox", { name: "Show snippets" })).not.toBeChecked();

  await noteList.getByRole("checkbox", { name: "Show snippets" }).check();
  await openAllNotes(page);
  await expect(snippet(page, "Alpha")).toHaveText("The first lines of Alpha.");
  await backToSettings(page);
  await openJson(page);
  await expect(json(page)).toHaveText('{  "core.editorTextSize": 120}');
});

test("a plugin's options are listed under it with their schema and apply without a reload, and its switch is on the Plugins page and not among them", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole("navigation", { name: "Categories" }).getByRole("link")).toHaveText(["Editor", "Appearance", "Keyboard shortcuts", "Account", "Note list", "Dashboard", "HTML embeds", "Calendar", "Todos", "Daily notes", "Mentions", "Vim mode", "Night shift"]);
  const noteList = await category(page, "Note list");

  await expect(noteList.getByRole("checkbox")).toHaveCount(1);
  await expect(noteList.getByRole("checkbox", { name: "Show snippets" })).toBeChecked();
  await expect(noteList).toContainText("note-list.snippets");
  await expect(noteList).toContainText("Show the first lines of each note under its title.");
  await expect(noteList).toContainText("Default: on");

  await noteList.getByRole("checkbox", { name: "Show snippets" }).uncheck();
  await openAllNotes(page);
  await expect(noteCard(page, "Alpha")).toBeVisible();
  await expect(noteCard(page, "Alpha")).not.toContainText("The first lines of Alpha.");
  await expect.poll(() => stored(page)).toEqual({ "note-list.snippets": false });
  await backToSettings(page);

  await setPlugin(page, "Note list", false);
  await expect.poll(() => stored(page)).toEqual({ "note-list.snippets": false, "note-list.enabled": false });
  await page.goto("/settings/plugins/note-list");
  await expect(noteList).toContainText("Note list is off, so its options change nothing until it is turned on on the Plugins page.");
  await expect(noteList.getByRole("checkbox", { name: "Show snippets" })).not.toBeChecked();
  await noteList.getByRole("link", { name: "About this plugin" }).click();
  await expect(page).toHaveURL(/\/plugins\/note-list$/);
  await expect(page.getByRole("checkbox", { name: "Note list", exact: true })).not.toBeChecked();
  await openAllNotes(page);
  await expect(page.getByRole("region", { name: "All notes" }).getByRole("link")).toHaveText(["Alpha"]);
  await expect(page.getByRole("navigation", { name: "Notes" })).toHaveCount(0);
});

test("a value the schema refuses and a key it doesn't know are flagged in the JSON and in the options, and the rest still applies", async ({ page }) => {
  await openSettings(page);

  await typeJson(page, '{"core.theme": "dark", "core.editorTextSize": 500, "core.theem": "light", "keybindings.view.toggleFocus": ["cmd+y"]}');

  await expect(problems(page)).toHaveText([
    "core.editorTextSize Expected 200 or less, not 500. The default is used.",
    'keybindings.view.toggleFocus "cmd" in "cmd+y" isn\'t a modifier. Use mod, ctrl, alt, or shift, then one key. The default is used.',
    "core.theem There's no setting by this name. It may belong to a plugin that isn't installed.",
  ]);
  await expect(page.locator(".settings-json .cm-lintRange-error")).toHaveText(["500", '["cmd+y"]']);
  await expect(page.locator(".settings-json .cm-lintRange-warning")).toHaveText(['"core.theem"']);
  await page.locator(".settings-json .cm-lintRange-error").first().hover();
  await expect(page.locator(".cm-tooltip-lint")).toHaveText("Expected 200 or less, not 500. The default is used.");
  await expect.poll(() => theme(page)).toBe("dark");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "core.editorTextSize": 500, "core.theem": "light", "keybindings.view.toggleFocus": ["cmd+y"] });

  await openOptions(page);
  const core = group(page, "Editor");
  await expect(core.getByRole("spinbutton", { name: "Editor text size" })).toHaveValue("100");
  await expect(core.getByRole("spinbutton", { name: "Editor text size" })).toHaveAttribute("aria-invalid", "true");
  await expect(core).toContainText("Expected 200 or less, not 500. The default is used.");
  await expect((await category(page, "Keyboard shortcuts")).getByRole("row", { name: /Toggle focus/ })).toContainText('"cmd" in "cmd+y" isn\'t a modifier.');
  const unknown = await category(page, "Not recognized");
  await expect(unknown).toContainText("core.theem");

  await unknown.getByRole("button", { name: "Remove core.theem" }).click();
  await category(page, "Editor");
  await core.getByRole("button", { name: "Reset Editor text size" }).click();
  await expect(problems(page)).toHaveCount(1);
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "keybindings.view.toggleFocus": ["cmd+y"] });
});

test("JSON that can't be read is flagged in both views and isn't saved, and the settings stay as they were", async ({ page }) => {
  await openSettings(page);
  await typeJson(page, '{"core.theme": "dark"}');
  await expect(page.getByRole("status")).toHaveText("Saved");

  await typeJson(page, '{"core.theme": "light",');

  await expect(page.getByRole("status")).toHaveText("Not saved until the JSON is fixed");
  await expect(problems(page)).toHaveText(["The JSON can't be read. Settings are one JSON object, such as {}. Your settings stay as they were until it can."]);
  await expect(page.locator(".settings-json .cm-lintRange-error")).not.toHaveCount(0);
  await expect.poll(() => theme(page)).toBe("dark");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark" });

  await openOptions(page);
  await expect(page.getByRole("alert")).toContainText("The JSON has a mistake in it, so nothing can be changed here until it is fixed.");
  await expect((await category(page, "Appearance")).getByRole("combobox", { name: "Theme" })).toBeDisabled();
  await expect((await category(page, "Keyboard shortcuts")).getByRole("button", { name: "Record a key for Undo" })).toBeDisabled();

  await page.getByRole("button", { name: "Show the JSON" }).click();
  await expect(json(page)).toHaveText('{"core.theme": "light",');
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(' "core.editorTextSize": 90}');
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(() => theme(page)).toBe("light");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "light", "core.editorTextSize": 90 });
});

test("a keybinding is recorded by pressing it, warned of when another command has the key, removed, and reset, in the table of keyboard shortcuts", async ({ page }) => {
  await openSettings(page);
  const app = page.locator(".app");
  const keys = await category(page, "Keyboard shortcuts");
  await expect(keys.getByRole("row", { name: /Undo/ }).getByRole("cell").nth(1)).toHaveText("Default");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("toggle focus");
  await expect(keys.getByRole("row")).toHaveCount(2);
  const focusRow = keys.getByRole("row", { name: /Toggle focus/ });
  const key = focusRow.locator("kbd");
  const from = focusRow.getByRole("cell").nth(1);
  await expect(key).toHaveText([/^(⌘\.|Ctrl\+\.)/]);
  await expect(from).toHaveText("Default");

  await focusRow.getByRole("button", { name: "Record a key for Toggle focus" }).click();
  const recorder = page.getByRole("dialog", { name: "Record a key for Toggle focus" });
  await expect(recorder.getByRole("group", { name: "Press the keys" })).toBeFocused();
  await expect(recorder.getByRole("button", { name: "Save" })).toBeDisabled();
  // The key that toggles focus is written down there, and toggles nothing.
  await page.keyboard.press("ControlOrMeta+.");
  await expect(recorder).toContainText("Toggle focus has this key already.");
  await expect(app).not.toHaveAttribute("data-focus-mode");
  // A key pressed after another makes a sequence of them, and Start over takes them all back.
  await page.keyboard.press("y");
  await expect(recorder.locator("kbd")).toHaveText(/^(⌘\. Y|Ctrl\+\. Y)$/);
  await expect(recorder).not.toContainText("has this key already");
  await recorder.getByRole("button", { name: "Start over" }).click();
  await expect(recorder.getByRole("group", { name: "Press the keys" })).toBeFocused();
  await expect(recorder.locator("kbd")).toHaveCount(0);
  await expect(recorder.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.keyboard.press("y");
  await expect(recorder.locator("kbd")).toHaveText("Y");
  await expect(recorder).toContainText("Y begins with a key that types, so it runs only where nothing is being typed.");
  await expect(recorder.getByRole("button", { name: "Save" })).toBeEnabled();
  await recorder.getByRole("button", { name: "Start over" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(recorder.locator("kbd")).toHaveText(/^(⇧⌘Y|Ctrl\+Shift\+Y)$/);
  await expect(recorder.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(recorder).toHaveCount(0);
  await expect(key).toHaveText([/^(⇧⌘Y|Ctrl\+Shift\+Y)/]);
  await expect(from).toHaveText("Yours");
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleFocus": ["mod+shift+y"] });
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();

  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).not.toHaveAttribute("data-focus-mode");
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(app).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(app).not.toHaveAttribute("data-focus-mode");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Toggle focus");
  await expect(palette(page).getByRole("option").first()).toContainText(/Toggle focus.*(⇧⌘Y|Ctrl\+Shift\+Y)/);
  await page.keyboard.press("Escape");

  await focusRow.getByRole("button", { name: "Record a key for Toggle focus" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette(page)).toHaveCount(0);
  await expect(recorder.getByRole("alert")).toHaveText(/^(⇧⌘P|Ctrl\+Shift\+P) is already the key for Show all commands\. Saved, it runs Toggle focus instead\.$/);
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveCount(0);
  await expect(focusRow.getByRole("button", { name: "Record a key for Toggle focus" })).toBeFocused();
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleFocus": ["mod+shift+y"] });

  await focusRow.getByRole("button", { name: "Record a key for Toggle focus" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await recorder.getByRole("button", { name: "Save" }).click();
  await expect(problems(page)).toHaveText(["keybindings.view.toggleFocus mod+shift+p is also the key for Show all commands (commands.show). It runs Toggle focus. Show all commands is left with no key."]);
  await expect(focusRow).toContainText("mod+shift+p is also the key for Show all commands");
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(app).toHaveAttribute("data-focus-mode", "true");
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");

  await focusRow.getByRole("button", { name: /^Remove .+ from Toggle focus$/ }).click();
  await expect(focusRow.getByRole("cell").first()).toHaveText("No key");
  await expect(problems(page)).toHaveCount(0);
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleFocus": [] });
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).not.toHaveAttribute("data-focus-mode");

  await focusRow.getByRole("button", { name: "Reset Toggle focus" }).click();
  await expect(from).toHaveText("Default");
  await expect.poll(() => stored(page)).toEqual({});
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(app).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("ControlOrMeta+.");

  await focusRow.getByRole("button", { name: "Add another key for Toggle focus" }).click();
  await page.keyboard.press("F8");
  await page.keyboard.press("Enter");
  await expect(key).toHaveText([/^(⌘\.|Ctrl\+\.)/, /^F8/]);
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleFocus": ["mod+.", "f8"] });
});

// The widest is the table as rows of cells under its column names, and the others each command as a card, as the pane has room for: at 560px a card of one column.
for (const width of [1700, 1280, 900, 560]) {
  test(`recording, adding, removing or resetting a key moves nothing in the table of keyboard shortcuts: every row keeps its box and the page its scroll, at ${width}px`, async ({ page }) => {
    // Keys are named as they are off a Mac, which is longer: Ctrl+Shift+Y for ⇧⌘Y. Off a Mac the modifier is Control whatever machine runs the test.
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" }));
    await page.setViewportSize({ width, height: 480 });
    await openSettings(page);
    await page.goto("/settings/keyboard");
    await pinPanel(page, "Info");
    await expect(page.getByRole("status")).toHaveText("Saved");
    const row = page.getByRole("table", { name: "Keyboard shortcuts" }).getByRole("row", { name: /Toggle inspector/ });
    await row.scrollIntoViewIfNeeded();
    await page.locator(".page-pane").evaluate((pane) => pane.scrollBy(0, 60));
    /** Every row and every cell and button of the table, where it is in the window, and how far down everything that scrolls is. */
    const places = async () => {
      // A change is on its way to the server for a moment, and where things are is read once it is kept.
      await expect(page.getByRole("status")).toHaveText("Saved");
      return page.evaluate(async () => {
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const box = (el: Element) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return [x, y, width, height].map((n) => Math.round(n * 10) / 10);
        };
        const table = document.querySelector("table.shortcuts")!;
        return {
          table: box(table),
          rows: [...table.querySelectorAll("tr")].map((tr) => [tr.querySelector("code")?.textContent ?? "head", ...box(tr), ...[...tr.children].flatMap(box)]),
          record: [...table.querySelectorAll("[data-row-open]")].map(box),
          scrolled: [...document.querySelectorAll("*")].filter((el) => el.scrollTop > 0).map((el) => [el.className, el.scrollTop]),
          // Nothing of the table is wider than the table.
          inside: table.scrollWidth <= table.clientWidth && [...table.querySelectorAll("td, th, .shortcut-buttons button")].every((el) => el.getBoundingClientRect().right <= table.getBoundingClientRect().right + 0.5),
        };
      });
    };
    const record = async (name: string, key: string) => {
      await row.getByRole("button", { name: `${name} Toggle inspector` }).click();
      const recorder = page.getByRole("dialog", { name: `${name} Toggle inspector` });
      await page.keyboard.press(key);
      await page.keyboard.press("Enter");
      await expect(recorder).toHaveCount(0);
    };
    const before = await places();
    expect(before.scrolled.length).toBeGreaterThan(0);
    expect(before.inside).toBe(true);
    // Which of the three layouts this is: rows of cells under their column names, or a card of two columns or of one.
    const layout = await row.evaluate((tr) => (getComputedStyle(tr).display === "grid" ? `card of ${getComputedStyle(tr).gridTemplateColumns.split(" ").length}` : "cells"));
    expect(layout).toBe({ 1700: "cells", 1280: "card of 2", 900: "card of 2", 560: "card of 1" }[width]);
    expect(before.rows.length).toBeGreaterThan(8);

    await record("Record a key for", "Control+Shift+Y");
    await expect(row.getByRole("cell").nth(1)).toHaveText("Yours");
    await expect(row.locator("kbd")).toHaveCount(1);
    await expect.poll(() => places()).toEqual(before);

    await record("Add another key for", "Control+Shift+U");
    await expect(row.locator("kbd")).toHaveCount(2);
    await expect.poll(() => places()).toEqual(before);
    // A third, and a long one: two keys pressed one after the other.
    await row.getByRole("button", { name: "Add another key for Toggle inspector" }).click();
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.press("Control+Shift+S");
    await page.keyboard.press("Enter");
    await expect(row.locator("kbd")).toHaveText([/^Ctrl\+Shift\+Y/, /^Ctrl\+Shift\+U/, /^Ctrl\+Shift\+K Ctrl\+Shift\+S/]);
    await expect.poll(() => places()).toEqual(before);

    await row.locator("kbd").first().getByRole("button").click();
    await expect(row.locator("kbd")).toHaveCount(2);
    await expect.poll(() => places()).toEqual(before);

    await row.getByRole("button", { name: "Reset Toggle inspector" }).click();
    await expect(row.getByRole("cell").first()).toHaveText("No key");
    await expect(row.getByRole("cell").nth(1)).toHaveText("Default");
    await expect.poll(() => places()).toEqual(before);
  });
}

test("one search finds settings in every category and keyboard shortcuts, a category narrows it, and Modified shows only what was changed", async ({ page }) => {
  await openSettings(page);
  await write(page, { "core.theme": "dark", "daily.folder": "Journal", "keybindings.view.toggleInspector": ["mod+shift+i"], "note-list.enabled": false });
  await page.reload();
  const categories = page.getByRole("navigation", { name: "Categories" }).getByRole("link");
  const shown = page.locator(".settings-pane").getByRole("region");
  const names = () => shown.evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label")));
  const search = page.getByRole("searchbox", { name: "Search settings" });
  await expect(shown).toHaveText([/^Editor/]);

  await search.fill("daily");
  await expect(categories).toHaveText(["All results5", "Keyboard shortcuts2", "Daily notes3"]);
  await expect(group(page, "Keyboard shortcuts").getByRole("rowheader")).toHaveText([/daily\.today/, /Disable plugin: Daily notes/]);
  await expect(categories.first()).toHaveAttribute("aria-current", "page");
  await search.fill("note");
  // Mentions has a setting about a private note.
  await expect.poll(names).toEqual(["Editor", "Note list", "Daily notes", "Mentions", "Keyboard shortcuts"]);
  await expect(group(page, "Daily notes").getByRole("textbox", { name: "Daily notes folder" })).toHaveValue("Journal");
  await expect(group(page, "Keyboard shortcuts").getByRole("row", { name: /New note/ })).toBeVisible();
  await expect(group(page, "Keyboard shortcuts").getByRole("row", { name: /Undo/ })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: /^Daily notes, 3 found$/ }).click();
  await expect.poll(names).toEqual(["Daily notes"]);
  await expect(page).toHaveURL(/\/settings\/plugins\/daily$/);
  await page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: /^All results/ }).click();
  await expect(shown).toHaveCount(5);

  await search.fill("zzzz");
  await expect(page.locator(".settings-pane")).toHaveText("No setting or keyboard shortcut matches.");
  await search.fill("");
  await expect.poll(names).toEqual(["Daily notes"]);

  await page.getByRole("button", { name: "Modified" }).click();
  await expect(page.getByRole("button", { name: "Modified" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(names).toEqual(["Appearance", "Daily notes", "Keyboard shortcuts"]);
  await expect(page.locator(".settings-pane .setting")).toHaveCount(2);
  await expect(group(page, "Keyboard shortcuts").getByRole("row")).toHaveText([/Command/, /Toggle inspector/]);
  await group(page, "Daily notes").getByRole("button", { name: "Reset Daily notes folder" }).click();
  await expect.poll(names).toEqual(["Appearance", "Keyboard shortcuts"]);
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "keybindings.view.toggleInspector": ["mod+shift+i"], "note-list.enabled": false });
});

test("at a narrow width the categories are a menu above the settings, and in the dark theme the page is dark", async ({ page }) => {
  await openSettings(page);
  const list = page.getByRole("navigation", { name: "Categories" });
  const menu = page.getByRole("combobox", { name: "Category" });
  await expect(list).toBeVisible();
  await expect(menu).toBeHidden();

  await page.setViewportSize({ width: 560, height: 800 });
  await expect(list).toBeHidden();
  await expect(menu).toHaveValue("editor");
  await menu.selectOption({ label: "Appearance" });
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await group(page, "Appearance").getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".settings")!).colorScheme)).toBe("dark");
  await menu.selectOption({ label: "Keyboard shortcuts" });
  await expect(group(page, "Keyboard shortcuts").getByRole("row", { name: /Undo/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const overflowing = await page.evaluate(() => [...document.querySelectorAll(".settings-pane *")].filter((el) => el.getBoundingClientRect().right > document.querySelector(".main")!.getBoundingClientRect().right + 1).length);
  expect(overflowing).toBe(0);
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
  await page.goto("/settings/appearance");
  await group(page, "Appearance").getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect.poll(() => stored(page)).toEqual({ "sidebar.enabled": false, "core.theme": "dark" });
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ink.plugins.off")))).toEqual([]);

  const context = await browser.newContext();
  const other = await context.newPage();
  other.on("pageerror", (err) => errors.push(err.message));
  await signIn(other);
  await expect(other.getByRole("region", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(other.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
  await expect.poll(() => theme(other)).toBe("dark");

  await setPlugin(other, "Sidebar", true);
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
  await expect(page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "On", exact: true })).toHaveCount(0);
  await setPlugin(page, "Sidebar", true);
  await setPlugin(page, "Command palette", true);

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

test("a plugin's options are changed on its own page, with the controls, the refusals and the reset Settings has, and the two stay in step", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "sized",
        name: "Sized",
        settings: {
          rows: { type: "integer", default: 3, minimum: 1, maximum: 9, title: "Rows", description: "How many rows it draws." },
          look: { type: "string", default: "plain", enum: ["plain", "loud"], title: "Look" },
        },
        activate(host: { settings: { get(name: string): unknown }; views: { register(slot: string, view: unknown): void } }) {
          host.views.register("section", { id: "sized", component: () => `sized draws ${host.settings.get("rows")} rows, ${host.settings.get("look")}` });
        },
      },
    ];
  });
  await openSettings(page);
  await page.goto("/plugins/sized");
  const options = page.locator(".plugin-details").getByRole("region", { name: "Settings", exact: true });
  const rows = options.getByRole("spinbutton", { name: "Rows" });
  const look = options.getByRole("combobox", { name: "Look" });
  const drawn = page.locator(".sidebar");

  // What Settings shows of each option: its key, what it is for, its default.
  await expect(rows).toHaveValue("3");
  await expect(options).toContainText("sized.rows");
  await expect(options).toContainText("How many rows it draws.");
  await expect(options).toContainText("Default: 3");
  await expect(options.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  await expect(drawn).toContainText("sized draws 3 rows, plain");

  // A change is written to the member's settings and applies at once.
  await rows.fill("5");
  await page.keyboard.press("Enter");
  await look.selectOption("loud");
  await expect(drawn).toContainText("sized draws 5 rows, loud");
  await expect.poll(() => stored(page)).toEqual({ "sized.rows": 5, "sized.look": "loud" });

  // A value the schema refuses is refused here as it is there, and nothing is written.
  await rows.fill("50");
  await page.keyboard.press("Enter");
  await expect(options).toContainText("Expected 9 or less, not 50. Nothing was changed.");
  await expect(rows).toHaveAttribute("aria-invalid", "true");
  await expect.poll(() => stored(page)).toEqual({ "sized.rows": 5, "sized.look": "loud" });

  // Settings lists the same options, with what was set here, and a change there shows here.
  await options.getByRole("link", { name: "Open in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/plugins\/sized$/);
  const inSettings = group(page, "Sized");
  await expect(inSettings.getByRole("spinbutton", { name: "Rows" })).toHaveValue("5");
  await expect(inSettings.getByRole("combobox", { name: "Look" })).toHaveValue("loud");
  await inSettings.getByRole("spinbutton", { name: "Rows" }).fill("7");
  await page.keyboard.press("Enter");
  await expect.poll(() => stored(page)).toEqual({ "sized.rows": 7, "sized.look": "loud" });
  await inSettings.getByRole("link", { name: "About this plugin" }).click();
  await expect(page).toHaveURL(/\/plugins\/sized$/);
  await expect(rows).toHaveValue("7");
  await expect(rows).not.toHaveAttribute("aria-invalid", "true");

  // Reset puts an option back at its default and takes it out of what is stored.
  await options.getByRole("button", { name: "Reset Rows" }).click();
  await expect(rows).toHaveValue("3");
  await expect(drawn).toContainText("sized draws 3 rows, loud");
  await expect.poll(() => stored(page)).toEqual({ "sized.look": "loud" });
  await expect(options.getByRole("button", { name: "Reset Rows" })).toHaveCount(0);

  // Off, its options are still its to set, and the page says they change nothing until it is on.
  await page.getByRole("checkbox", { name: "Sized", exact: true }).uncheck();
  await expect(options).toContainText("Sized is off, so its options change nothing until it is turned on.");
  await look.selectOption("plain");
  await expect.poll(() => stored(page)).toEqual({ "sized.enabled": false });
});

test("a plugin that asks to change settings is refused and nothing is written, while its own option is its to read", async ({ page }) => {
  await page.addInitScript(() => {
    interface Handed {
      perform(op: unknown): Promise<unknown>;
      settings: { get(name: string): unknown; set(name: string, value: unknown): boolean };
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
              const set = await outcome(Promise.resolve().then(() => host.settings.set("shout", true)));
              const sort = await outcome(Promise.resolve().then(() => host.settings.set("todos.sort", "text")));
              (window as unknown as { __GREEDY__: unknown }).__GREEDY__ = { wrote, read, listed, set, sort };
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
    set: "Greedy can't change shout: a plugin changes only a setting it declares remembered",
    sort: "Greedy can't change todos.sort: a plugin changes only a setting it declares remembered",
  });
  await expect.poll(() => stored(page)).toEqual({});
  await expect.poll(() => theme(page)).toBeNull();
  await expect(sidebar).toContainText("greedy says hello");

  await (await category(page, "Greedy")).getByRole("checkbox", { name: "Shout" }).check();
  await expect(sidebar).toContainText("GREEDY SAYS HELLO");
  await expect.poll(() => stored(page)).toEqual({ "greedy.shout": true });
});

test("Toggle sidebar and the other commands on the window are in the table of keyboard shortcuts, and take another key there", async ({ page }) => {
  await openSettings(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const sidebarBar = page.getByRole("navigation", { name: "Sidebar bar" });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const keys = await category(page, "Keyboard shortcuts");
  // With the sidebar and the inspector both open, every row's buttons are inside the pane.
  await expect(keys.getByRole("row", { name: /Redo/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".settings-pane *")].filter((el) => el.getBoundingClientRect().right > document.querySelector(".main")!.getBoundingClientRect().right + 1).length)).toBe(0);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("toggle");
  const row = (title: string) => keys.getByRole("row", { name: new RegExp(title) });
  await expect(row("Toggle sidebar").locator("kbd")).toHaveText([/^(⌘\\|Ctrl\+\\)/]);
  await expect(row("Toggle sidebar").getByRole("cell").nth(1)).toHaveText("Default");
  await expect(row("Toggle focus").locator("kbd")).toHaveText([/^(⌘\.|Ctrl\+\.)/]);
  await expect(row("Toggle inspector").getByRole("cell").first()).toHaveText("No key");

  await row("Toggle sidebar").getByRole("button", { name: "Record a key for Toggle sidebar" }).click();
  const recorder = page.getByRole("dialog", { name: "Record a key for Toggle sidebar" });
  await expect(recorder.getByRole("group", { name: "Press the keys" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(recorder.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(recorder).toHaveCount(0);
  await expect(row("Toggle sidebar").locator("kbd")).toHaveText([/^(⇧⌘U|Ctrl\+Shift\+U)/]);
  await expect(row("Toggle sidebar").getByRole("cell").nth(1)).toHaveText("Yours");
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleSidebar": ["mod+shift+u"] });

  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await expect(sidebar).toBeVisible();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(sidebar, "the key it had runs it no longer").toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(sidebarBar).toBeVisible();
  await expect(sidebar).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(sidebar).toBeVisible();

  await row("Toggle inspector").getByRole("button", { name: "Record a key for Toggle inspector" }).click();
  await page.keyboard.press("F9");
  await page.keyboard.press("Enter");
  await expect(row("Toggle inspector").locator("kbd")).toHaveText([/^F9/]);
  await expect.poll(() => stored(page)).toEqual({ "keybindings.view.toggleSidebar": ["mod+shift+u"], "keybindings.view.toggleInspector": ["f9"] });
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  const open = await inspector.count();
  await page.keyboard.press("F9");
  await expect(inspector).toHaveCount(1 - open);
  await page.keyboard.press("F9");
  await expect(inspector).toHaveCount(open);

  await row("Toggle sidebar").getByRole("button", { name: "Reset Toggle sidebar" }).click();
  await expect(row("Toggle sidebar").locator("kbd")).toHaveText([/^(⌘\\|Ctrl\+\\)/]);
  await page.getByRole("heading", { name: "Settings", level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(sidebarBar).toBeVisible();
});

test("Enter and Space given to commands leave buttons, links and checkboxes their own press, and run where nothing takes them; another bare key runs on a button too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await write(page, { "keybindings.note.new": ["enter"], "keybindings.notes.all": ["space"], "keybindings.view.toggleFocus": ["w"] });
  await page.goto("/plugins");
  const app = page.locator(".app");
  const modes = page.getByRole("navigation", { name: "Modes" });
  const notes = async () => (await perform(page, { type: "note.list" })).length;
  await expect(modes.getByRole("button", { name: "Less" })).toBeVisible();

  await modes.getByRole("button", { name: "Less" }).focus();
  await page.keyboard.press("Enter");
  await expect(modes.getByRole("button", { name: "More" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(modes.getByRole("button", { name: "Less" })).toBeFocused();

  const backlinks = page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Backlinks", exact: true });
  await backlinks.focus();
  await page.keyboard.press("Space");
  await expect(backlinks).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(backlinks).toBeChecked();

  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Plugins" }).focus();
  await page.keyboard.press("Enter");
  await modes.getByRole("link", { name: "Dashboard" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => notes(), "no press of Enter on a control made a note").toBe(0);

  // w is no control's key, so it runs with a button in focus.
  await modes.getByRole("button", { name: "Less" }).focus();
  await page.keyboard.press("w");
  await expect(app).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("w");
  await expect(app).not.toHaveAttribute("data-focus-mode");

  // With nothing in focus that takes them, Space and Enter run their commands.
  await page.getByRole("heading", { name: "Dashboard", level: 1 }).click();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\/folder\/all$/);
  await page.getByRole("heading", { name: "All notes", level: 1 }).click();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\//);
  await expect.poll(notes).toBe(1);

  await page.goto("/settings/keyboard");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Toggle inspector");
  await page.getByRole("button", { name: "Record a key for Toggle inspector" }).click();
  const recorder = page.getByRole("dialog", { name: "Record a key for Toggle inspector" });
  await expect(recorder.getByRole("group", { name: "Press the keys" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(recorder).toContainText("Space begins with a key that types, and that presses a button or checkbox in focus. So it runs only where nothing is being typed and focus is on no such control.");
  await page.keyboard.press("Escape");
});

test("the key recorder keeps Tab inside it and closes on Escape from any of its buttons", async ({ page }) => {
  await openSettings(page);
  const keys = await category(page, "Keyboard shortcuts");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("toggle focus");
  const open = keys.getByRole("row", { name: /Toggle focus/ }).getByRole("button", { name: "Record a key for Toggle focus" });
  await open.click();
  const recorder = page.getByRole("dialog", { name: "Record a key for Toggle focus" });
  const box = recorder.getByRole("group", { name: "Press the keys" });
  await expect(box).toBeFocused();
  const inside = () => page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null && document.activeElement !== document.body);

  // Tab went on out of the dialog, to the page behind it, where Escape closed nothing.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inside()).toBe(true);
  }
  await box.focus();
  await page.keyboard.press("Tab");
  await expect(box).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveCount(0);

  // A press on the dialog's own words leaves the keyboard in it, so Escape still closes it.
  await open.click();
  await recorder.getByText("Press Enter to save and Escape to cancel.").click();
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveCount(0);
  expect(await stored(page)).toEqual({});
});
