import { expect, test, type Locator, type Page } from "@playwright/test";
import { listedNote, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

/** Opens a note from the list of every note as a preview, which is what a click on its title does. */
async function preview(page: Page, title: string) {
  await openAllNotes(page);
  await listedNote(page, title).click();
}

/** Opens a note from the list of every note in a tab that is kept, which is what its pencil does. */
async function keep(page: Page, title: string) {
  await openAllNotes(page);
  await noteCard(page, title).getByRole("button", { name: `Edit ${title}` }).click();
}

const tabBar = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group);
const tabs = (page: Page, group = 0) => tabBar(page, group).getByRole("tab");
const tab = (page: Page, title: string, group = 0) => tabs(page, group).filter({ hasText: new RegExp(`^${title}$`) });
const italic = async (page: Page, group = 0) => tabs(page, group).evaluateAll((els) => els.map((el) => getComputedStyle(el).fontStyle === "italic"));

async function withNotes(page: Page, ...titles: string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const notes = [];
  for (const title of titles) notes.push(await perform(page, { type: "note.create", text: `# ${title}\n\nAbout ${title}.` }));
  await page.reload();
  return notes;
}

test("a single click opens a note in an italic preview tab, and the next single click replaces it", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");

  // The list is a preview, and the note opened from it takes its place: one italic tab throughout.
  await preview(page, "Alpha");
  await expect(tabs(page)).toHaveText(["Alpha"]);
  await expect.poll(() => italic(page)).toEqual([true]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");

  await preview(page, "Beta");
  await expect(tabs(page)).toHaveText(["Beta"]);
  await expect.poll(() => italic(page)).toEqual([true]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await expect(page).toHaveURL(/\/note\/beta-[a-z0-9]{12}$/);
});

test("a note's pencil keeps it in its own tab, and so does double-clicking its tab or typing in it", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma");

  await keep(page, "Alpha");
  await preview(page, "Beta");
  await expect(tabs(page)).toHaveText(["Beta", "Alpha"]);
  await expect.poll(() => italic(page)).toEqual([true, false]);

  await tab(page, "Beta").dblclick();
  await expect.poll(() => italic(page)).toEqual([false, false]);

  await preview(page, "Gamma");
  await expect(tabs(page)).toHaveText(["Beta", "Gamma", "Alpha"]);
  await expect.poll(() => italic(page)).toEqual([false, true, false]);
  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.type(" more");
  await expect.poll(() => italic(page)).toEqual([false, false, false]);

  await tab(page, "Alpha").click();
  await expect(tab(page, "Alpha")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(page).toHaveURL(/\/note\/alpha-[a-z0-9]{12}$/);
});

test("dragging a note onto the editor splits it, and onto a tab bar adds or moves a tab", async ({ page }) => {
  const [alpha, beta] = await withNotes(page, "Alpha", "Beta", "Gamma");
  const group = (n: number) => page.getByRole("region", { name: `Editor group ${n}` });
  const noteUrl = page.getByRole("complementary", { name: "Inspector" }).getByRole("textbox", { name: "Note URL" });
  await keep(page, "Alpha");
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("tab", { name: "Info" }).click();

  const { width } = (await group(1).boundingBox())!;
  await openAllNotes(page);
  await noteCard(page, "Beta").dragTo(group(1), { targetPosition: { x: width * 0.8, y: 130 } });
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await expect.poll(() => italic(page, 1)).toEqual([false]);
  await expect(group(2).locator(".cm-line")).toHaveText(["# Beta", "", "About Beta."]);
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));
  await expect(noteUrl).toHaveValue(new RegExp(`${beta!.id}$`));
  await tab(page, "Alpha").click();
  await expect(group(1).locator(".cm-line")).toHaveText(["# Alpha", "", "About Alpha."]);
  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));

  const visited = await page.evaluate(() => history.length);
  await group(1).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha!.id}$`));
  await expect(noteUrl).toHaveValue(new RegExp(`${alpha!.id}$`));
  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));
  await tab(page, "Alpha").click();
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha!.id}$`));
  expect(await page.evaluate(() => history.length)).toBe(visited);

  await tab(page, "All notes").click();
  await noteCard(page, "Gamma").dragTo(tabBar(page, 1));
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect.poll(() => italic(page, 1)).toEqual([false, false]);
  await expect(group(2).locator(".cm-line").first()).toHaveText("# Gamma");

  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect(tab(page, "Gamma", 1)).toHaveAttribute("aria-selected", "true");

  await tab(page, "Gamma", 1).dragTo(tabBar(page, 0), { targetPosition: { x: 5, y: 10 } });
  await expect(tabs(page, 0)).toHaveText(["Gamma", "All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);

  await tab(page, "Beta", 1).dragTo(tabBar(page, 0), { targetPosition: { x: (await tabBar(page, 0).boundingBox())!.width - 5, y: 10 } });
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await expect(tabs(page)).toHaveText(["Gamma", "All notes", "Alpha", "Beta"]);
  await expect(group(2)).toHaveCount(0);
});

test("a tab's menu closes the others, those to its left, those to its right, or all of them", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma", "Delta");
  const choose = async (title: string, item: string) => {
    await tab(page, title).click({ button: "right" });
    await page.getByRole("menu", { name: `${title} tab` }).getByRole("menuitem", { name: item, exact: true }).click();
  };
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) await keep(page, title);
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta", "Gamma", "Delta"]);

  await choose("Gamma", "Close to the right");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta", "Gamma"]);
  await expect(tab(page, "Gamma")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-line").first()).toHaveText("# Gamma");

  await choose("Beta", "Close to the left");
  await expect(tabs(page)).toHaveText(["Beta", "Gamma"]);

  await keep(page, "Alpha");
  await expect(tabs(page)).toHaveText(["Beta", "Gamma", "All notes", "Alpha"]);
  await choose("Gamma", "Close others");
  await expect(tabs(page)).toHaveText(["Gamma"]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Gamma");

  await tab(page, "Gamma").click({ button: "right" });
  for (const item of ["Close others", "Close to the left", "Close to the right"]) await expect(page.getByRole("menuitem", { name: item })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("dialog", { name: "Go to note" }).getByRole("option", { name: /Delta/ }).click();
  await expect(tabs(page)).toHaveText(["Gamma", "Delta"]);
  await choose("Gamma", "Close all");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("⇧⌘P lists the commands, narrows them as you type, and runs the one chosen", async ({ page }) => {
  await withNotes(page, "Alpha");
  await preview(page, "Alpha");
  const text = page.getByRole("textbox", { name: "Note text" });
  await text.click();
  const palette = page.getByRole("dialog", { name: "Commands" });

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette.getByRole("combobox")).toBeFocused();
  for (const title of ["New note", "Go to note…", "Open All notes", "Toggle focus", "Toggle inspector", "Close other tabs", "Go to Dashboard"]) {
    await expect(palette.getByRole("option", { name: title })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(text).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("toggle focus");
  await expect(palette.getByRole("option")).toHaveText([/^Toggle focus/]);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("toggle focus");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Left rail" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("insp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await palette.getByRole("option", { name: "New note" }).click();
  await expect(tabs(page)).toHaveText(["Alpha", "Untitled"]);
  await expect(text).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("no such command");
  await expect(palette.getByText("No commands match.")).toBeVisible();
});

test("⌘P finds notes by title, best match first, and opens the one chosen in its own tab", async ({ page }) => {
  await withNotes(page, "Meeting notes", "Trip planning", "Plan");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+P");
  await expect(palette.getByRole("option")).toHaveCount(3);
  await page.keyboard.type("pl");
  await expect(palette.getByRole("option")).toHaveText([/^Plan/, /^Trip planning/]);
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["Trip planning"]);
  await expect.poll(() => italic(page)).toEqual([false]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Trip planning");
  await expect(page).toHaveURL(/\/note\/trip-planning-[a-z0-9]{12}$/);

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.keyboard.type("meet");
  await palette.getByRole("option", { name: /Meeting notes/ }).click();
  await expect(tabs(page)).toHaveText(["Trip planning", "Meeting notes"]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Meeting notes");
});

const isOp = (body: string | null, type: string) => body?.includes(`"${type}"`) ?? false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a new note stays listed when a listing asked for before it answers after it", async ({ page }) => {
  await page.route("**/ops", async (route) => {
    if (!isOp(route.request().postData(), "note.list")) return route.continue();
    const response = await route.fetch();
    await pause(1500);
    await route.fulfill({ response });
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Plan");
  await expect(tabs(page)).toHaveText(["Plan"]);

  // The list of every note is drawn once the listing has answered, which is after the note was made.
  await openAllNotes(page);
  await expect(page.getByRole("searchbox", { name: "Filter notes" })).toBeVisible();
  await expect(listedNote(page, "Plan")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toHaveAccessibleDescription("1");
});

test("coming back to a tab while its save is on the way shows what was typed", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "Alpha").click();
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await page.route("**/ops", async (route) => {
    if (isOp(route.request().postData(), "note.write")) await pause(800);
    await route.continue();
  });

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.type("typed late ");
  await tab(page, "Beta").click();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await tab(page, "Alpha").click();

  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("typed late");
  await expect(page.getByRole("status")).toHaveText("Saved");
});

const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });
const boxOf = async (part: Locator) => {
  const { x, y, width, height } = (await part.boundingBox())!;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
};
const storedLayout = (page: Page) => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith("ink.plugin.tabs.") && key.endsWith(".layout"))![1]) as { groups: { tabs: { id: string }[] }[]; split?: { direction: string; panes: unknown[]; sizes: number[] } });

/** Takes a tab by the mouse and holds it over a point of a group's body, a share of the way across and down it. The button is still down after. */
async function holdOver(page: Page, from: Locator, body: Locator, across: number, down: number) {
  const box = (await body.boundingBox())!;
  await from.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width * across, box.y + box.height * down, { steps: 3 });
  // The browser tells the page where a drag is a move late, so the pointer is moved once more where it already is.
  await page.mouse.move(box.x + box.width * across + 1, box.y + box.height * down + 1);
  await page.mouse.move(box.x + box.width * across, box.y + box.height * down);
}

test("a tab splits down from its menu and from the command, inside a split to the right, and the arrangement is kept", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma", "Delta");
  for (const title of ["Alpha", "Beta", "Gamma"]) await keep(page, title);
  await tab(page, "All notes").click({ button: "right" });
  await page.getByRole("menu", { name: "All notes tab" }).getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(tabs(page)).toHaveText(["Alpha", "Beta", "Gamma"]);

  await tab(page, "Gamma").click({ button: "right" });
  await page.getByRole("menu", { name: "Gamma tab" }).getByRole("menuitem", { name: "Split down" }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Gamma"]);
  const top = await boxOf(group(page, 1));
  const bottom = await boxOf(group(page, 2));
  expect(bottom.x).toBe(top.x);
  expect(bottom.width).toBe(top.width);
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(Math.abs(bottom.height - top.height)).toBeLessThanOrEqual(2);
  await expect(group(page, 2).locator(".cm-line").first()).toHaveText("# Gamma");

  await tab(page, "Beta").click();
  await tab(page, "Beta").click({ button: "right" });
  await page.getByRole("menu", { name: "Beta tab" }).getByRole("menuitem", { name: "Split right" }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await expect(tabs(page, 2)).toHaveText(["Gamma"]);
  const [a, b, c] = [await boxOf(group(page, 1)), await boxOf(group(page, 2)), await boxOf(group(page, 3))];
  expect(b.y).toBe(a.y);
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
  expect(c.y).toBeGreaterThanOrEqual(a.y + a.height);
  expect(c.width).toBeGreaterThanOrEqual(a.width + b.width);

  await page.reload();
  await expect(tabs(page, 2)).toHaveText(["Gamma"]);
  await expect.poll(() => boxOf(group(page, 1))).toEqual(a);
  await expect.poll(() => boxOf(group(page, 2))).toEqual(b);
  await expect.poll(() => boxOf(group(page, 3))).toEqual(c);
  expect((await storedLayout(page)).split).toEqual({ direction: "column", panes: [{ direction: "row", panes: ["1", "3"], sizes: [1, 1] }, "2"], sizes: [1, 1] });

  await group(page, 1).getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("dialog", { name: "Go to note" }).getByRole("option", { name: /Delta/ }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Delta"]);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: "Split editor down" }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Delta"]);
  await expect(tabs(page, 2)).toHaveText(["Beta"]);
  await expect(tabs(page, 3)).toHaveText(["Gamma"]);
  const [alpha, delta] = [await boxOf(group(page, 1)), await boxOf(group(page, 2))];
  expect(delta.x).toBe(alpha.x);
  expect(delta.width).toBe(alpha.width);
  expect(delta.y).toBeGreaterThanOrEqual(alpha.y + alpha.height);
  expect(delta.y + delta.height).toBeLessThanOrEqual(c.y);
});

test("a layout kept before a group could be split down opens as it was, side by side", async ({ page }) => {
  const [alpha, beta] = await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await page.evaluate(
    ([a, b]) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("ink.plugin.tabs.") && k.endsWith(".layout"))!;
      localStorage.setItem(key, JSON.stringify({ groups: [{ id: "1", tabs: [{ noteId: a, preview: false }], activeNoteId: a }, { id: "2", tabs: [{ noteId: b, preview: true }], activeNoteId: b }], focusedGroupId: "2" }));
    },
    [alpha!.id, beta!.id],
  );
  await page.goto("/");

  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await expect.poll(() => italic(page, 1)).toEqual([true]);
  const [left, right] = [await boxOf(group(page, 1)), await boxOf(group(page, 2))];
  expect(right.y).toBe(left.y);
  expect(right.x).toBeGreaterThan(left.x);
  await expect(page).toHaveURL(new RegExp(`${beta!.id}$`));
});

test("a tab held over a group shows where it would land: the middle adds it there, and each of the four edges splits that way", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma", "Delta");
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) await keep(page, title);
  await tab(page, "All notes").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await tab(page, "Delta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split right" }).click();
  await expect(tabs(page, 1)).toHaveText(["Delta"]);
  const body = group(page, 2).locator(".group-body");
  const whole = await boxOf(body);
  const zone = page.locator(".drop-zone");

  const shown: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [name, across, down] of [["left", 0.1, 0.5], ["right", 0.9, 0.5], ["up", 0.5, 0.1], ["down", 0.5, 0.9], ["middle", 0.5, 0.5], ["middle", 0.3, 0.7]] as const) {
    await holdOver(page, tab(page, "Gamma"), body, across, down);
    await expect(zone).toHaveAttribute("data-zone", name);
    shown[name] = await boxOf(zone);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(zone).toHaveCount(0);
  }
  const half = { width: Math.round(whole.width / 2), height: Math.round(whole.height / 2) };
  expect(shown.middle).toEqual(whole);
  expect(shown.left).toMatchObject({ x: whole.x, y: whole.y, height: whole.height });
  expect(shown.right).toMatchObject({ y: whole.y, height: whole.height });
  expect(shown.up).toMatchObject({ x: whole.x, y: whole.y, width: whole.width });
  expect(shown.down).toMatchObject({ x: whole.x, width: whole.width });
  expect(Math.abs(shown.left!.width - half.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.right!.x - (whole.x + half.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.up!.height - half.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.down!.y - (whole.y + half.height))).toBeLessThanOrEqual(1);
  // Escape let each of them go where it was.
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta", "Gamma"]);

  await holdOver(page, tab(page, "Gamma"), body, 0.5, 0.5);
  await page.mouse.up();
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Delta", "Gamma"]);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(2);
  await expect(tab(page, "Gamma", 1)).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 2).locator(".cm-line").first()).toHaveText("# Gamma");

  await holdOver(page, tab(page, "Beta"), body, 0.5, 0.9);
  await page.mouse.up();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Delta", "Gamma"]);
  await expect(tabs(page, 2)).toHaveText(["Beta"]);
  const [over, under] = [await boxOf(group(page, 2)), await boxOf(group(page, 3))];
  expect(under.x).toBe(over.x);
  expect(under.y).toBeGreaterThanOrEqual(over.y + over.height);

  await holdOver(page, tab(page, "Delta", 1), group(page, 1).locator(".group-body"), 0.5, 0.1);
  await page.mouse.up();
  await expect(tabs(page, 0)).toHaveText(["Delta"]);
  await expect(tabs(page, 1)).toHaveText(["Alpha"]);
  expect((await boxOf(group(page, 2))).y).toBeGreaterThanOrEqual((await boxOf(group(page, 1))).y + (await boxOf(group(page, 1))).height);
});

test("the edge between two halves of a split is dragged, moved with the arrow keys, kept across a reload, and put back with a double-click", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "Beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split right" }).click();
  const edge = page.getByRole("separator", { name: "Resize split left and right" });
  await expect(edge).toHaveAttribute("aria-orientation", "vertical");
  await expect(edge).toHaveAttribute("aria-valuenow", "50");
  const even = await boxOf(group(page, 1));

  const at = (await edge.boundingBox())!;
  const middle = at.x + at.width / 2;
  await page.mouse.move(middle, at.y + 200);
  await page.mouse.down();
  await page.mouse.move(middle + 60, at.y + 200, { steps: 4 });
  await page.mouse.move(middle + 120, at.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.abs((await boxOf(group(page, 1))).width - (even.width + 120))).toBeLessThanOrEqual(2);
  const dragged = await boxOf(group(page, 1));

  await page.reload();
  await expect(group(page, 2)).toBeVisible();
  await expect.poll(() => boxOf(group(page, 1))).toEqual(dragged);

  await edge.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await boxOf(group(page, 1))).width).toBeLessThan(dragged.width);
  await page.keyboard.press("Home");
  await expect(edge).toHaveAttribute("aria-valuenow", "10");
  expect((await boxOf(group(page, 1))).width).toBeLessThan((await boxOf(group(page, 2))).width / 5);

  await edge.dblclick();
  await expect(edge).toHaveAttribute("aria-valuenow", "50");
  expect(Math.abs((await boxOf(group(page, 1))).width - even.width)).toBeLessThanOrEqual(1);
  expect((await storedLayout(page)).split).toBeUndefined();

  await tab(page, "Beta", 1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await keep(page, "Beta");
  await tab(page, "Beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split down" }).click();
  const level = page.getByRole("separator", { name: "Resize split up and down" });
  await expect(level).toHaveAttribute("aria-orientation", "horizontal");
  const before = await boxOf(group(page, 1));
  await level.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await boxOf(group(page, 1))).height).toBeGreaterThan(before.height);
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.abs((await boxOf(group(page, 1))).height - before.height)).toBeLessThanOrEqual(1);
});

const PAGES = [
  ["/dashboard", "Dashboard"],
  ["/search", "Search"],
  ["/todos", "Todos"],
  ["/calendar", "Calendar"],
  ["/history", "History"],
  ["/contacts", "Contacts"],
  ["/uploads", "Uploads"],
  ["/settings", "Settings"],
  ["/plugins", "Plugins"],
  ["/members", "Members"],
  ["/sharing", "Sharing"],
  ["/agents", "Agents"],
] as const;

test("every page opens in a tab at its own address, and is drawn there", async ({ page }) => {
  await withNotes(page, "Alpha");
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  for (const [path, label] of PAGES) {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.keyboard.type(`Go to ${label}`);
    await page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: new RegExp(`^Go to ${label}`) }).first().click();
    await expect(tabs(page)).toHaveText([label]);
    await expect(tab(page, label)).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, label)).toHaveAttribute("data-kind", "page");
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(group(page, 1).locator(".page-pane > *").first()).toBeVisible();
    await expect(group(page, 1).getByText("There's nothing at this address.")).toHaveCount(0);
  }
  // Each took the place of the one before, as a preview does: every page looked at left one tab.
  await expect.poll(() => italic(page)).toEqual([true]);
});

test("a page's tab is a preview until it is kept, is focused and not opened twice, sits in a split, and comes back after a reload", async ({ page }) => {
  await withNotes(page, "Alpha");
  const nav = page.getByRole("navigation", { name: "Modes" });

  await nav.getByRole("link", { name: "Search" }).click();
  await expect(tabs(page)).toHaveText(["Search"]);
  await expect.poll(() => italic(page)).toEqual([true]);
  await expect(page).toHaveURL(/\/search$/);
  await nav.getByRole("link", { name: "Todos" }).click();
  await expect(tabs(page)).toHaveText(["Todos"]);
  await expect(page.getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();

  await tab(page, "Todos").dblclick();
  await expect.poll(() => italic(page)).toEqual([false]);
  await nav.getByRole("link", { name: "Search" }).click();
  await expect(tabs(page)).toHaveText(["Todos", "Search"]);
  await expect.poll(() => italic(page)).toEqual([false, true]);

  await tab(page, "Todos").click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await tab(page, "Search").click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();

  await tab(page, "Search").click({ button: "right" });
  await page.getByRole("menu", { name: "Search tab" }).getByRole("menuitem", { name: "Split down" }).click();
  await expect(tabs(page, 0)).toHaveText(["Todos"]);
  await expect(tabs(page, 1)).toHaveText(["Search"]);
  await expect(group(page, 1).getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await expect(group(page, 2).getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/search$/);

  // Todos is open in the other group: its link turns to it there, and opens no second tab.
  await nav.getByRole("link", { name: "Todos" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByRole("tab", { name: "Todos" })).toHaveCount(1);
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  // The page in the other half is still at its own address.
  await expect(group(page, 2).getByRole("heading", { name: "Search", level: 1 })).toBeVisible();

  // A note opened from a page that is kept goes beside it.
  await group(page, 2).getByRole("heading", { name: "Search", level: 1 }).click();
  await expect(page).toHaveURL(/\/search$/);
  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("dialog", { name: "Go to note" }).getByRole("option", { name: /Alpha/ }).click();
  await expect(tabs(page, 1)).toHaveText(["Search", "Alpha"]);
  await expect(group(page, 2).locator(".cm-line").first()).toHaveText("# Alpha");

  // Back goes to the page the note was opened from, in its tab, and forward to the note.
  await page.goBack();
  await expect(tab(page, "Search", 1)).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/search$/);
  await page.goForward();
  await expect(tab(page, "Alpha", 1)).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["Todos"]);
  await expect(tabs(page, 1)).toHaveText(["Search", "Alpha"]);
  await expect(group(page, 1).getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await tab(page, "Search", 1).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(group(page, 2).getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
});

test("Settings and Plugins each keep to one tab through every category and plugin's details, at the address of what is showing, across a reload, Back, and a split", async ({ page }) => {
  await withNotes(page, "Alpha");
  const categories = page.getByRole("navigation", { name: "Categories" });
  const more = page.getByRole("navigation", { name: "Modes" });

  await page.goto("/settings");
  await expect(tabs(page)).toHaveText(["Settings"]);
  await tab(page, "Settings").dblclick();
  for (const [name, path] of [["Keyboard shortcuts", "/settings/keyboard"], ["Appearance", "/settings/appearance"], ["Vim mode", "/settings/plugins/vim"]] as const) {
    await categories.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(categories.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
    await expect(tabs(page)).toHaveText(["Settings"]);
  }
  await page.getByRole("button", { name: "Open settings (JSON)" }).click();
  await expect(page).toHaveURL(/\/settings\/json$/);
  await expect(tabs(page)).toHaveText(["Settings"]);
  await page.getByRole("button", { name: "Open settings (UI)" }).click();
  await categories.getByRole("link", { name: "Vim mode", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/plugins\/vim$/);

  // From a plugin's settings to what the plugin is, which is the Plugins page's and opens in its tab.
  await page.getByRole("link", { name: "About this plugin" }).click();
  await expect(page).toHaveURL(/\/plugins\/vim$/);
  await expect(tabs(page)).toHaveText(["Settings", "Plugins"]);
  await expect(page.getByRole("heading", { name: "Vim mode", level: 1 })).toBeVisible();
  // More opened itself on arriving at a page under it.
  await expect(more.getByRole("button", { name: "Less" })).toBeVisible();
  await expect(more.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
  await tab(page, "Plugins").dblclick();

  // Each tab is at the address it was left at.
  await tab(page, "Settings").click();
  await expect(page).toHaveURL(/\/settings\/plugins\/vim$/);
  await expect(page.getByRole("region", { name: "Vim mode", exact: true })).toBeVisible();
  await tab(page, "Plugins").click();
  await expect(page).toHaveURL(/\/plugins\/vim$/);

  // Back from a plugin's details reached from the list is the list, in the same tab.
  await more.getByRole("link", { name: "Plugins" }).click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(tabs(page)).toHaveText(["Settings", "Plugins"]);
  await page.getByRole("list", { name: "Plugins", exact: true }).getByRole("link", { name: "Tabs and splits" }).click();
  await expect(page).toHaveURL(/\/plugins\/tabs$/);
  await expect(more.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByRole("list", { name: "Plugins", exact: true })).toBeVisible();
  await expect(tabs(page)).toHaveText(["Settings", "Plugins"]);
  await page.goForward();
  await expect(page).toHaveURL(/\/plugins\/tabs$/);
  await expect(page.getByRole("heading", { name: "Tabs and splits", level: 1 })).toBeVisible();
  await expect(tabs(page)).toHaveText(["Settings", "Plugins"]);

  // Side by side, each is still where it was, and a reload brings both back there.
  await tab(page, "Plugins").click({ button: "right" });
  await page.getByRole("menu", { name: "Plugins tab" }).getByRole("menuitem", { name: "Split right" }).click();
  await expect(tabs(page, 0)).toHaveText(["Settings"]);
  await expect(tabs(page, 1)).toHaveText(["Plugins"]);
  await expect(group(page, 1).getByRole("region", { name: "Vim mode", exact: true })).toBeVisible();
  await expect(group(page, 2).getByRole("heading", { name: "Tabs and splits", level: 1 })).toBeVisible();
  // In half the window the categories are a menu above the settings.
  await group(page, 1).getByRole("combobox", { name: "Category" }).selectOption({ label: "Appearance" });
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(group(page, 2).getByRole("heading", { name: "Tabs and splits", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Plugins" })).toHaveCount(1);

  await page.reload();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(tabs(page, 0)).toHaveText(["Settings"]);
  await expect(tabs(page, 1)).toHaveText(["Plugins"]);
  await expect(group(page, 1).getByRole("region", { name: "Appearance", exact: true })).toBeVisible();
  await expect(group(page, 2).getByRole("heading", { name: "Tabs and splits", level: 1 })).toBeVisible();
  await tab(page, "Plugins", 1).click();
  await expect(page).toHaveURL(/\/plugins\/tabs$/);
});

test("a page a plugin adds opens in a tab, with the plugin doing nothing for it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          host.views.register("page", { id: "fixture-page", path: "/fixture", label: "Fixture page", nav: "primary", component: ({ app }: { app: { path: string } }) => `Fixture at ${app.path}` });
        },
      },
    ];
  });
  await withNotes(page, "Alpha");
  await keep(page, "Alpha");

  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Fixture page" }).click();
  // The list of every note was the group's preview, and the page takes its place as the next thing previewed does.
  await expect(tabs(page)).toHaveText(["Fixture page", "Alpha"]);
  expect(await italic(page)).toEqual([true, false]);
  await expect(tab(page, "Fixture page")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 1).locator(".page-pane")).toHaveText("Fixture at /fixture");

  await page.goto("/fixture/deeper");
  await expect(tabs(page)).toHaveText(["Fixture page", "Alpha"]);
  await expect(group(page, 1).locator(".page-pane")).toHaveText("Fixture at /fixture/deeper");
  await tab(page, "Alpha").click();
  await tab(page, "Fixture page").click();
  await expect(page).toHaveURL(/\/fixture\/deeper$/);
});

test("a page that only leads somewhere else leaves the editor of a note open beside it as it was: the same one, not one made again", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          host.views.register("page", {
            id: "fixture-onward",
            path: "/onward",
            label: "Onward",
            nav: "primary",
            transient: true,
            component: ({ app }: { app: { show(tab: unknown): void } }) => {
              setTimeout(() => app.show({ kind: "note", id: (window as unknown as { onwardTo: string }).onwardTo }), 400);
              return "On the way";
            },
          });
        },
      },
    ];
  });
  const [, , gamma] = await withNotes(page, "Alpha", "Beta", "Gamma");
  await page.evaluate((id) => ((window as unknown as { onwardTo: string }).onwardTo = id), gamma!.id);
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Split editor right");
  await page.keyboard.press("Enter");
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  const alpha = page.getByRole("region", { name: "Editor group 1" }).locator(".cm-editor");
  await expect(alpha.locator(".cm-line").first()).toContainText("Alpha");
  await alpha.evaluate((el) => ((el as HTMLElement & { wasThere?: boolean }).wasThere = true));

  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Onward" }).click();
  await expect(page.getByRole("main").getByText("On the way")).toBeVisible();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect(page).toHaveURL(/\/note\/gamma-/);
  await expect(page.getByRole("main").getByText("On the way")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Onward" })).toHaveCount(0);
  expect(await alpha.evaluate((el) => (el as HTMLElement & { wasThere?: boolean }).wasThere)).toBe(true);
});

test("a key sequence begun and given up takes no key from a note: a press elsewhere, a move of focus or a wait ends it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { commands: { register(command: unknown): void } }) {
          host.commands.register({ id: "fixture.count", title: "Count", keys: ["g a"], run: () => void (document.body.dataset.ran = String(Number(document.body.dataset.ran ?? 0) + 1)) });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plum\n\nwords" });
  await page.goto(`/note/${note.id}`);
  const editor = page.getByRole("textbox", { name: "Note text" });
  const row = page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes", exact: true });
  const ran = () => page.evaluate(() => document.body.dataset.ran ?? "0");
  await expect(editor).toContainText("words");

  // The sequence runs its command where nothing is typed.
  await row.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await expect.poll(ran).toBe("1");

  // g waits for the rest. A press in the note ends the wait, so what is typed next arrives in its text.
  await row.focus();
  await page.keyboard.press("g");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("xa");
  await expect(editor.locator(".cm-line").last()).toHaveText("wordsxa");

  // So does focus going there with no press.
  await row.focus();
  await page.keyboard.press("g");
  await editor.focus();
  await page.keyboard.type("y");
  await expect(editor.locator(".cm-line").last()).toHaveText("wordsxay");

  // And so does time: an a long after the g finishes nothing.
  await row.focus();
  await page.keyboard.press("g");
  await page.waitForTimeout(1800);
  await page.keyboard.press("a");
  expect(await ran()).toBe("1");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Plum\n\nwordsxay");
});

