import { expect, test, type Page } from "@playwright/test";
import { listedNote, noteIdIn, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const searchPage = (page: Page) => page.getByRole("region", { name: "Search" });
const field = (page: Page) => searchPage(page).getByRole("combobox", { name: "Search notes" });
const results = (page: Page) => searchPage(page).getByRole("listbox", { name: "Results" }).getByRole("option");
const titles = (page: Page) => results(page).locator(".found-title");
const status = (page: Page) => searchPage(page).getByRole("status");
const includeArchived = (page: Page) => searchPage(page).getByLabel("Include archived");
const create = (page: Page, text: string) => perform(page, { type: "note.create", text });

/** Signs in, makes the notes in order, and opens the Search page. */
async function searching(page: Page, texts: readonly string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const notes = [];
  for (const text of texts) notes.push(await create(page, text));
  await page.goto("/search");
  await expect(field(page)).toBeFocused();
  return notes;
}

const GARDEN = "# Garden plan\n\nPlant the tomatoes by the fence.\n";
const ERRANDS = "# Errands\n\n- [ ] Call the bank about the mortgage +Home\n";
const READING = "# Reading\n\nNotes on gardening books #botany\n";
const SCRAPS = "# Scraps\n\nfence the by, tomatoes later\n";

test("search finds a note by a word of its text, a todo's words, a tag, a project, and a phrase in quotes", async ({ page }) => {
  await searching(page, [GARDEN, ERRANDS, READING, SCRAPS]);
  await expect(status(page)).toHaveText("Type to search the notes you can see: their text, todos, tags and projects.");
  await expect(searchPage(page)).toContainText('Words, "a phrase", #tag, +project');

  await field(page).fill("tomat");
  await expect(titles(page)).toHaveText(["Scraps", "Garden plan"]);
  await expect(status(page)).toHaveText("2 notes");
  await expect(results(page).filter({ hasText: "Garden plan" }).locator(".found-line")).toHaveText("Plant the tomatoes by the fence.");
  await expect(results(page).filter({ hasText: "Garden plan" }).locator("mark")).toHaveText(["tomat"]);
  await expect(results(page).filter({ hasText: "Garden plan" }).locator(".found-meta")).toContainText("Unsorted");

  await field(page).fill("bank mortgage");
  await expect(titles(page)).toHaveText(["Errands"]);
  await expect(results(page).locator(".found-line")).toHaveText("- [ ] Call the bank about the mortgage +Home");
  await expect(results(page).locator("mark")).toHaveText(["bank", "mortgage"]);

  await field(page).fill("#botany");
  await expect(titles(page)).toHaveText(["Reading"]);
  await expect(results(page).locator("mark")).toHaveText(["#botany"]);

  await field(page).fill("+home");
  await expect(titles(page)).toHaveText(["Errands"]);
  await expect(results(page).locator("mark")).toHaveText(["+Home"]);

  await field(page).fill("by the fence");
  await expect(titles(page)).toHaveText(["Scraps", "Garden plan"]);
  await field(page).fill('"by the fence"');
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(results(page).locator("mark")).toHaveText(["by the fence"]);

  await field(page).fill("");
  await expect(results(page)).toHaveCount(0);
  await expect(status(page)).toHaveText(/^Type to search/);
});

test("a matched line is shown as the characters it is: HTML and markdown in a note make no element", async ({ page }) => {
  await searching(page, ['# Risky <i>title</i>\n\n<img src=x onerror="window.pwned = 1"> and **bold** zebra <script>window.pwned = 2</script>\n']);

  await field(page).fill("zebra");
  await expect(titles(page)).toHaveText(["Risky <i>title</i>"]);
  await expect(results(page).locator(".found-line")).toHaveText('<img src=x onerror="window.pwned = 1"> and **bold** zebra <script>window.pwned = 2</script>');
  await expect(results(page).locator("mark")).toHaveText(["zebra"]);

  await field(page).fill("bold img");
  await expect(results(page).locator("mark")).toHaveText(["img", "bold"]);
  await expect(results(page).locator(".found-line")).toContainText("**bold**");

  // The only elements in a result are the ones the page makes: nothing came out of the note's text.
  expect(await results(page).first().evaluate((el) => [...el.querySelectorAll("*")].map((child) => child.tagName.toLowerCase()).sort())).toEqual(["a", "mark", "mark", "span", "span", "span", "span", "span"]);
  expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
});

test("an archived note is found only when archived notes are included, and a note in Trash never", async ({ page }) => {
  const [, archived, trashed, burrow] = await searching(page, ["# Live quokka\n\nquokka facts\n", "# Old quokka\n\nquokka history\n", "# Binned quokka\n\nquokka rubbish\n", "# Burrow\n\nwombat\n"]);
  await perform(page, { type: "note.archive", id: archived!.id, archived: true });
  await perform(page, { type: "note.archive", id: burrow!.id, archived: true });
  await perform(page, { type: "note.trash", id: trashed!.id });

  await field(page).fill("quokka");
  await expect(titles(page)).toHaveText(["Live quokka"]);
  await expect(includeArchived(page)).not.toBeChecked();

  await includeArchived(page).check();
  await expect(titles(page)).toHaveText(["Old quokka", "Live quokka"]);
  await expect(results(page).filter({ hasText: "Old quokka" }).locator(".found-meta")).toContainText("Archived");
  await expect(results(page).filter({ hasText: "Live quokka" }).locator(".found-meta")).not.toContainText("Archived");
  await expect(page).toHaveURL(/\/search\?q=quokka&archived=1$/);

  await field(page).fill("wombat");
  await expect(titles(page)).toHaveText(["Burrow"]);
  await includeArchived(page).uncheck();
  await expect(status(page)).toHaveText("No notes match “wombat”. Archived notes are left out unless you include them.");
  await expect(results(page)).toHaveCount(0);

  await field(page).fill("rubbish");
  await expect(status(page)).toHaveText("No notes match “rubbish”. Archived notes are left out unless you include them.");
  await includeArchived(page).check();
  await expect(status(page)).toHaveText("No notes match “rubbish”. Archived notes were included.");
});

test("the search is in the address: it survives a reload, and Back returns to it from a note it opened", async ({ page }) => {
  const [garden] = await searching(page, [GARDEN, ERRANDS]);

  await field(page).fill('"the tomatoes" plant');
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(page).toHaveURL(/\/search\?q=%22the\+tomatoes%22\+plant$/);

  await page.reload();
  await expect(field(page)).toHaveValue('"the tomatoes" plant');
  await expect(field(page)).toBeFocused();
  await expect(titles(page)).toHaveText(["Garden plan"]);

  await results(page).first().click();
  await expect(page).toHaveURL(new RegExp(`/note/garden-plan-${garden!.id}$`));
  await expect(editor(page)).toContainText("Plant the tomatoes by the fence.");

  await page.goBack();
  await expect(field(page)).toHaveValue('"the tomatoes" plant');
  await expect(titles(page)).toHaveText(["Garden plan"]);

  // A search someone was sent opens as that search.
  await page.goto("/search?q=mortgage");
  await expect(field(page)).toHaveValue("mortgage");
  await expect(titles(page)).toHaveText(["Errands"]);
});

test("a result is a link to its note: a click with the modifier opens it in a new tab and leaves the search where it is", async ({ page }) => {
  const [garden] = await searching(page, [GARDEN]);
  await field(page).fill("tomatoes");
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(results(page).locator("a")).toHaveAttribute("href", `/note/garden-plan-${garden!.id}`);

  const [tab] = await Promise.all([page.context().waitForEvent("page"), results(page).first().click({ modifiers: ["ControlOrMeta"] })]);
  await expect(tab).toHaveURL(new RegExp(`${garden!.id}$`));
  await expect(page).toHaveURL(/\/search\?q=tomatoes$/);
  await expect(titles(page)).toHaveText(["Garden plan"]);
});

test("More results appends the next page until there are no more", async ({ page }) => {
  await searching(page, Array.from({ length: 23 }, (_, i) => `# Kiwi ${String(i + 1).padStart(2, "0")}\n\nkiwi number ${i + 1}\n`));
  const more = searchPage(page).getByRole("button", { name: "More results" });

  await field(page).fill("kiwi");
  await expect(results(page)).toHaveCount(20);
  await expect(status(page)).toHaveText("20 notes, and more");
  const first = await titles(page).allTextContents();

  await more.click();
  await expect(results(page)).toHaveCount(23);
  await expect(status(page)).toHaveText("23 notes");
  await expect(more).toHaveCount(0);
  const all = await titles(page).allTextContents();
  expect(all.slice(0, 20)).toEqual(first);
  expect([...all].sort()).toEqual(Array.from({ length: 23 }, (_, i) => `Kiwi ${String(i + 1).padStart(2, "0")}`));
});

test("the arrow keys move through the results from the field, and Enter opens the selected one", async ({ page }) => {
  await searching(page, ["# Lemur one\n\nlemur\n", "# Lemur two\n\nlemur\n", "# Lemur three\n\nlemur\n"]);
  const selected = () => results(page).and(page.locator("[aria-selected=true]")).locator(".found-title");

  await field(page).fill("lemur");
  await expect(titles(page)).toHaveText(["Lemur three", "Lemur two", "Lemur one"]);
  await expect(selected()).toHaveText(["Lemur three"]);

  await page.keyboard.press("ArrowDown");
  await expect(selected()).toHaveText(["Lemur two"]);
  await page.keyboard.press("ArrowDown");
  await expect(selected()).toHaveText(["Lemur one"]);
  await page.keyboard.press("ArrowDown");
  await expect(selected()).toHaveText(["Lemur three"]);
  await page.keyboard.press("ArrowUp");
  await expect(selected()).toHaveText(["Lemur one"]);
  await page.keyboard.press("ArrowUp");
  await expect(selected()).toHaveText(["Lemur two"]);
  // The arrows are the list's: the field keeps the keyboard and what was typed.
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue("lemur");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/lemur-two-[a-z0-9]{12}$/);
  await expect(editor(page)).toContainText("Lemur two");
  await expect(editor(page)).toBeFocused();
  expect(noteIdIn(page)).toHaveLength(12);
});

test("Enter right after typing asks for what was typed, and never opens a result of the search before", async ({ page }) => {
  await searching(page, ["# Lemur\n\nlemur\n", "# Okapi\n\nokapi\n"]);
  await field(page).fill("lemur");
  await expect(titles(page)).toHaveText(["Lemur"]);

  await field(page).pressSequentially("xyz");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(/^No notes match “lemurxyz”/);
  await expect(page).toHaveURL(/\/search\?q=lemurxyz$/);
});

test("Search is reached from the left column and from the command palette, and vim's keys leave its field alone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await create(page, "# Jackal\n\njackal one\n");
  await create(page, "# Ibis\n\nibis jackal\n");
  await page.goto("/");

  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(field(page)).toBeFocused();

  await page.goto("/");
  await openAllNotes(page);
  await expect(listedNote(page, "Jackal")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Go to Search");
  await page.keyboard.press("Enter");
  await expect(field(page)).toBeFocused();

  // j, k, and ctrl+o are letters and the field's own here, and the palette still opens over the page and hands the field back.
  await field(page).pressSequentially("jackal");
  await expect(titles(page)).toHaveText(["Jackal", "Ibis"]);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/search\?q=jackal$/);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("combobox", { name: "Commands" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("ibis jackal");
});

const isSearchFor = (body: string | null, query: string) => !!body && body.includes('"type":"search"') && body.includes(`"query":"${query}"`);

test("an answer for an older search never replaces a newer one", async ({ page }) => {
  await searching(page, ["# Zebra\n\nzebra\n", "# Quokka\n\nquokka\n"]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  await page.route("**/ops", async (route) => {
    if (isSearchFor(route.request().postData(), "zebra")) {
      asked = true;
      await held;
    }
    await route.continue();
  });

  await field(page).fill("zebra");
  await expect.poll(() => asked).toBe(true);
  await expect(status(page)).toHaveText("Searching…");
  await field(page).fill("quokka");
  await expect(titles(page)).toHaveText(["Quokka"]);

  const answered = page.waitForResponse((res) => isSearchFor(res.request().postData(), "zebra"));
  release();
  await (await answered).finished();
  await page.waitForTimeout(200);
  await expect(titles(page)).toHaveText(["Quokka"]);
  await expect(status(page)).toHaveText("1 note");
});

test("a search that can't be made says so, and can be tried again", async ({ page }) => {
  await searching(page, ["# Zebra\n\nzebra\n"]);
  await page.route("**/ops", (route) => (isSearchFor(route.request().postData(), "zebra") ? route.abort() : route.continue()));

  await field(page).fill("zebra");
  const alert = searchPage(page).getByRole("alert");
  await expect(alert).toContainText("Common Ink can't be reached.");
  await expect(results(page)).toHaveCount(0);

  await page.unroute("**/ops");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(titles(page)).toHaveText(["Zebra"]);
});

test("results that may be missing notes say the server is still indexing, and the search is asked again until it isn't", async ({ page }) => {
  await searching(page, ["# Zebra\n\nzebra\n"]);
  let asks = 0;
  // The first answer is made to be one from a server that hasn't read the note yet. Every later one is the server's own.
  await page.route("**/ops", async (route) => {
    if (!isSearchFor(route.request().postData(), "zebra") || ++asks > 1) return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), results: [], indexing: true } });
  });

  await field(page).fill("zebra");
  await expect(status(page)).toHaveText("No notes match “zebra”. Archived notes are left out unless you include them. Still indexing notes. Results may be missing some.");

  await expect(titles(page)).toHaveText(["Zebra"]);
  await expect(status(page)).toHaveText("1 note");
  expect(asks).toBe(2);
  await page.waitForTimeout(2000);
  expect(asks).toBe(2);
});
