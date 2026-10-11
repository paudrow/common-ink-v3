import { expect, test, type Page } from "@playwright/test";
import { connectAgent, perform, signInAsNewPerson } from "./helpers.ts";

const text = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const saved = (page: Page) => expect(page.getByRole("status")).toHaveText("Saved");

async function withNote(page: Page, title: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# ${title}\n` });
  await page.reload();
  return note;
}

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const noteRow = (page: Page, title: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("link", { name: title, exact: true });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab");
const palette = (page: Page) => page.getByRole("dialog", { name: "Commands" });

/** Runs a command from the palette, which is how a plugin is turned on or off without leaving the page. */
async function run(page: Page, command: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type(command);
  await expect(palette(page).getByRole("option").first()).toHaveText(command);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
}

/** Turns a plugin on or off on the Plugins page, which is there whatever is turned off. */
async function setPlugin(page: Page, name: string, on: boolean) {
  const back = new URL(page.url()).pathname;
  await page.goto("/plugins");
  await page.getByRole("checkbox", { name, exact: true }).setChecked(on);
  await page.goto(back);
}

/** The core's promise: with a plugin off, a note still opens, takes typing, and saves it. */
async function writes(page: Page, noteId: string, line: string) {
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(line);
  await saved(page);
  expect((await perform(page, { type: "note.read", id: noteId })).text).toContain(line);
}

test("turning the command palette off takes its command and its key away, and the Plugins page brings it back", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  await noteRow(page, "Alpha").click();

  await run(page, "Disable plugin: Command palette");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByRole("dialog", { name: "Go to note" })).toBeVisible();
  await page.keyboard.press("Escape");
  await writes(page, note.id, "written with the palette off");

  await page.reload();
  await expect(text(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette(page)).toHaveCount(0);

  await setPlugin(page, "Command palette", true);
  await expect(text(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette(page).getByRole("option", { name: "Disable plugin: Command palette" })).toBeVisible();
});

test("turning the sidebar off takes the workspace menu, the page links, and the folders with it", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  await noteRow(page, "Alpha").click();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Folders" })).toBeVisible();

  await run(page, "Disable plugin: Sidebar");
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Folders" })).toHaveCount(0);
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await writes(page, note.id, "written with the sidebar off");

  await page.keyboard.press("ControlOrMeta+.");
  const rail = page.getByRole("navigation", { name: "Left rail" });
  await expect(rail.getByRole("button", { name: "Folders" })).toBeVisible();
  await expect(rail.getByRole("link")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+.");

  await run(page, "Enable plugin: Sidebar");
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toBeVisible();
  await sidebar.getByRole("button", { name: /Ada/ }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Agents", "Settings", "Plugins", "Sign out"]);
});

test("turning folders off takes the folder tree out of the sidebar and the popover, and leaves the notes", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  await noteRow(page, "Alpha").click();
  const tree = page.getByRole("tree", { name: "Folders" });
  await expect(tree.getByRole("treeitem", { name: "Unsorted" })).toBeVisible();

  await run(page, "Disable plugin: Folders");
  await expect(tree).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All notes" })).toBeVisible();
  await writes(page, note.id, "written with folders off");

  await page.keyboard.press("ControlOrMeta+.");
  await page.getByRole("navigation", { name: "Left rail" }).getByRole("button", { name: "Folders" }).click();
  await expect(page.getByRole("dialog", { name: "Folders" }).getByRole("link", { name: "Alpha" })).toBeVisible();
  await expect(tree).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+.");

  await run(page, "Enable plugin: Folders");
  await tree.getByRole("treeitem", { name: "Unsorted" }).click();
  await expect(page.getByRole("heading", { name: "Unsorted" })).toBeVisible();
});

test("turning tabs off shows the open note alone, and turning them on brings its tab back", async ({ page }) => {
  const alpha = await withNote(page, "Alpha");
  const beta = await perform(page, { type: "note.create", text: "# Beta\n" });
  await page.reload();
  await noteRow(page, "Alpha").dblclick();
  await noteRow(page, "Beta").dblclick();
  await expect(tabs(page)).toHaveText(["Alpha", "Beta"]);

  await run(page, "Disable plugin: Tabs and splits");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await writes(page, beta.id, "written with tabs off");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("close");
  await expect(palette(page).getByText("No commands match.")).toBeVisible();
  await page.keyboard.press("Escape");

  await noteRow(page, "Alpha").click();
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha.id}$`));
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await writes(page, alpha.id, "and in the next note");
  await page.goBack();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");

  await run(page, "Enable plugin: Tabs and splits");
  await expect(tabs(page)).toHaveText(["Alpha", "Beta"]);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await run(page, "Close tab");
  await expect(tabs(page)).toHaveText(["Alpha"]);
});

test("with every plugin off a note still opens at its address, takes typing, and saves", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  await page.goto("/plugins");
  const boxes = page.getByRole("list", { name: "Plugins" }).getByRole("checkbox");
  await expect(page.getByRole("checkbox", { name: "Tabs and splits" })).toBeChecked();
  for (const box of await boxes.all()) await box.uncheck();

  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await writes(page, note.id, "written by the core alone");
  await text(page).press("ControlOrMeta+z");
  await expect(text(page)).not.toContainText("written by the core alone");

  await page.goto("/history");
  await expect(page.getByText("There's nothing at this address.")).toBeVisible();

  await page.goto("/plugins");
  await expect(page.getByRole("checkbox", { name: "Tabs and splits" })).not.toBeChecked();
  for (const box of await boxes.all()) await box.check();
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
});

test("turning History off takes its page, its link, and its inspector tab away", async ({ page }) => {
  await withNote(page, "Alpha");
  await noteRow(page, "Alpha").click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);

  await run(page, "Disable plugin: History");
  await expect(inspector.getByRole("tab")).toHaveText(["Backlinks", "Info"]);
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar", "Contacts", "Uploads"]);

  await run(page, "Enable plugin: History");
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar", "Contacts", "Uploads", "History"]);
});

test("a stopwatch written in a note is drawn in it and runs, and is plain text again with its plugin off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const written = "# Laps\n\nTime me ::stopwatch{} here, not `::stopwatch{}` there, nor ::sundial{}.\n";
  const note = await perform(page, { type: "note.create", text: written });
  await page.reload();
  await noteRow(page, "Laps").click();

  const watch = text(page).getByRole("button", { name: /^Stopwatch/ });
  await expect(watch).toHaveText(["0:00"]);
  await expect(text(page)).toContainText("Time me 0:00 here, not `::stopwatch{}` there, nor ::sundial{}.");
  await watch.click();
  await expect(watch).toHaveText("0:01");
  await expect(watch).toHaveAttribute("aria-pressed", "true");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-pressed", "false");
  // Its time is kept in the note, so it is set back before the note is compared with what was written.
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toMatch(/Time me ::stopwatch\{at=\ds\} here/);
  await text(page).getByRole("button", { name: "Reset stopwatch" }).click();
  await expect(watch).toHaveText(["0:00"]);

  await run(page, "Disable plugin: Stopwatch");
  await expect(watch).toHaveCount(0);
  await expect(text(page)).toContainText("Time me ::stopwatch{} here");

  await run(page, "Enable plugin: Stopwatch");
  await expect(watch).toHaveText(["0:00"]);
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Again ::stopwatch{} ok");
  await expect(watch).toHaveText(["0:00", "0:00"]);
  await saved(page);
  expect((await perform(page, { type: "note.read", id: note.id })).text).toBe(`${written}Again ::stopwatch{} ok`);
});

test("the author Agents hands to History is shown once, and not again on Back or a reload", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  const agent = await connectAgent(page, "Robo");
  await agent.tool("write_note", { id: note.id, text: "# Alpha\nby robo\n", baseRevision: note.revision, writeId: crypto.randomUUID() });
  await page.goto("/agents");
  await page.getByRole("button", { name: "See its changes" }).click();
  const robo = page.getByRole("group", { name: "Authors" }).getByRole("button", { name: /Robo/ });
  await expect(robo).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(robo).toHaveAttribute("aria-pressed", "false");

  await noteRow(page, "Alpha").click();
  await expect(text(page)).toBeVisible();
  await page.goBack();
  await expect(robo).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(robo).toHaveAttribute("aria-pressed", "false");
});

test("Back and then Forward each turn the note list to the note's folder", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const first = await perform(page, { type: "folder.create", name: "First folder" });
  const second = await perform(page, { type: "folder.create", name: "Second folder" });
  await perform(page, { type: "note.create", text: "# Alpha\n", folderId: first.id });
  await perform(page, { type: "note.create", text: "# Beta\n", folderId: second.id });
  await page.reload();
  await noteRow(page, "Alpha").dblclick();
  await noteRow(page, "Beta").dblclick();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await expect(page.getByRole("heading", { name: "All notes" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "First folder" })).toBeVisible();
  await page.goForward();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await expect(page.getByRole("heading", { name: "Second folder" })).toBeVisible();
});
