import { expect, test, type Page } from "@playwright/test";
import { connectAgent, folderRow, listedNote, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";
import { openDetails, pluginRow } from "./plugins-helpers.ts";

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

/** Opens a note from the list of every note, as a preview. */
async function openNote(page: Page, title: string) {
  await openAllNotes(page);
  await listedNote(page, title).click();
}
/** Opens a note from the list of every note in a tab that is kept. */
async function keepNote(page: Page, title: string) {
  await openAllNotes(page);
  await noteCard(page, title).hover();
  await noteCard(page, title).getByRole("button", { name: `Edit ${title}` }).click();
}
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
  await openNote(page, "Alpha");

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
  await openNote(page, "Alpha");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Folders" })).toBeVisible();

  await run(page, "Disable plugin: Sidebar");
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Folders" })).toHaveCount(0);
  await run(page, "Open All notes");
  await listedNote(page, "Alpha").click();
  await writes(page, note.id, "written with the sidebar off");

  // With no sidebar there is nothing to close to a bar, so its button and its key do nothing here.
  await expect(page.getByRole("button", { name: "Sidebar", exact: true })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(page.getByRole("navigation", { name: "Sidebar bar" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+\\");

  await run(page, "Enable plugin: Sidebar");
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toBeVisible();
  await sidebar.getByRole("button", { name: /Ada/ }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Agents", "Members", "Settings", "Sign out"]);
});

test("turning folders off takes the folder tree out of the sidebar and its icon out of the closed bar, and leaves the notes", async ({ page }) => {
  const note = await withNote(page, "Alpha");
  await openNote(page, "Alpha");
  const tree = page.getByRole("tree", { name: "Folders" });
  await expect(tree.getByRole("treeitem", { name: "Unsorted" })).toBeVisible();

  await run(page, "Disable plugin: Folders");
  await expect(tree).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Dashboard" })).toBeVisible();
  await run(page, "Open All notes");
  await expect(page.getByRole("heading", { name: "All notes", level: 1 })).toBeVisible();
  await listedNote(page, "Alpha").click();
  await writes(page, note.id, "written with folders off");

  await page.keyboard.press("ControlOrMeta+\\");
  // With no section left the open sidebar has nothing under its links, so the closed bar has no icon for it.
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await expect(bar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Folders" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+\\");

  await run(page, "Enable plugin: Folders");
  await tree.getByRole("treeitem", { name: "Unsorted" }).click();
  await expect(page.getByRole("heading", { name: "Unsorted" })).toBeVisible();
});

test("turning tabs off shows the open note alone, and turning them on brings its tab back", async ({ page }) => {
  const alpha = await withNote(page, "Alpha");
  const beta = await perform(page, { type: "note.create", text: "# Beta\n" });
  await page.reload();
  await keepNote(page, "Alpha");
  await keepNote(page, "Beta");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta"]);

  await run(page, "Disable plugin: Tabs and splits");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await writes(page, beta.id, "written with tabs off");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("close");
  await expect(palette(page).getByText("No commands match.")).toBeVisible();
  await page.keyboard.press("Escape");

  await openNote(page, "Alpha");
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha.id}$`));
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await writes(page, alpha.id, "and in the next note");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "All notes", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");

  await run(page, "Enable plugin: Tabs and splits");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta"]);
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await run(page, "Close tab");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha"]);
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
  await openNote(page, "Alpha");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);

  await run(page, "Disable plugin: History");
  await expect(inspector.getByRole("tab")).toHaveText(["Backlinks", "Info"]);
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar", "Contacts", "Uploads", "Plugins"]);

  await run(page, "Enable plugin: History");
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar", "Contacts", "Uploads", "History", "Plugins"]);
});

test("a stopwatch written in a note is drawn in it and runs, and is plain text again with its plugin off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const written = "# Laps\n\nTime me ::stopwatch{} here, not `::stopwatch{}` there, nor ::sundial{}.\n";
  const note = await perform(page, { type: "note.create", text: written });
  await page.reload();
  await openNote(page, "Laps");

  const watch = text(page).getByRole("button", { name: /^Stopwatch/ });
  await expect(watch).toHaveText(["0:00"]);
  // Code's backticks are hidden off the cursor's line, so the one in code reads as its own text.
  await expect(text(page)).toContainText("Time me 0:00 here, not ::stopwatch{} there, nor ::sundial{}.");
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

  await openNote(page, "Alpha");
  await expect(text(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/folder\/all$/);
  await page.goBack();
  await expect(robo).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(robo).toHaveAttribute("aria-pressed", "false");
});

test("Back and then Forward each turn the folder tree to the note's folder", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const first = await perform(page, { type: "folder.create", name: "First folder" });
  const second = await perform(page, { type: "folder.create", name: "Second folder" });
  await perform(page, { type: "note.create", text: "# Alpha\n", folderId: first.id });
  await perform(page, { type: "note.create", text: "# Beta\n", folderId: second.id });
  await page.reload();
  await expect(folderRow(page, "Second folder")).toBeVisible();
  for (const title of ["Alpha", "Beta"]) {
    await page.keyboard.press("ControlOrMeta+P");
    await page.keyboard.type(title);
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText(title);
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-line").first()).toHaveText(`# ${title}`);
  }
  await expect(folderRow(page, "Second folder")).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(folderRow(page, "First folder")).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await expect(folderRow(page, "Second folder")).toHaveAttribute("aria-selected", "true");
});

const pluginRows = (page: Page) => page.getByRole("list", { name: "Plugins" }).getByRole("listitem");
const section = (page: Page, name: string) => page.locator(".plugin-details").getByRole("region", { name, exact: true });
/** Whether nothing on the page is wider than the window, so nothing is cut off or scrolls sideways. */
const fits = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".main *")].every((el) => el.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));

test("Plugins is under More in the sidebar, which says More closed and Less open, and is reached by its command and its address", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const modes = page.getByRole("navigation", { name: "Modes" });
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveCount(0);
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  const closed = await modes.getByRole("button", { name: "More" }).locator("svg").evaluate((icon) => getComputedStyle(icon).transform);

  await modes.getByRole("button", { name: "More" }).click();
  const less = modes.getByRole("button", { name: "Less" });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => less.locator("svg").evaluate((icon) => getComputedStyle(icon).transform)).not.toBe(closed);
  await modes.getByRole("link", { name: "Plugins" }).click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible();
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");

  // Loaded at a page that is under More, the list starts open on it.
  await page.goto("/plugins/kanban");
  await expect(modes.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
  await modes.getByRole("button", { name: "Less" }).click();
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveCount(0);

  // `/` would come back to the Plugins tab, which opens More as any way there does.
  await page.goto("/dashboard");
  await expect(modes.getByRole("button", { name: "More" })).toBeVisible();
  await run(page, "Go to Plugins");
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
});

test("the Plugins page lists every plugin with its icon, name, description and switch, and one search narrows the list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins");
  await expect(pluginRow(page, "Sidebar")).toBeVisible();

  const listed = await pluginRows(page).evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector("a.plugin-name")?.textContent,
      icon: row.querySelectorAll(".plugin-icon svg").length,
      kind: row.querySelector(".badge")?.textContent,
      described: (row.querySelector(".plugin-about")?.textContent ?? "").length > 15,
      switches: row.querySelectorAll("input[type=checkbox]").length,
    })),
  );
  expect(listed.length).toBeGreaterThan(10);
  expect(listed.filter((row) => !row.name || row.icon !== 1 || !row.described || row.switches !== 1)).toEqual([]);
  expect(listed.filter((row) => row.kind !== "Built-in")).toEqual([]);
  expect(listed.slice(0, 3).map((row) => row.name)).toEqual(["Sidebar", "Folders", "Note list"]);
  await expect(pluginRow(page, "Tabs and splits")).toContainText("Open notes in tabs, and side by side in splits.");
  await expect(pluginRow(page, "Vim mode").getByRole("checkbox")).not.toBeChecked();

  const search = page.getByRole("searchbox", { name: "Search plugins" });
  await search.fill("vim");
  await expect(pluginRows(page)).toHaveAccessibleName("Vim mode");
  await search.fill("SIDE BY SIDE IN SPLITS");
  await expect(pluginRows(page)).toHaveAccessibleName("Tabs and splits");
  await search.fill("no such plugin");
  await expect(pluginRows(page)).toHaveCount(0);
  await expect(page.getByText("No plugin matches.")).toBeVisible();

  // The search is still there on the way back from a plugin's details.
  await search.fill("kanb");
  await openDetails(page, "Kanban");
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect(search).toHaveValue("kanb");
  await expect(pluginRows(page)).toHaveAccessibleName("Kanban");

  await search.fill("");
  await page.setViewportSize({ width: 520, height: 800 });
  await expect(pluginRow(page, "Sidebar").getByRole("checkbox")).toBeVisible();
  expect(await fits(page)).toBe(true);
});

test("each plugin is a card of its own, and the whole card opens the plugin while its switch only switches", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins");
  const card = pluginRow(page, "Folders");
  await expect(card).toBeVisible();

  // Cards like a folder's notes: one column, each bordered all round and rounded, with space between them.
  const looks = await pluginRows(page).evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => {
      const style = getComputedStyle(row);
      const box = row.getBoundingClientRect();
      return { x: box.x, top: box.top, bottom: box.bottom, radius: style.borderTopLeftRadius, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
    }),
  );
  expect(looks.map((l) => l.radius)).toEqual(["12px", "12px", "12px"]);
  expect(looks.map((l) => l.borders)).toEqual(Array(3).fill(["1px", "1px", "1px", "1px"]));
  expect(new Set(looks.map((l) => l.x)).size).toBe(1);
  expect(looks[1]!.top - looks[0]!.bottom).toBe(10);
  expect(looks[2]!.top - looks[1]!.bottom).toBe(10);

  // A press anywhere on the card opens the plugin: on its description, its icon, and the bare card beside the switch.
  // Pressed with the mouse where each is, as a member would: the link lies over them, so they are not themselves what takes the press.
  const box = (await card.boundingBox())!;
  const middleOf = async (selector: string) => {
    const part = (await card.locator(selector).boundingBox())!;
    return [part.x + part.width / 2, part.y + part.height / 2] as const;
  };
  for (const at of [await middleOf(".plugin-about"), await middleOf(".plugin-icon"), [box.x + box.width - 90, box.y + box.height - 6] as const]) {
    await page.mouse.click(...at);
    await expect(page).toHaveURL(/\/plugins\/folders$/);
    await expect(page.getByRole("heading", { name: "Folders", level: 1 })).toBeVisible();
    await page.goBack();
    await expect(card).toBeVisible();
  }

  // The switch acts as itself and goes nowhere.
  await card.getByRole("checkbox", { name: "Folders" }).click();
  await expect(card.getByRole("checkbox", { name: "Folders" })).not.toBeChecked();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByRole("tree", { name: "Folders" })).toHaveCount(0);
  await card.getByRole("checkbox", { name: "Folders" }).click();
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();

  // By keyboard a card is one stop that opens on Enter, and its switch is the next.
  await pluginRow(page, "Sidebar").getByRole("checkbox").focus();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("link", { name: "Folders" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("checkbox", { name: "Folders" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card.getByRole("checkbox", { name: "Folders" })).not.toBeChecked();
  await expect(page).toHaveURL(/\/plugins$/);
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/plugins\/folders$/);
});

test("a built-in plugin's details show what it is, its pictures in the theme the app is in, what it adds as it registered it, and its switch", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins");
  await openDetails(page, "Kanban");
  await expect(page).toHaveURL(/\/plugins\/kanban$/);
  const details = page.locator(".plugin-details");
  await expect(details.locator(".plugin-head svg")).toHaveCount(1);
  await expect(details.locator(".plugin-meta")).toHaveText("Built-inComes with Common Ink");
  await expect(details).toContainText("A board of columns and cards kept in a note as headings and lists.");
  await expect(section(page, "Permissions")).toContainText("It comes with Common Ink and runs inside the app as you, so it asks for nothing");
  expect(await details.getByRole("region").evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label")))).toEqual(["Pictures", "Permissions", "What it adds", "Settings"]);

  const picture = section(page, "Pictures").locator("img:visible");
  const shown = () => picture.evaluate((img: HTMLImageElement) => [new URL(img.currentSrc || img.src).pathname, img.complete && img.naturalWidth > 600]);
  await expect(picture).toHaveCount(1);
  await expect(picture).toHaveAccessibleName("A board in a note: three columns of cards, each with a button to add a card.");
  await expect.poll(shown).toEqual(["/plugin-shots/kanban-light.png", true]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(shown).toEqual(["/plugin-shots/kanban-dark.png", true]);
  await page.emulateMedia({ colorScheme: "light" });

  const adds = section(page, "What it adds");
  await expect(adds.getByRole("group")).toHaveAccessibleName("Embeds");
  await expect(adds.getByRole("group", { name: "Embeds" })).toHaveText("Embeds 1Kanban board:::kanban{}");
  await expect(section(page, "Settings")).toHaveText("SettingsIt has no settings.");

  // Its switch is here, and what it added when it was on is still said once it is off.
  const toggle = details.getByRole("checkbox", { name: "Kanban", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(details.locator(".plugin-switch")).toHaveText("Off");
  await expect(adds).toContainText("It is off, so none of this is in the app now. This is what it adds when it is on.");
  await expect(adds.getByRole("group", { name: "Embeds" })).toContainText("Kanban board");
  await expect.poll(async () => JSON.parse((await perform(page, { type: "settings.read" })).text)).toEqual({ "kanban.enabled": false });
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect(pluginRow(page, "Kanban").getByRole("checkbox")).not.toBeChecked();

  await openDetails(page, "Tabs and splits");
  await expect(section(page, "What it adds").getByRole("group", { name: "Commands" })).toContainText("Close tab");
  await expect(section(page, "What it adds").getByRole("group", { name: "Views" })).toContainText("The editor area");
  await expect(section(page, "Pictures")).toHaveCount(0);

  await page.setViewportSize({ width: 520, height: 800 });
  await page.goto("/plugins/tables");
  await expect(section(page, "Pictures").locator("img:visible")).toHaveCount(1);
  await expect(section(page, "What it adds").getByRole("group", { name: "Commands" })).toContainText("Edit the next table");
  expect(await fits(page)).toBe(true);

  await page.goto("/plugins/no-such-plugin");
  await expect(page.getByText("There's no plugin here.")).toBeVisible();
});

test("a plugin's details have its settings and link to them in Settings, and one that hasn't been on says so until it is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins/vim");
  const details = page.locator(".plugin-details");
  await expect(page.getByRole("heading", { name: "Vim mode", level: 1 })).toBeVisible();
  await expect(details.locator(".plugin-switch")).toHaveText("Off");
  await expect(section(page, "What it adds")).toContainText("It hasn't been on since the app loaded, so what it adds isn't listed yet. Turn it on to see.");
  const own = section(page, "Settings").getByRole("group", { name: "Settings of Vim mode" });
  await expect(own.getByRole("checkbox")).toHaveAccessibleName("j and k move by the rows on screen");
  await expect(own).toContainText("Off, j and k move by whole lines");
  await expect(section(page, "Settings")).toContainText("Vim mode is off, so its options change nothing until it is turned on.");

  await details.getByRole("checkbox", { name: "Vim mode", exact: true }).check();
  await expect(section(page, "What it adds").getByRole("group", { name: "Editor extensions" })).toBeVisible();
  await expect(section(page, "What it adds").getByRole("group", { name: "Settings" })).toContainText("Settings 1");

  await section(page, "Settings").getByRole("link", { name: "Open in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/plugins\/vim$/);
  await expect(page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Vim mode" })).toHaveAttribute("aria-current", "page");
  const vim = page.getByRole("region", { name: "Vim mode", exact: true });
  await expect(vim.getByRole("checkbox")).toHaveAccessibleName("j and k move by the rows on screen");
  await vim.getByRole("link", { name: "About this plugin" }).click();
  await expect(page).toHaveURL(/\/plugins\/vim$/);
});

test("only a plugin that came with the app is called Built-in", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [{ id: "fixture", name: "Fixture", description: "A plugin a test put on the page.", activate() {} }];
  });
  await withNote(page, "Alpha");
  await page.goto("/plugins");
  await expect(pluginRow(page, "Backlinks").locator(".badge")).toHaveText("Built-in");
  await expect(pluginRow(page, "Fixture")).toContainText("A plugin a test put on the page.");
  await expect(pluginRow(page, "Fixture").locator(".badge")).toHaveCount(0);

  await page.goto("/plugins/fixture");
  await expect(page.getByRole("heading", { name: "Fixture", level: 1 })).toBeVisible();
  await expect(page.getByText("Built-in")).toHaveCount(0);
  await expect(page.locator(".plugin-meta")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Permissions" })).toHaveText("PermissionsIt runs inside the app as you, so it asks for nothing: it can do what you can, and no more. What it does with that is what it adds, below.");
  await page.goto("/plugins/backlinks");
  await expect(page.locator(".plugin-meta")).toHaveText("Built-inComes with Common Ink");
});

test("an inspector view a plugin adds is a tab only for what it says it is for, is handed that thing, and is found again by its label", async ({ page }) => {
  await page.addInitScript(() => {
    type Register = (slot: string, view: unknown) => void;
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register: Register } }) {
          host.views.register("inspector", { id: "count-note", label: "Count", icon: "info", for: "note", component: ({ note }: { note: { title: string } }) => `Counting the note ${note.title}` });
          host.views.register("inspector", { id: "count-folder", label: "Count", icon: "info", for: "folder", component: ({ name, notes }: { name: string; notes: unknown[] }) => `Counting ${notes.length} in ${name}` });
          host.views.register("inspector", { id: "about-page", label: "About", icon: "info", for: "page", component: ({ page }: { page: { label: string } }) => `About the page ${page.label}` });
        },
      },
    ];
  });
  await withNote(page, "Alpha");
  await keepNote(page, "Alpha");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const shown = inspector.getByRole("tab", { selected: true });

  // Nothing picked yet is Info, whatever a plugin adds after it.
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info", "Count"]);
  await expect(shown).toHaveText("Info");
  await inspector.getByRole("tab", { name: "Count" }).click();
  await expect(inspector.getByRole("tabpanel")).toHaveText("Counting the note Alpha");

  // A folder has its own view of that name, and it is the one that shows.
  await openAllNotes(page);
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Info", "Count"]);
  await expect(shown).toHaveText("Count");
  await expect(inspector.getByRole("tabpanel")).toHaveText("Counting 1 in All notes");

  // A page has only what was added for a page, and the pick is as it was when a note is in front again.
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(inspector.getByRole("tab")).toHaveText(["About"]);
  await expect(inspector.getByRole("tabpanel")).toHaveText("About the page Dashboard");
  await tabs(page).filter({ hasText: "Alpha" }).click();
  await expect(shown).toHaveText("Count");
  await expect(inspector.getByRole("tabpanel")).toHaveText("Counting the note Alpha");
});
