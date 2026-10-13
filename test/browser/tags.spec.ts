import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

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
const tagPage = (page: Page, tag: string) => page.getByRole("region", { name: `Tag ${tag}` });
const notesOf = (page: Page, tag: string) => tagPage(page, tag).getByRole("list", { name: `Notes with #${tag}` }).getByRole("listitem");
const create = (page: Page, text: string) => perform(page, { type: "note.create", text });

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

test("a tag in the sidebar opens its page, which lists the notes that have it, archived ones only when included", async ({ page }) => {
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
  await expect(tagPage(page, "garden").getByRole("heading", { level: 1 })).toHaveText("#garden");
  await expect(listed(page).filter({ hasText: "#garden" })).toHaveAttribute("aria-current", "page");
  await expect(notesOf(page, "garden").locator(".found-title")).toHaveText(["Beds", "Seeds"]);

  await tagPage(page, "garden").getByLabel("Include archived").check();
  await expect(notesOf(page, "garden").locator(".found-title")).toHaveText(["Last year", "Beds", "Seeds"]);
  await expect(notesOf(page, "garden").filter({ hasText: "Last year" }).locator(".found-meta")).toContainText("Archived");

  // The page is its address: it is there after a reload, with archived notes left out again.
  await page.reload();
  await expect(notesOf(page, "garden").locator(".found-title")).toHaveText(["Beds", "Seeds"]);

  await notesOf(page, "garden").filter({ hasText: "Seeds" }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/note/seeds-${seeds.id}$`));
  await expect(editor(page)).toContainText("Order seeds #garden");

  await page.goBack();
  await expect(notesOf(page, "garden").locator(".found-title")).toHaveText(["Beds", "Seeds"]);

  // A tag is matched ignoring case, however the address writes it.
  await page.goto("/tags/GARDEN");
  await expect(tagPage(page, "GARDEN").getByRole("heading", { level: 1 })).toHaveText("#GARDEN");
  await expect(notesOf(page, "GARDEN").locator(".found-title")).toHaveText(["Beds", "Seeds"]);
});

test("a tag's page takes its name from the address as text: a slash, other letters, and markup make no element", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Quarter\n\n#work/2026-q4 and #café\n");
  await page.goto("/");

  await listed(page).filter({ hasText: "#work/2026-q4" }).click();
  await expect(page).toHaveURL(/\/tags\/work\/2026-q4$/);
  await expect(notesOf(page, "work/2026-q4").locator(".found-title")).toHaveText(["Quarter"]);
  await page.reload();
  await expect(notesOf(page, "work/2026-q4").locator(".found-title")).toHaveText(["Quarter"]);

  await listed(page).filter({ hasText: "#café" }).click();
  await expect(page).toHaveURL(/\/tags\/caf%C3%A9$/);
  await expect(notesOf(page, "café").locator(".found-title")).toHaveText(["Quarter"]);

  const markup = "<img src=x onerror=window.pwned=1>";
  await page.goto(`/tags/${encodeURIComponent(markup)}`);
  await expect(tagPage(page, markup).getByRole("heading", { level: 1 })).toHaveText(`#${markup}`);
  await expect(tagPage(page, markup)).toContainText(`No notes have #${markup}.`);
  await expect(tagPage(page, markup).locator("img")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();

  await page.goto("/tags");
  await expect(page.getByRole("heading", { level: 1, name: "Tags" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tags" }).getByRole("link")).toHaveText(["#café1", "#work/2026-q41"]);
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

const NOTE = ["# Tagged", "", "Intro line", "", "A line with #alpha in the middle, and #beta-2 at its end", "", "- [ ] Buy seeds +Garden #alpha due:2026-10-14", "", "`#incode` and #12 and [a link](https://example.com/#anchor) stay as they are", "", "```", "#fenced", "```", "", "Last line"].join("\n");
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
  await expect.poll(() => perform(page, { type: "tag.list" })).toEqual({ tags: [{ name: "alpha", notes: 1 }, { name: "beta-2", notes: 1 }], indexing: false });

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

  // A todo's line draws its options as chips and its tag as a tag, once. With the cursor there every token is as written, and the tag is where it was.
  await expect(line(page, /Buy seeds/).locator(".md-tag")).toHaveText(["#alpha"]);
  await expect(line(page, /Buy seeds/).locator(".md-todo-chip")).toHaveCount(2);
  const tagOnTodo = () => line(page, /Buy seeds/).locator(".md-tag").evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
  const drawn = await tagOnTodo();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(line(page, /Buy seeds/).locator(".md-todo-chip")).toHaveCount(0);
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
  await expect.poll(async () => (await perform(page, { type: "note.read", id: (await perform(page, { type: "note.list" })).find((n) => n.title === "Tagged")!.id })).text).toBe(NOTE);
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
  await expect(notesOf(page, "beta-2").locator(".found-title")).toHaveText(["Tagged"]);
});

test("tags that may be missing some say the server is still indexing, and are read again until it isn't", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Seeds\n\nOrder seeds #garden\n");
  let indexed = false;
  // Until the note is "indexed", each answer is made to be one from a server that hasn't read it yet. After that they are the server's own.
  await page.route("**/ops", async (route) => {
    if (indexed || !route.request().postData()?.includes('"type":"tag.list"')) return route.continue();
    await route.fulfill({ response: await route.fetch(), json: { tags: [], indexing: true } });
  });
  await page.goto("/tags");
  const all = page.getByRole("region", { name: "Tags" });

  await expect(all.getByRole("status")).toHaveText("Still indexing notes. Results may be missing some.");
  await expect(listed(page)).toHaveCount(0);
  indexed = true;

  await expect(all.getByRole("link")).toHaveText(["#garden1"]);
  await expect(listed(page)).toHaveText(["#garden1"]);
  await expect(all.getByRole("status")).toHaveCount(0);
});
