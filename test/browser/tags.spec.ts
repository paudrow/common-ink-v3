import { expect, type Locator, type Page } from "@playwright/test";
import { anotherPerson, join, me, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string | RegExp) => page.locator(".cm-line").filter({ hasText: text }).first();
const section = (page: Page) => page.getByRole("navigation", { name: "Tags" });
const listed = (page: Page) => section(page).getByRole("link");
const tagPage = (page: Page, tag: string) => page.getByRole("region", { name: `#${tag}`, exact: true });
/** The titles of the cards on a tag's page, as a folder's list draws them. */
const notesOf = (page: Page, tag: string) => tagPage(page, tag).getByRole("navigation", { name: "Notes" }).locator(".card-title");
const searchOf = (page: Page, tag: string) => tagPage(page, tag).getByLabel("Search notes");
/** Every tag on the page of every tag. */
const everyTag = (page: Page) => page.getByRole("region", { name: "Tags" }).getByRole("list", { name: "Tags" }).getByRole("link");
const create = (page: Page, text: string) => perform(page, { type: "note.create", text });
const manage = (page: Page) => page.getByRole("dialog", { name: "Settings" }).getByRole("region", { name: "Tags" });
const manageTable = (page: Page) => manage(page).getByRole("treegrid", { name: "Tags" });
const manageRows = (page: Page) => manageTable(page).locator("tbody tr[data-key]");
/** The row of the tag whose whole name, in lower case, is `key`, which stays while its name is being changed. */
const manageRow = (page: Page, key: string) => manageTable(page).locator(`tr[data-key="${key}"]`);
const names = (page: Page) => manageRows(page).getByRole("rowheader");
const levels = (page: Page) => manageRows(page).evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("aria-level"))));
/** Where a box is and how big, to the pixel. */
const boxOf = async (locator: Locator) => {
  const { x, y, width, height } = (await locator.boundingBox())!;
  return [x, y, width, height].map(Math.round);
};
const card = (page: Page) => page.getByRole("tooltip");

test("the sidebar lists the workspace's tags with how many notes have each, and follows a note that gains one", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/");
  await expect(section(page)).toContainText("Write #tag in a note to tag it.");
  await expect(listed(page)).toHaveCount(0);

  await create(page, "# Seeds\n\nOrder seeds #garden #Shopping\n");
  await create(page, "# Beds\n\n- [ ] Dig the beds #garden\n\n`#notatag` and #12 and\n\n```\n#fenced\n```\n");
  const archived = await create(page, "# Last year\n\n#garden #retired\n");
  await perform(page, { type: "note.archive", id: archived.id, archived: true });
  const plain = await create(page, "# Plain\n\nNo tags here.\n");
  await page.goto(`/note/${plain.id}`);
  await expect(listed(page)).toHaveText(["#garden2", "#Shopping1"]);
  await expect(listed(page).first().getByLabel("2 notes")).toHaveText("2");

  await expect(editor(page)).toContainText("No tags here.");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Now it has one: #shopping and #winter-2026");
  await expect(listed(page)).toHaveText(["#garden2", "#Shopping2", "#winter-20261"]);
  await expect.poll(async () => (await perform(page, { type: "tag.list" })).tags).toEqual([
    { name: "garden", notes: 2 },
    { name: "Shopping", notes: 2 },
    { name: "winter-2026", notes: 1 },
  ]);
});

test("a tag in the sidebar opens its page, which is a folder's list of the notes that have it: the tag held in its search, which narrows inside it, and archived ones under Archived", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden\n");
  await create(page, "# Beds\n\nDig the beds #garden\n");
  await create(page, "# Taxes\n\n#money\n");
  const old = await create(page, "# Last year\n\n#garden\n");
  await perform(page, { type: "note.archive", id: old.id, archived: true });
  const binned = await create(page, "# Binned\n\n#garden\n");
  await perform(page, { type: "note.trash", id: binned.id });
  await page.goto("/");

  await listed(page).filter({ hasText: "#garden" }).click();
  await expect(page).toHaveURL(/\/tags\/garden$/);
  const garden = tagPage(page, "garden");
  await expect(garden.getByRole("heading", { level: 1 })).toHaveText("#garden");
  await expect(listed(page).filter({ hasText: "#garden" })).toHaveAttribute("aria-current", "page");
  await expect(notesOf(page, "garden")).toHaveText(["Beds", "Seeds"]);
  await expect(garden.locator(".folder-count")).toHaveText("2 notes");
  // The same search bar as a folder's list, held to the tag as a folder's is held to the folder, and no New note: a tag is no place to put one.
  await expect(garden.locator(".finder-scope")).toHaveText("#garden");
  await expect(searchOf(page, "garden")).toHaveAttribute("placeholder", /^Search #garden: /);
  await expect(garden.getByRole("button", { name: "New note" })).toHaveCount(0);
  // With nothing typed a card shows no matched line: every one of them has the tag.
  await expect(garden.locator(".card-matches")).toHaveCount(0);

  await searchOf(page, "garden").fill("dig");
  await expect(notesOf(page, "garden")).toHaveText(["Beds"]);
  await expect(garden.locator(".card-matches mark")).toHaveText(["Dig"]);
  await searchOf(page, "garden").fill("taxes");
  await expect(garden.getByText("No notes match “taxes” in #garden.")).toBeVisible();
  await searchOf(page, "garden").fill("");
  await expect(notesOf(page, "garden")).toHaveText(["Beds", "Seeds"]);

  await garden.getByRole("radio", { name: "Archived" }).check();
  await expect(searchOf(page, "garden")).toHaveValue("is:archived");
  await expect(notesOf(page, "garden")).toHaveText(["Last year"]);
  await garden.getByRole("radio", { name: "All", exact: true }).check();
  await expect.poll(async () => (await notesOf(page, "garden").allTextContents()).sort()).toEqual(["Beds", "Last year", "Seeds"]);
  await garden.getByRole("radio", { name: "Active" }).check();
  await expect(notesOf(page, "garden")).toHaveText(["Beds", "Seeds"]);

  // The page is its address: it is there after a reload.
  await page.reload();
  await expect(notesOf(page, "garden")).toHaveText(["Beds", "Seeds"]);

  await tagPage(page, "garden").getByRole("link", { name: "Edit Seeds" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/seeds-${seeds.id}$`));
  await expect(editor(page)).toContainText("Order seeds #garden");

  await page.goBack();
  await expect(notesOf(page, "garden")).toHaveText(["Beds", "Seeds"]);

  // A tag is matched ignoring case, however the address writes it.
  await page.goto("/tags/GARDEN");
  await expect(tagPage(page, "GARDEN").getByRole("heading", { level: 1 })).toHaveText("#GARDEN");
  await expect(notesOf(page, "GARDEN")).toHaveText(["Beds", "Seeds"]);

  // The chip's cross takes the search to every note, the tag written in it.
  await searchOf(page, "GARDEN").fill("dig");
  await expect(notesOf(page, "GARDEN")).toHaveText(["Beds"]);
  await tagPage(page, "GARDEN").getByRole("button", { name: "Search all notes, not only #GARDEN" }).click();
  await expect(page).toHaveURL(/\/search\?q=tag%3AGARDEN\+dig$/);
  await expect(page.getByRole("region", { name: "Search" }).getByRole("navigation", { name: "Notes" }).locator(".card-title")).toHaveText(["Beds"]);
});

test("a tag's page asks again as notes gain the tag or lose it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden\n");
  const beds = await create(page, "# Beds\n\nDig the beds\n");
  await page.goto("/tags/garden");
  await expect(notesOf(page, "garden")).toHaveText(["Seeds"]);

  await perform(page, { type: "note.write", id: beds.id, baseRevision: beds.revision, text: "# Beds\n\nDig the beds #garden\n" });
  await perform(page, { type: "note.write", id: seeds.id, baseRevision: seeds.revision, text: "# Seeds\n\nOrder seeds\n" });
  // As soon as the app hears of the changes, as it does of anyone's.
  await expect(notesOf(page, "garden")).toHaveText(["Beds"], { timeout: 15_000 });
});

test("a tag's page takes its name from the address as text: a slash, other letters, and markup make no element", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Quarter\n\n#work/2026-q4 and #café\n");
  await page.goto("/");

  await listed(page).filter({ hasText: "#work/2026-q4" }).click();
  await expect(page).toHaveURL(/\/tags\/work\/2026-q4$/);
  await expect(notesOf(page, "work/2026-q4")).toHaveText(["Quarter"]);
  await page.reload();
  await expect(notesOf(page, "work/2026-q4")).toHaveText(["Quarter"]);

  await listed(page).filter({ hasText: "#café" }).click();
  await expect(page).toHaveURL(/\/tags\/caf%C3%A9$/);
  await expect(notesOf(page, "café")).toHaveText(["Quarter"]);

  const markup = "<img src=x onerror=window.pwned=1>";
  await page.goto(`/tags/${encodeURIComponent(markup)}`);
  await expect(tagPage(page, markup).getByRole("heading", { level: 1 })).toHaveText(`#${markup}`);
  await expect(tagPage(page, markup)).toContainText(`No notes have #${markup}.`);
  await expect(tagPage(page, markup).locator("img")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();

  await page.goto("/tags");
  await expect(page.getByRole("heading", { level: 1, name: "Tags" })).toBeVisible();
  // #work, which a note has a tag inside of, is listed with that note.
  await expect(everyTag(page)).toHaveText(["#café1", "#work1", "#work/2026-q41"]);
});

interface Place {
  /** The left edge of the line's first letter. */
  left: number;
  top: number;
  height: number;
  /** The left edge of each letter of the line, in order. */
  letters: number[];
}

/** Where a line is and where every one of its letters is, measured from the text itself. */
const placeOf = (at: Locator) =>
  at.evaluate((el): Place => {
    const letters: number[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent!.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        letters.push(range.getBoundingClientRect().x);
      }
    }
    const box = el.getBoundingClientRect();
    return { left: letters[0]!, top: box.top, height: box.height, letters };
  });

function expectUnmoved(now: Place, was: Place, when: string, within = 0.01) {
  for (const side of ["left", "top", "height"] as const) expect(Math.abs(now[side] - was[side]), `${side} ${when}: ${was[side]} -> ${now[side]}`).toBeLessThanOrEqual(within);
  expect(now.letters.length, `letters ${when}`).toBe(was.letters.length);
  for (const [i, x] of was.letters.entries()) expect(Math.abs(now.letters[i]! - x), `letter ${i} ${when}: ${x} -> ${now.letters[i]}`).toBeLessThanOrEqual(within);
}

/** The browser places each run of text on a grid of 1/64 of a pixel, so a tag's own run can start that far from where the letter was in its line's run. */
const A_RUN = 2 / 64;

const NOTE = ["# Tagged", "", "Intro line", "", "A line with #alpha in the middle, and #beta-2 at its end", "", "- [ ] !! Buy seeds #alpha due:2026-10-14", "", "`#incode` and #12 and [a link](https://example.com/#anchor) stay as they are", "", "```", "#fenced", "```", "", "Last line"].join("\n");
const PROSE = /A line with/;

async function openTagged(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1600 });
  const note = await create(page, NOTE);
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last line");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.evaluate(() => document.fonts.ready);
  return note;
}

test("a tag in a note is drawn as a tag where its characters were: nothing moves with the cursor on its line or off it, and no letter is anywhere else for the drawing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openTagged(page);
  const tags = editor(page).locator(".md-tag");
  // What the server takes for a tag and nothing else: not `#12`, code, a fence, or a link's address.
  await expect(tags).toHaveText(["#alpha", "#beta-2", "#alpha"]);
  await expect.poll(() => perform(page, { type: "tag.list" })).toEqual({ tags: [{ name: "alpha", notes: 1 }, { name: "beta-2", notes: 1 }], next: null, indexing: false });

  const look = (el: Element) => {
    const { color, fontSize, fontFamily, fontWeight, padding, margin, borderWidth, letterSpacing } = getComputedStyle(el);
    return { color, fontSize, fontFamily, fontWeight, padding, margin, borderWidth, letterSpacing };
  };
  const tagLook = await tags.first().evaluate(look);
  const lineLook = await line(page, PROSE).evaluate(look);
  expect(tagLook.color).not.toBe(lineLook.color);
  expect({ ...tagLook, color: "" }).toEqual({ ...lineLook, color: "", padding: "0px", margin: "0px", borderWidth: "0px" });

  const off = { prose: await placeOf(line(page, PROSE)), todo: await placeOf(line(page, /Buy seeds/)), last: await placeOf(line(page, "Last line")) };

  await line(page, PROSE).click();
  await expect(tags).toHaveText(["#alpha", "#beta-2", "#alpha"]);
  expectUnmoved(await placeOf(line(page, PROSE)), off.prose, "with the cursor on the tag's line");
  expectUnmoved(await placeOf(line(page, "Last line")), off.last, "below, with the cursor on the tag's line");
  await page.keyboard.press("Home");
  expectUnmoved(await placeOf(line(page, PROSE)), off.prose, "with the cursor at the start of the tag's line");

  // A todo's line draws its options as chips and its tag as a tag, once. With the cursor on one of them that token alone is as written, and the tag is where it was.
  await expect(line(page, /Buy seeds/).locator(".md-tag")).toHaveText(["#alpha"]);
  await expect(line(page, /Buy seeds/).locator(".md-todo-chip")).toHaveCount(2);
  const tagOnTodo = () => line(page, /Buy seeds/).locator(".md-tag").evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
  const drawn = await tagOnTodo();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(line(page, /Buy seeds/).locator(".md-todo-chip")).toHaveCount(2);
  await page.keyboard.press("End");
  await expect(line(page, /Buy seeds/).locator(".md-todo-chip")).toHaveCount(1);
  await expect(line(page, /Buy seeds/)).toContainText("due:2026-10-14");
  await expect(line(page, /Buy seeds/).locator(".md-tag")).toHaveText(["#alpha"]);
  const written = await tagOnTodo();
  // A chip is as wide as its token to within a fraction of a pixel, which is all the tag after it can differ by.
  for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(written[side] - drawn[side]), `${side} of the tag on the todo's line`).toBeLessThanOrEqual(0.5);
  expectUnmoved(await placeOf(line(page, "Last line")), off.last, "below, with the cursor on the todo's line");

  // Typing makes and unmakes a tag where it stands.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" #gamma");
  await expect(tags).toHaveText(["#alpha", "#beta-2", "#alpha", "#gamma"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("12");
  await expect(tags).toHaveText(["#alpha", "#beta-2", "#alpha"]);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+Home");
  expectUnmoved(await placeOf(line(page, PROSE)), off.prose, "after typing elsewhere");

  // With the Tags plugin off the note is as it was before there was any drawing of tags: every letter is where the drawing has it, to the grid the browser places a run of text on.
  await expect.poll(async () => (await perform(page, { type: "note.read", id: (await perform(page, { type: "note.list" })).notes.find((n) => n.title === "Tagged")!.id })).text).toBe(NOTE);
  await perform(page, { type: "settings.write", text: JSON.stringify({ "tags.enabled": false }), baseRevision: 0 });
  await page.reload();
  await expect(editor(page)).toContainText("Last line");
  await expect(tags).toHaveCount(0);
  await expect(section(page)).toHaveCount(0);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.evaluate(() => document.fonts.ready);
  expectUnmoved(await placeOf(line(page, PROSE)), off.prose, "with tags not drawn", A_RUN);
  expectUnmoved(await placeOf(line(page, /Buy seeds/)), off.todo, "on the todo's line, with tags not drawn", A_RUN);
  expectUnmoved(await placeOf(line(page, "Last line")), off.last, "below, with tags not drawn", A_RUN);
});

test("a click on a tag with the modifier opens the tag's page, and a plain click puts the cursor in it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openTagged(page);
  const tag = editor(page).locator(".md-tag").filter({ hasText: "#beta-2" });

  await tag.click();
  await expect(page).toHaveURL(/\/note\//);
  await page.keyboard.type("x");
  await expect(line(page, PROSE)).toContainText(/#be?t?a?x/);
  await page.keyboard.press("Backspace");

  await tag.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/tags\/beta-2$/);
  await expect(notesOf(page, "beta-2")).toHaveText(["Tagged"]);
});

test("a tag in the sidebar has a menu, as a folder's row has: a right-click, Shift+F10 or the menu key opens it, and it opens the tag's page here or in a split, or its row in Settings, to describe it there or to rename it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden\n");
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");
  const garden = listed(page).filter({ hasText: "#garden" });
  const menu = page.getByRole("menu", { name: "#garden actions" });

  await garden.click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Open in a split right", "Open in a split down", "Manage tags", "Rename tag"]);
  await menu.getByRole("menuitem", { name: "Open in a split right" }).click();
  const groups = page.getByRole("tablist", { name: "Open notes" });
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).getByRole("tab")).toHaveText(["Tags"]);
  await expect(notesOf(page, "garden")).toHaveText(["Seeds"]);

  // From the keyboard, and Escape gives the keyboard back to the tag.
  await garden.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(garden).toBeFocused();

  await garden.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Manage tags" }).click();
  await expect(page).toHaveURL(/\/settings\/tags$/);
  await expect(manageRow(page, "garden")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(manage(page).getByLabel("When to use #garden")).toBeFocused();
  await page.keyboard.type("Anything we grow");
  await page.keyboard.press("Enter");
  await expect(manageRows(page).locator(".manage-description")).toHaveText(["Anything we grow"]);
  await page.keyboard.press("Escape");

  await garden.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Rename tag" }).click();
  await expect(manage(page).getByLabel("Rename #garden")).toBeFocused();
  await expect(manage(page).getByLabel("Rename #garden")).toHaveValue("garden");
  await page.keyboard.press("Escape");
  await expect(manage(page).getByRole("textbox", { name: "Rename #garden" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A viewer's menu opens the page or the row, where the description is read, and offers nothing to change.
  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await listed(vera).filter({ hasText: "#garden" }).click({ button: "right" });
  const veraMenu = vera.getByRole("menu", { name: "#garden actions" });
  await expect(veraMenu.getByRole("menuitem")).toHaveText(["Open", "Open in a split right", "Open in a split down", "Manage tags"]);
  await veraMenu.getByRole("menuitem", { name: "Manage tags" }).click();
  await expect(manageRow(vera, "garden")).toBeFocused();
  await expect(manageRow(vera, "garden").locator(".manage-description")).toHaveText("Anything we grow");
});

test("Manage tags in a tag's menu on the page of every tag, and its card's link, open Settings' Tags at that tag's row, in view with the keyboard on it and the rows it is inside open, however far down it is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const many = Array.from({ length: 40 }, (_, i) => `#t${String(i).padStart(2, "0")}`).join(" ");
  await create(page, `# Many\n\n${many} #zz/deep/end\n`);
  await page.goto("/tags");
  const end = everyTag(page).filter({ hasText: "#zz/deep/end" });
  await end.click({ button: "right" });
  await page.getByRole("menu", { name: "#zz/deep/end actions" }).getByRole("menuitem", { name: "Manage tags" }).click();
  await expect(page).toHaveURL(/\/settings\/tags$/);
  const row = manageRow(page, "zz/deep/end");
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  expect(await row.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await expect(manageRow(page, "zz")).toHaveAttribute("aria-expanded", "true");
  await expect(manageRow(page, "zz/deep")).toHaveAttribute("aria-expanded", "true");
  await expect(manageRow(page, "t00")).not.toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  await end.hover();
  await card(page).getByRole("link", { name: "Manage tags" }).click();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
});

test("tags that may be missing some say the server is still indexing, and are read again until it isn't", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Seeds\n\nOrder seeds #garden\n");
  let indexed = false;
  // Until the note is "indexed", each answer is made to be one from a server that hasn't read it yet. After that they are the server's own.
  await page.route("**/ops", async (route) => {
    if (indexed || !route.request().postData()?.includes('"type":"tag.list"')) return route.continue();
    await route.fulfill({ response: await route.fetch(), json: { tags: [], next: null, indexing: true } });
  });
  await page.goto("/tags");
  const all = page.getByRole("region", { name: "Tags" });

  await expect(all.getByRole("status")).toHaveText("Still indexing notes. Results may be missing some.");
  await expect(listed(page)).toHaveCount(0);
  indexed = true;

  await expect(everyTag(page)).toHaveText(["#garden1"]);
  await expect(listed(page)).toHaveText(["#garden1"]);
  await expect(all.getByRole("status")).toHaveCount(0);
});


test("Settings' Tags lists every tag with how many notes have it and what it is for: Manage tags opens it, an admin says a description there by clicking it, in the box it is shown in, that agents read, kept after a reload and shown on the page of every tag, and emptied takes it away", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Seeds\n\nOrder seeds #garden\n");
  await create(page, "# Beds\n\nDig the beds #garden\n");
  await create(page, "# Taxes\n\n#money\n");
  await page.goto("/");
  await expect(listed(page)).toHaveText(["#garden2", "#money1"]);

  await runCommand(page, "Manage tags");
  await expect(page).toHaveURL(/\/settings\/tags$/);
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Tags" })).toHaveAttribute("aria-current", "page");
  await expect(manageRows(page)).toHaveCount(2);
  const garden = manageRow(page, "garden");
  await expect(garden.getByLabel("2 notes")).toHaveText("2");

  // Nothing moves as the description becomes a box: not the row, not its cell.
  const said = garden.locator(".manage-description");
  const before = [await boxOf(garden), await boxOf(garden.getByRole("gridcell").first())];
  await said.click();
  const field = manage(page).getByRole("textbox", { name: "When to use #garden" });
  await expect(field).toBeFocused();
  expect([await boxOf(garden), await boxOf(garden.getByRole("gridcell").first())]).toEqual(before);
  await page.keyboard.type("Anything we grow: seeds, beds and the greenhouse");
  await page.keyboard.press("Enter");
  await expect(said).toHaveText("Anything we grow: seeds, beds and the greenhouse");
  await expect(field).toHaveCount(0);
  await expect(garden).toBeFocused();
  await expect.poll(async () => (await perform(page, { type: "tag.list" })).tags).toEqual([
    { name: "garden", notes: 2, description: "Anything we grow: seeds, beds and the greenhouse" },
    { name: "money", notes: 1 },
  ]);

  // Escape leaves the description as it was, and Settings open. Enter on the row says it.
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("Anything we grow: seeds, beds and the greenhouse");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(said).toHaveText("Anything we grow: seeds, beds and the greenhouse");

  await page.reload();
  await expect(manageRows(page).locator(".manage-description").first()).toHaveText("Anything we grow: seeds, beds and the greenhouse");

  await page.goto("/tags");
  const every = page.getByRole("region", { name: "Tags" }).getByRole("listitem");
  await expect(every.filter({ hasText: "#garden" }).locator(".tag-row-description")).toHaveText("Anything we grow: seeds, beds and the greenhouse");
  await expect(every.filter({ hasText: "#money" }).locator(".tag-row-description")).toHaveCount(0);
  await page.getByRole("link", { name: "Manage tags" }).click();
  await expect(page).toHaveURL(/\/settings\/tags$/);

  await manageRow(page, "garden").locator(".manage-description").click();
  await field.fill("");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await perform(page, { type: "tag.list" })).tags[0]).toEqual({ name: "garden", notes: 2 });
});

test("Settings' Tags is a tree: a tag inside another, by its slash, is indented under it with its columns in line, every level in name order; a tag counts the notes of the tags inside it once each; and a search keeps the rows that match with the tags they are inside", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Both\n\n#project and #project/alpha\n");
  await create(page, "# Alpha\n\n#project/alpha #item10\n");
  await create(page, "# Docs\n\n#project/beta/docs #item2 #Garden\n");
  await perform(page, { type: "tag.describe", name: "project", description: "Work, a tag inside for each project" });
  await perform(page, { type: "tag.describe", name: "project/beta/docs", description: "Manuals" });
  await page.goto("/settings/tags");
  await expect(manageTable(page).getByRole("columnheader")).toHaveText(["Tag", "Description", "Notes"]);
  await expect(manageTable(page).getByRole("columnheader", { name: "Notes" })).toHaveAttribute("title", "Notes with this tag or any tag inside it");
  await expect(names(page)).toHaveText(["#Garden", "#item2", "#item10", "#project", "alpha", "beta", "docs"]);
  expect(await levels(page)).toEqual([1, 1, 1, 1, 2, 2, 3]);
  // #project counts its note and those inside it once each; #project/beta, which no note has itself, counts its tag's.
  await expect(manageRow(page, "project").getByLabel("3 notes")).toHaveAttribute("title", "1 note tagged #project itself, 3 counting the tags inside it");
  await expect(manageRow(page, "project/beta").getByLabel("1 note")).toHaveText("1");
  // Indented, and the columns line up all the same.
  const x = async (key: string) => Promise.all([manageRow(page, key).locator(".manage-name"), ...[0, 1].map((i) => manageRow(page, key).getByRole("gridcell").nth(i))].map(async (cell) => (await boxOf(cell))[0]));
  const [top, inner, innermost] = await Promise.all(["project", "project/alpha", "project/beta/docs"].map(x));
  expect(inner![0]! - top![0]!).toBeGreaterThan(10);
  expect(innermost![0]! - inner![0]!).toBeGreaterThan(10);
  expect([inner![1], inner![2], innermost![1], innermost![2]]).toEqual([top![1], top![2], top![1], top![2]]);

  // Shut and opened by its arrow or the keyboard.
  await manageRow(page, "project").getByRole("button", { name: "Collapse #project" }).click();
  await expect(names(page)).toHaveText(["#Garden", "#item2", "#item10", "#project"]);
  await manageRow(page, "project").focus();
  await page.keyboard.press("ArrowRight");
  await expect(names(page)).toHaveText(["#Garden", "#item2", "#item10", "#project", "alpha", "beta", "docs"]);
  await page.keyboard.press("ArrowDown");
  await expect(manageRow(page, "project/alpha")).toBeFocused();

  const search = manage(page).getByRole("searchbox", { name: "Search tags" });
  await search.fill("MANUAL");
  await expect(names(page)).toHaveText(["#project", "beta", "docs"]);
  await search.fill("#item");
  await expect(names(page)).toHaveText(["#item2", "#item10"]);
  await search.fill("rhubarb");
  await expect(manageTable(page)).toHaveCount(0);
  await expect(manage(page)).toContainText("No tag matches.");
  await search.fill("");
  await expect(manageRows(page)).toHaveCount(7);

  // The page of #project lists the notes of the tags inside it too, as the count says.
  await page.goto("/tags/project");
  await expect(notesOf(page, "project")).toHaveText(["Docs", "Alpha", "Both"]);

  await page.goto("/settings/tags");
  await page.setViewportSize({ width: 420, height: 800 });
  const garden = manageRow(page, "garden");
  const [narrowName, narrowSaid, narrowCount] = await Promise.all([garden.getByRole("rowheader"), garden.getByRole("gridcell").nth(0), garden.getByRole("gridcell").nth(1)].map(async (cell) => (await cell.boundingBox())!));
  expect(narrowCount!.y).toBeLessThan(narrowName!.y + narrowName!.height);
  expect(narrowSaid!.height === 0 || narrowSaid!.y >= narrowName!.y + narrowName!.height - 1).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
});

test("a tag is made ahead with New tag or inside another from its menu, named before it is kept, and a tag no note has is listed with none", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Plan\n\n#project\n");
  await page.goto("/settings/tags");
  await expect(names(page)).toHaveText(["#project"]);

  // With no name it is dropped, and a name that can't be a tag is said so.
  await manage(page).getByRole("button", { name: "New tag" }).click();
  await page.keyboard.press("Escape");
  await expect(manage(page).getByRole("textbox", { name: "New tag" })).toHaveCount(0);
  await manage(page).getByRole("button", { name: "New tag" }).click();
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await expect(manage(page).getByRole("alert")).toHaveText("That isn't a tag's name: letters, digits, _, / and -, with something besides digits.");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Reading");
  await page.keyboard.press("Enter");
  await expect(names(page)).toHaveText(["#project", "#Reading"]);
  await expect(manageRow(page, "reading").getByLabel("0 notes")).toHaveText("0");
  await expect(manageRow(page, "reading")).toBeFocused();

  await manageRow(page, "project").getByRole("rowheader").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "#project actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open", "RenameF2", "Edit descriptionEnter", "New tag inside", "Move to…"]);
  await menu.getByRole("menuitem", { name: "New tag inside" }).click();
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await expect(names(page)).toHaveText(["#project", "alpha", "#Reading"]);
  // One there already isn't made again, which would take its description away.
  await manage(page).getByRole("button", { name: "New tag" }).click();
  await page.keyboard.type("project");
  await page.keyboard.press("Enter");
  await expect(manage(page).getByRole("alert")).toHaveText("#project is already a tag.");
  await expect.poll(async () => (await perform(page, { type: "tag.list" })).tags).toEqual([
    { name: "project", notes: 1 },
    { name: "project/alpha", notes: 0 },
    { name: "Reading", notes: 0 },
  ]);
  // The sidebar lists only the tags notes have.
  await page.keyboard.press("Escape");
  await expect(listed(page)).toHaveText(["#project1"]);
});

test("a tag no note has, nor a tag inside it, is deleted from its menu or with Delete, with Undo, and stays deleted after a reload; a tag a note has, or one inside it, has no Delete", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Plan\n\n#project/beta\n");
  const old = await create(page, "# Old\n\n#old\n");
  await perform(page, { type: "note.archive", id: old.id, archived: true });
  await perform(page, { type: "tag.describe", name: "old", description: "Done with" });
  await perform(page, { type: "tag.describe", name: "Reading", description: "Books to read" });
  await perform(page, { type: "tag.describe", name: "later", description: "" });
  await perform(page, { type: "tag.describe", name: "trip", description: "" });
  await perform(page, { type: "tag.describe", name: "trip/Paris", description: "Spring" });
  const toast = page.locator(".toast-card");
  const tagNames = async () => (await perform(page, { type: "tag.list", includeArchived: true })).tags.map((t) => t.name);
  await page.goto("/settings/tags");
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta", "#Reading", "#trip", "Paris"]);

  const menuOf = async (key: string) => {
    await manageRow(page, key).getByRole("rowheader").click({ button: "right" });
    return page.getByRole("menu", { name: /actions$/ });
  };
  // #old has a note in Archive, which the table doesn't count.
  for (const key of ["project", "project/beta", "old"]) {
    await expect((await menuOf(key)).getByRole("menuitem")).toHaveText(["Open", "RenameF2", "Edit descriptionEnter", "New tag inside", "Move to…"]);
    await page.keyboard.press("Escape");
  }
  await manageRow(page, "project").focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(manageRow(page, "project")).toBeFocused();
  await expect(toast).toHaveCount(0);
  expect(await tagNames()).toEqual(["later", "old", "project", "project/beta", "Reading", "trip", "trip/Paris"]);

  const menu = await menuOf("reading");
  await expect(menu.getByRole("menuitem")).toHaveText(["Open", "RenameF2", "Edit descriptionEnter", "New tag inside", "Move to…", "Delete tagDelete"]);
  await menu.getByRole("menuitem", { name: "Delete tag" }).click();
  await expect(toast).toContainText("Deleted #Reading");
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta", "#trip", "Paris"]);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("#Reading is back");
  await expect(manageRow(page, "reading").locator(".manage-description")).toHaveText("Books to read");

  // From the keyboard the row after it takes the keyboard, and a parent goes with the tags inside it.
  await manageRow(page, "reading").focus();
  await page.keyboard.press("Delete");
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta", "#trip", "Paris"]);
  await expect(manageRow(page, "trip")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(toast.filter({ hasText: "Deleted #trip and the tag inside it" })).toBeVisible();
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta"]);
  await expect(manageRow(page, "project/beta")).toBeFocused();

  // A note given the tag since the table was read keeps it, and the row says so.
  await create(page, "# Someday\n\n#later\n");
  await (await menuOf("later")).getByRole("menuitem", { name: "Delete tag" }).click();
  await expect(manage(page).getByRole("alert")).toHaveText("#later is in use, so it stays.");
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta"]);

  await page.reload();
  await expect(names(page)).toHaveText(["#later", "#old", "#project", "beta"]);
  expect(await tagNames()).toEqual(["later", "old", "project", "project/beta"]);
});

test("a viewer and a guest read every tag's description in Settings and are given nothing to change it with, and the server refuses them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden\n");
  await perform(page, { type: "tag.describe", name: "garden", description: "Anything we grow" });
  await perform(page, { type: "tag.describe", name: "later", description: "" });
  const workspaceId = (await me(page)).workspaces[0]!.id;

  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  // Settings names no workspace, so they show the one the note chose once it opened.
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await runCommand(vera, "Manage tags");
  await expect(manageRows(vera).locator(".manage-description")).toHaveText(["Anything we grow"]);
  await expect(manage(vera)).toContainText("Admins and editors write it.");
  await expect(manage(vera).getByRole("button")).toHaveCount(0);
  // No box to write in, whatever is clicked, and nothing to drag.
  await manageRows(vera).locator(".manage-description").click();
  await manageRow(vera, "garden").locator(".manage-name").dblclick();
  await expect(manageTable(vera).getByRole("textbox")).toHaveCount(0);
  await expect(manageRow(vera, "garden").locator(".manage-name")).not.toHaveAttribute("draggable");
  // Nor any Delete, on a tag no note has.
  await manageRow(vera, "later").getByRole("rowheader").click({ button: "right" });
  await expect(vera.getByRole("menu", { name: "#later actions" }).getByRole("menuitem")).toHaveText(["Open"]);
  await vera.keyboard.press("Escape");
  await manageRow(vera, "later").focus();
  await vera.keyboard.press("Delete");
  await expect(manageRow(vera, "later")).toBeVisible();
  await expect(perform(vera, { type: "tag.describe", name: "garden", description: "Mine" }, workspaceId)).rejects.toThrow("A viewer can't tag.describe");

  const gus = await anotherPerson(page, "Gus Guest");
  await perform(page, { type: "grant.set", noteId: seeds.id, email: (await me(gus)).person.email, access: "edit" });
  await gus.goto(`/note/${seeds.id}`);
  await expect(editor(gus)).toContainText("Order seeds");
  await runCommand(gus, "Manage tags");
  await expect(manageRows(gus).locator(".manage-description")).toHaveText(["Anything we grow"]);
  await expect(manage(gus).getByRole("button")).toHaveCount(0);
  await expect(perform(gus, { type: "tag.describe", name: "garden", description: "Mine" }, workspaceId)).rejects.toThrow(/can't tag.describe/);
  expect((await perform(page, { type: "tag.list" })).tags).toEqual([{ name: "garden", notes: 1, description: "Anything we grow" }, { name: "later", notes: 0 }]);
});

test("resting on a tag shows its card, wherever it is drawn: how many notes have it and what it is for, or for whoever may say it a prompt to, with a link to Manage tags; the keyboard shows it too, and a viewer sees the name and count alone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden and pay #money\n");
  await perform(page, { type: "tag.describe", name: "money", description: "Bills and budgets" });
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");

  await listed(page).filter({ hasText: "#money" }).hover();
  await expect(card(page)).toContainText("#money1 note");
  await expect(card(page)).toContainText("Bills and budgets");
  await expect(card(page).getByRole("link", { name: "Manage tags" })).toBeVisible();
  await listed(page).filter({ hasText: "#garden" }).hover();
  await expect(card(page)).toContainText("#garden1 note");
  await expect(card(page)).toContainText("No description yet. Add one to help AI use #garden right.");
  await page.mouse.move(600, 5);
  await expect(card(page)).toHaveCount(0);

  // In the note's text, and the pointer can cross to the card to follow its link.
  await editor(page).locator(".md-tag", { hasText: "#garden" }).hover();
  await expect(card(page)).toContainText("No description yet.");
  await card(page).getByRole("link", { name: "Manage tags" }).click();
  await expect(page).toHaveURL(/\/settings\/tags$/);
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  // The keyboard on a tag shows its card, which describes it, and Escape takes it away.
  const money = listed(page).filter({ hasText: "#money" });
  await money.focus();
  await expect(card(page)).toContainText("Bills and budgets");
  await expect(money).toHaveAttribute("aria-describedby", (await card(page).getAttribute("id"))!);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(money).not.toHaveAttribute("aria-describedby");

  // In the note, the cursor resting in a tag shows it, and typing takes it away.
  await line(page, "Order seeds").click();
  await page.keyboard.press("End");
  await expect(card(page)).toContainText("Bills and budgets");
  await page.keyboard.type("y");
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Backspace");

  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await listed(vera).filter({ hasText: "#garden" }).hover();
  await expect(card(vera)).toHaveText("#garden1 note");
  await listed(vera).filter({ hasText: "#money" }).hover();
  await expect(card(vera)).toHaveText("#money1 noteBills and budgets");
});

test("a tag opens its page from wherever it is drawn: a plain click on one in a folder list's card, a modifier-click on a todo's chip, whose plain click narrows the Todos page, and its card's name", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Errands\n\n- [ ] Buy stamps #errand\n");
  await create(page, "# Books\n\n- [ ] Read a book #reading\n");
  await page.goto("/");
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes", exact: true }).click();
  const errands = page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: "Errands", exact: true });
  await errands.locator(".md-tag", { hasText: "#errand" }).click();
  await expect(page).toHaveURL(/\/tags\/errand$/);
  await expect(notesOf(page, "errand")).toHaveText(["Errands"]);

  await page.goto("/todos");
  const chip = page.locator("button.todo-tag", { hasText: "#errand" });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("button.todo-tag")).toHaveText(["#errand"]);
  await chip.click();
  await expect(page.locator("button.todo-tag")).toHaveText(["#reading", "#errand"]);
  await chip.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/tags\/errand$/);

  await page.goto("/todos");
  await page.locator("button.todo-tag", { hasText: "#reading" }).hover();
  await card(page).getByRole("link", { name: "#reading" }).click();
  await expect(page).toHaveURL(/\/tags\/reading$/);
  await expect(notesOf(page, "reading")).toHaveText(["Books"]);
});

test("an admin renames a tag in its row: what it changes is said first, renaming into a tag there merges the two, and Undo puts every note and description back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nOrder seeds #garden, not `#garden`\n");
  const beds = await create(page, "# Beds\n\n- [ ] Dig #garden due:2026-10-14\n");
  await create(page, "# Pots\n\nRepot #plants\n");
  await perform(page, { type: "tag.describe", name: "garden", description: "Anything we grow" });
  const toast = page.locator(".toast-card");
  const textOf = async (id: string) => (await perform(page, { type: "note.read", id })).text;
  await page.goto("/settings/tags");
  await expect(manageRows(page)).toHaveCount(2);

  // A double click on the name changes it in the box it is shown in, and a name that can't be a tag is said so.
  const garden = manageRow(page, "garden");
  const before = await boxOf(garden);
  await garden.locator(".manage-name").dblclick();
  const field = manage(page).getByRole("textbox", { name: "Rename #garden" });
  await expect(field).toHaveValue("garden");
  expect(await boxOf(garden)).toEqual(before);
  await field.fill("12");
  await page.keyboard.press("Enter");
  await expect(manage(page).getByRole("alert")).toHaveText("That isn't a tag's name: letters, digits, _, / and -, with something besides digits.");

  await field.fill("#yard");
  await page.keyboard.press("Enter");
  const confirm = manage(page).getByRole("form", { name: "Rename #garden" });
  await expect(confirm).toContainText("Rename #garden to #yard in 2 notes? Its description goes with it. Each note's history has the change, and Undo puts them all back.");
  expect(await textOf(seeds.id)).toBe("# Seeds\n\nOrder seeds #garden, not `#garden`\n");
  await expect(confirm.getByRole("button", { name: "Rename in 2 notes" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toast).toContainText("Renamed #garden to #yard in 2 notes");
  await expect(names(page)).toHaveText(["#plants", "#yard"]);
  await expect(manageRow(page, "yard")).toBeFocused();
  await expect(manageRow(page, "yard").locator(".manage-description")).toHaveText("Anything we grow");
  expect(await textOf(seeds.id)).toBe("# Seeds\n\nOrder seeds #yard, not `#garden`\n");
  expect(await textOf(beds.id)).toBe("# Beds\n\n- [ ] Dig #yard due:2026-10-14\n");
  const [change] = (await perform(page, { type: "note.history", id: beds.id })).slice(-1);
  expect(change!.author.name).toBe("Ada Lovelace");

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("#garden is back");
  await expect(names(page)).toHaveText(["#garden", "#plants"]);
  expect(await textOf(beds.id)).toBe("# Beds\n\n- [ ] Dig #garden due:2026-10-14\n");
  expect((await perform(page, { type: "tag.list" })).tags).toEqual([
    { name: "garden", notes: 2, description: "Anything we grow" },
    { name: "plants", notes: 1 },
  ]);

  // F2, into a tag there: the two become one, and Undo takes the description it brought off #plants.
  await manageRow(page, "garden").focus();
  await page.keyboard.press("F2");
  await page.keyboard.type("plants");
  await page.keyboard.press("Enter");
  await expect(manage(page).getByRole("form", { name: "Rename #garden" })).toContainText("#plants is already a tag, so the two become one.");
  await manage(page).getByRole("button", { name: "Rename in 2 notes" }).click();
  await expect(toast.filter({ hasText: "Renamed #garden to #plants in 2 notes" })).toBeVisible();
  await expect(names(page)).toHaveText(["#plants"]);
  await expect(manageRows(page).getByLabel("3 notes")).toHaveText("3");
  await expect(listed(page)).toHaveText(["#plants3"]);
  await toast.filter({ hasText: "Renamed #garden to #plants" }).getByRole("button", { name: "Undo" }).click();
  await expect(names(page)).toHaveText(["#garden", "#plants"]);
  await expect.poll(async () => (await perform(page, { type: "tag.list" })).tags).toEqual([
    { name: "garden", notes: 2, description: "Anything we grow" },
    { name: "plants", notes: 1 },
  ]);

  // Its pencil, and Cancel leaves it all as it was.
  await manageRow(page, "garden").hover();
  await manageRow(page, "garden").getByRole("button", { name: "Rename #garden" }).click();
  await page.keyboard.type("yard");
  await page.keyboard.press("Enter");
  await manage(page).getByRole("button", { name: "Cancel" }).click();
  await expect(names(page)).toHaveText(["#garden", "#plants"]);
});

test("renaming or moving a tag takes the tags inside it along: dragged by its name onto another, what it becomes is said before the drop; dragged to the strip under the table it goes to the top; and Move to… does the same from the keyboard", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const kickoff = await create(page, "# Kickoff\n\n#alpha and #alpha/notes\n");
  await create(page, "# Plan\n\n#project\n");
  await perform(page, { type: "tag.describe", name: "alpha/notes", description: "Meeting notes" });
  const textOf = async () => (await perform(page, { type: "note.read", id: kickoff.id })).text;
  await page.goto("/settings/tags");
  await expect(names(page)).toHaveText(["#alpha", "notes", "#project"]);

  const name = manageRow(page, "alpha").locator(".manage-name");
  await expect(name).toHaveAttribute("title", "Drag to move");
  await name.hover();
  await page.mouse.down();
  const onto = (await manageRow(page, "project").boundingBox())!;
  await page.mouse.move(onto.x + 40, onto.y + onto.height / 2, { steps: 8 });
  await expect(page.locator(".manage-drag-label")).toHaveText("#alpha → #project/alpha");
  await expect(manageRow(page, "project")).toHaveAttribute("data-drop", "true");
  await expect(manageRow(page, "alpha")).toHaveAttribute("data-dragging", "true");
  await page.mouse.up();
  const confirm = manage(page).getByRole("form", { name: "Rename #alpha" });
  await expect(confirm).toContainText("Rename #alpha to #project/alpha in 1 note? #alpha/notes goes with it.");
  await confirm.getByRole("button", { name: "Rename in 1 note" }).click();
  await expect(names(page)).toHaveText(["#project", "alpha", "notes"]);
  expect(await levels(page)).toEqual([1, 2, 3]);
  expect(await textOf()).toBe("# Kickoff\n\n#project/alpha and #project/alpha/notes\n");
  await expect(manageRow(page, "project/alpha/notes").locator(".manage-description")).toHaveText("Meeting notes");

  // To the top, by the strip that shows while a tag inside another is dragged.
  await manageRow(page, "project/alpha").locator(".manage-name").hover();
  await page.mouse.down();
  await page.mouse.move(onto.x + 40, onto.y + onto.height * 4, { steps: 4 });
  const strip = manage(page).getByText("Drop here to move to the top level");
  const at = (await strip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 8 });
  await expect(page.locator(".manage-drag-label")).toHaveText("#project/alpha → #alpha");
  await page.mouse.up();
  await manage(page).getByRole("button", { name: "Rename in 1 note" }).click();
  await expect(names(page)).toHaveText(["#alpha", "notes", "#project"]);
  await expect(strip).toHaveCount(0);

  // Renaming a tag's own part keeps it where it is, and its tags inside go with it.
  await manageRow(page, "alpha/notes").locator(".manage-name").dblclick();
  await expect(manage(page).getByRole("textbox", { name: "Rename #alpha/notes" })).toHaveValue("notes");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("minutes");
  await page.keyboard.press("Enter");
  await manage(page).getByRole("button", { name: "Rename in 1 note" }).click();
  await expect(names(page)).toHaveText(["#alpha", "minutes", "#project"]);
  expect(await textOf()).toBe("# Kickoff\n\n#alpha and #alpha/minutes\n");

  // Move to… from the keyboard.
  await manageRow(page, "alpha").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "#alpha actions" }).getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("combobox", { name: "Move #alpha to" }).fill("project");
  await page.keyboard.press("Enter");
  await manage(page).getByRole("button", { name: "Rename in 1 note" }).click();
  await expect(names(page)).toHaveText(["#project", "alpha", "minutes"]);
  expect(await textOf()).toBe("# Kickoff\n\n#project/alpha and #project/alpha/minutes\n");
});

test("a hover card stays while the pointer rests anywhere on it, its description and its padding too, and goes once the pointer leaves it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\nPay #money\n");
  await perform(page, { type: "tag.describe", name: "money", description: "Bills and budgets" });
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Pay");
  await listed(page).filter({ hasText: "#money" }).hover();
  await expect(card(page)).toContainText("Bills and budgets");
  const description = (await card(page).getByText("Bills and budgets").boundingBox())!;
  await page.mouse.move(description.x + description.width / 2, description.y + description.height / 2, { steps: 10 });
  await page.waitForTimeout(1500);
  await expect(card(page)).toContainText("Bills and budgets");
  const box = (await card(page).boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(1500);
  await expect(card(page)).toContainText("Bills and budgets");
  await page.mouse.move(700, 300, { steps: 5 });
  await expect(card(page)).toHaveCount(0);
});

test("a hover card stays while the pointer crosses to it, over other tags on the way, and goes once the pointer has left both", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const seeds = await create(page, "# Seeds\n\n#alpha #beta #gamma #garden #money\n");
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("#alpha");
  const beta = listed(page).filter({ hasText: "#beta" });
  await beta.hover();
  await expect(card(page)).toContainText("#beta1 note");
  // Slowly, down across #gamma and #garden, to the link at the card's foot.
  const link = (await card(page).getByRole("link", { name: "Manage tags" }).boundingBox())!;
  await page.mouse.move(link.x + link.width / 2, link.y + link.height / 2, { steps: 30 });
  await expect(card(page)).toContainText("#beta1 note");
  await page.waitForTimeout(500);
  await expect(card(page)).toContainText("#beta1 note");
  await page.mouse.move(700, 300, { steps: 5 });
  await expect(card(page)).toHaveCount(0);
});
