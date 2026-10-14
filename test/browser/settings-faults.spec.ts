import { expect, test, type Page } from "@playwright/test";
import { category, group, json, openOptions, setPlugin, typeJson } from "./settings-helpers.ts";
import { perform, pinPanel, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const stored = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text) as Record<string, unknown>;
const problems = (page: Page) => page.getByRole("list", { name: "Problems" }).getByRole("listitem");
const text = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const theme = (page: Page) => page.locator("html").getAttribute("data-theme");
const snippets = (page: Page) => group(page, "Note list").getByRole("checkbox", { name: "Show snippets" });
const themeBox = (page: Page) => group(page, "Appearance").getByRole("combobox", { name: "Theme" });
/** The addresses of the two categories these tests change a setting in. */
const NOTE_LIST = "/settings/plugins/note-list";
const APPEARANCE = "/settings/appearance";

/** Holds back each settings operation of one kind that `when` picks, for `ms`, on its way to the server. */
const slow = (page: Page, type: "settings.read" | "settings.write", ms: number, when: (nth: number) => boolean = () => true) => {
  let seen = 0;
  return page.route("**/ops", async (route) => {
    if ((route.request().postDataJSON() as { type: string }).type === type && when(++seen)) await new Promise((done) => setTimeout(done, ms));
    await route.continue();
  });
};

async function openSettings(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nThe first lines of Alpha." });
  await page.goto(APPEARANCE);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  return note;
}

test("a change made in a second window, in the same gesture that brings it to the front, keeps what the first window changed", async ({ page, browser }) => {
  const email = `browser-${crypto.randomUUID()}@example.com`;
  const signIn = (p: Page) => p.goto(`/auth/dev?${new URLSearchParams({ email, name: "Ada Lovelace" })}`);
  await signIn(page);
  const context = await browser.newContext();
  const other = await context.newPage();
  other.on("pageerror", (err) => errors.push(err.message));
  await signIn(other);
  await other.goto(NOTE_LIST);
  await expect(snippets(other)).toBeChecked();
  await slow(other, "settings.read", 400);

  await page.goto(APPEARANCE);
  await themeBox(page).selectOption("dark");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark" });

  await other.evaluate(() => window.dispatchEvent(new Event("focus")));
  await snippets(other).uncheck();

  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "note-list.snippets": false });
  await expect(snippets(other)).not.toBeChecked();
  await category(other, "Appearance");
  await expect(themeBox(other)).toHaveValue("dark");
  await expect.poll(() => theme(other)).toBe("dark");
  await context.close();
});

test("a change still waiting when the page goes away is saved over the older write in flight, not under it", async ({ page }) => {
  await openSettings(page);
  await slow(page, "settings.write", 1500, (nth) => nth === 1);

  await themeBox(page).selectOption("dark");
  await category(page, "Note list");
  await snippets(page).uncheck();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "note-list.snippets": false });
  await page.waitForTimeout(2000);

  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "note-list.snippets": false });
  await page.unroute("**/ops");
  await page.reload();
  await expect(snippets(page)).not.toBeChecked();
  await category(page, "Appearance");
  await expect(themeBox(page)).toHaveValue("dark");
});

test("when the settings can't be read the workspace opens with the defaults, says so, keeps nothing, and reads them on Try again", async ({ page }) => {
  const note = await openSettings(page);
  await perform(page, { type: "settings.write", text: '{"core.theme":"dark","sidebar.enabled":false}', baseRevision: 0 });
  let down = true;
  await page.route("**/ops", async (route) => {
    if (down && (route.request().postDataJSON() as { type: string }).type === "settings.read") return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"unknown","message":"The database is away"}' });
    await route.continue();
  });

  await page.goto(`/note/${note.id}`);
  const banner = page.getByRole("alert").filter({ hasText: "Your settings couldn't be loaded" });
  await expect(banner).toContainText("the defaults are in use and changes to them aren't kept. (The database is away)");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect.poll(() => theme(page)).toBeNull();
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Still writing.");
  await expect(page.getByRole("status")).toHaveText("Saved");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Disable plugin: Note list");
  await page.keyboard.press("Enter");
  await page.goto(APPEARANCE);
  await expect(page.getByRole("status")).toHaveText("Your settings couldn't be loaded, so nothing can be changed here");
  await expect(themeBox(page)).toBeDisabled();
  down = false;
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "sidebar.enabled": false });

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
  await expect(themeBox(page)).toHaveValue("dark");
  await expect(themeBox(page)).toBeEnabled();
  await expect.poll(() => theme(page)).toBe("dark");
});

test("slow settings don't hold the workspace back for long: it opens with the defaults, and they apply when they arrive", async ({ page }) => {
  await openSettings(page);
  await perform(page, { type: "settings.write", text: '{"core.theme":"dark"}', baseRevision: 0 });
  await slow(page, "settings.read", 4000);

  await page.goto("/");
  // `/` returns to the Settings page's tab, which says the same in its own words: this is the app's notice.
  const banner = page.getByRole("status").filter({ hasText: "Loading your settings. The defaults are in use until they arrive." });
  await expect(banner).toBeVisible({ timeout: 3500 });
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect.poll(() => theme(page)).toBeNull();

  await expect(banner).toHaveCount(0);
  await expect.poll(() => theme(page)).toBe("dark");
});

test("JSON typed before slow settings arrive is not kept as a draft that would write over them", async ({ page }) => {
  await openSettings(page);
  await perform(page, { type: "settings.write", text: '{"core.theme":"dark","note-list.snippets":false}', baseRevision: 0 });
  await slow(page, "settings.read", 4000);

  await page.goto("/settings/json");
  await expect(json(page)).toBeVisible({ timeout: 3500 });
  await expect(page.locator(".settings-head").getByRole("status")).toHaveText("Loading your settings…");
  // Nothing can be changed yet, so nothing typed now is taken: it used to be held and, a key later, written over what was stored.
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"core.editorTextSize": 120}');
  await expect(json(page)).toHaveText("{}");

  await expect(json(page)).toContainText("core.theme");
  await expect(problems(page)).toHaveCount(0);
  await expect(page.locator(".settings-head").getByRole("status")).toHaveText("Saved");
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  expect(await stored(page)).toEqual({ "core.theme": "dark", "note-list.snippets": false });
});

test("a plugin that names a command or a page as the app's own are named is left out, and Settings and Plugins stay where they are", async ({ page }) => {
  await page.addInitScript(() => {
    interface Handed {
      commands: { register(command: unknown): void };
      views: { register(slot: string, view: unknown): void };
    }
    const command = (id: string) => ({ id: `squat-${id}`, name: `Squatter of ${id}`, activate: (host: Handed) => host.commands.register({ id, title: "Enable plugin: Sidebar", run: () => document.body.setAttribute("data-squatted", id) }) });
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      command("go.settings"),
      command("go.plugins"),
      command("plugins.toggle.sidebar"),
      { id: "squat-page", name: "Squatter of the page", activate: (host: Handed) => host.views.register("page", { id: "mine", path: "/settings", label: "Mine", component: () => "Not the settings" }) },
    ];
  });
  await openSettings(page);
  await setPlugin(page, "Sidebar", false);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Enable plugin: Sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-squatted");

  await page.goto("/plugins");
  const row = (name: string) => page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: name });
  await expect(row("Squatter of go.settings")).toContainText("Only Common Ink adds a command whose id starts with go., and this one is go.settings");
  await expect(row("Squatter of go.plugins")).toContainText("this one is go.plugins");
  await expect(row("Squatter of plugins.toggle.sidebar")).toContainText("starts with plugins., and this one is plugins.toggle.sidebar");
  await expect(row("Squatter of the page")).toContainText("There's already a page at /settings");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

test("a key that types is a keybinding only where nothing is being typed, so Enter in a note stays Enter", async ({ page }) => {
  const note = await openSettings(page);

  await typeJson(page, '{"keybindings.note.new": ["enter"], "keybindings.view.toggleFocus": ["backspace"], "keybindings.view.toggleInspector": ["f6"]}');
  await expect.poll(() => stored(page)).toEqual({ "keybindings.note.new": ["enter"], "keybindings.view.toggleFocus": ["backspace"], "keybindings.view.toggleInspector": ["f6"] });
  await expect(problems(page)).toHaveCount(0);

  await page.goto(`/note/${note.id}`);
  await pinPanel(page, "Info");
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("xy");
  await page.keyboard.press("Backspace");
  await expect(text(page)).toContainText("The first lines of Alpha.x");
  await expect(page).toHaveURL(new RegExp(`${note.id}$`));
  await expect(page.locator(".app")).not.toHaveAttribute("data-focus-mode");
  await expect.poll(async () => (await perform(page, { type: "note.list" })).map((n) => n.title)).toEqual(["Alpha"]);

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  await page.keyboard.press("F6");
  await expect(inspector).toHaveCount(0);

  // Out of the note's text the same keys are the commands'.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Backspace");
  await expect(page.locator(".app")).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".app")).not.toHaveAttribute("data-focus-mode");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await perform(page, { type: "note.list" })).length).toBe(2);
});

test("settings the server refuses are put back as they were, with its reason and no promise to retry", async ({ page }) => {
  await openSettings(page);
  await themeBox(page).selectOption("dark");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark" });
  const writes: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"settings.write"') && writes.push(request.url()));

  await typeJson(page, `{"core.theme": "light", "x": "${"a".repeat(100_100)}"}`);

  await expect(page.getByRole("status")).toHaveText("Not saved, and put back as it was: Settings can be at most 100000 characters");
  await expect(json(page)).toContainText('"core.theme": "dark"');
  await expect.poll(() => theme(page)).toBe("dark");
  await page.waitForTimeout(3500);
  expect(writes).toHaveLength(1);
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark" });

  await perform(page, { type: "settings.write", text: '{"core.theme":"light"}', baseRevision: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(() => theme(page)).toBe("light");
});

test("giving undo's key to another command says that undo is left with none", async ({ page }) => {
  await openSettings(page);

  await typeJson(page, '{"keybindings.view.toggleInspector": ["mod+z"]}');

  await expect(problems(page)).toHaveText(["keybindings.view.toggleInspector mod+z is also the key for Undo (history.undo). It runs Toggle inspector. Undo is left with no key."]);
  await openOptions(page);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Toggle inspector");
  await expect(group(page, "Keyboard shortcuts").getByRole("row", { name: /Toggle inspector/ })).toContainText("Undo is left with no key.");
});
