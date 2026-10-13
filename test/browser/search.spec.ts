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
const field = (page: Page) => searchPage(page).getByRole("searchbox", { name: "Search notes" });
/** A result is a card, as in a folder's list: the Search page is that list, of every note. */
const results = (page: Page) => searchPage(page).getByRole("navigation", { name: "Notes" }).getByRole("article");
const titles = (page: Page) => results(page).locator(".card-title");
/** How many notes are listed, beside the heading, which is also where a search says it is on its way. */
const status = (page: Page) => searchPage(page).locator(".folder-count");
const nothing = (page: Page) => searchPage(page).locator(".empty");
const show = (page: Page, which: "Open" | "Archived" | "All") => searchPage(page).getByRole("radio", { name: which, exact: true });
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
  // With nothing typed it is every note, as the list of All notes is.
  await expect(titles(page)).toHaveText(["Scraps", "Reading", "Errands", "Garden plan"]);
  await expect(status(page)).toHaveText("4 notes");
  await expect(field(page)).toHaveAttribute("placeholder", 'Search all notes: words, "a phrase", #tag, +project');

  await field(page).fill("tomat");
  await expect(titles(page)).toHaveText(["Scraps", "Garden plan"]);
  await expect(status(page)).toHaveText("2 of 4 notes");
  await expect(results(page).filter({ hasText: "Garden plan" }).locator(".found-line")).toHaveText("Plant the tomatoes by the fence.");
  await expect(results(page).filter({ hasText: "Garden plan" }).locator("mark")).toHaveText(["tomat"]);
  await expect(results(page).filter({ hasText: "Garden plan" }).locator(".card-details")).toContainText("Unsorted");

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
  await expect(titles(page)).toHaveText(["Scraps", "Reading", "Errands", "Garden plan"]);
  await expect(results(page).locator("mark")).toHaveCount(0);
  await expect(status(page)).toHaveText("4 notes");
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

  // The only elements in a result's matched lines are the ones the page makes, and nothing anywhere in the card came out of the note's text.
  await expect.poll(() => results(page).first().locator(".card-matches").evaluate((el) => [...el.querySelectorAll("*")].map((child) => child.tagName.toLowerCase()).sort())).toEqual(["mark", "mark", "span"]);
  await expect(results(page).first().locator("i, img, script, strong, b")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
});

test("an archived note is found only when Archived or All is chosen, and a note in Trash never", async ({ page }) => {
  const [, archived, trashed, burrow] = await searching(page, ["# Live quokka\n\nquokka facts\n", "# Old quokka\n\nquokka history\n", "# Binned quokka\n\nquokka rubbish\n", "# Burrow\n\nwombat\n"]);
  await perform(page, { type: "note.archive", id: archived!.id, archived: true });
  await perform(page, { type: "note.archive", id: burrow!.id, archived: true });
  await perform(page, { type: "note.trash", id: trashed!.id });

  await field(page).fill("quokka");
  await expect(titles(page)).toHaveText(["Live quokka"]);
  await expect(show(page, "Open")).toBeChecked();

  await show(page, "All").check();
  await expect(titles(page)).toHaveText(["Old quokka", "Live quokka"]);
  await expect(results(page).filter({ hasText: "Old quokka" }).locator(".card-details")).toContainText("Archived");
  await expect(results(page).filter({ hasText: "Live quokka" }).locator(".card-details")).not.toContainText("Archived");
  await expect(page).toHaveURL(/\/search\?q=quokka&archived=1$/);

  await show(page, "Archived").check();
  await expect(titles(page)).toHaveText(["Old quokka"]);
  await expect(page).toHaveURL(/\/search\?q=quokka&archived=only$/);

  await field(page).fill("wombat");
  await expect(titles(page)).toHaveText(["Burrow"]);
  await show(page, "Open").check();
  await expect(nothing(page)).toHaveText("No notes match “wombat”. Archived notes are left out: choose All to search them too.");
  await expect(results(page)).toHaveCount(0);

  await field(page).fill("rubbish");
  await expect(nothing(page)).toHaveText("No notes match “rubbish”. Archived notes are left out: choose All to search them too.");
  await show(page, "All").check();
  await expect(nothing(page)).toHaveText("No notes match “rubbish”.");
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

  await titles(page).first().click();
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

test("a result's title is a link to its note: a click with the modifier opens it in a tab behind and leaves the search where it is", async ({ page }) => {
  const [garden] = await searching(page, [GARDEN]);
  await field(page).fill("tomatoes");
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(titles(page)).toHaveAttribute("href", `/note/garden-plan-${garden!.id}`);

  await titles(page).first().click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/search\?q=tomatoes$/);
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveText(["Search", "Garden plan"]);
  await openAllNotes(page);
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveText(["All notes", "Garden plan"]);
});

test("More results appends the next page until there are no more", async ({ page }) => {
  await searching(page, Array.from({ length: 23 }, (_, i) => `# Kiwi ${String(i + 1).padStart(2, "0")}\n\nkiwi number ${i + 1}\n`));
  const more = searchPage(page).getByRole("button", { name: "More results" });

  await field(page).fill("kiwi");
  await expect(results(page)).toHaveCount(20);
  await expect(status(page)).toHaveText("20+ of 23 notes");
  const first = await titles(page).allTextContents();

  await more.click();
  await expect(results(page)).toHaveCount(23);
  await expect(status(page)).toHaveText("23 of 23 notes");
  await expect(more).toHaveCount(0);
  const all = await titles(page).allTextContents();
  expect(all.slice(0, 20)).toEqual(first);
  expect([...all].sort()).toEqual(Array.from({ length: 23 }, (_, i) => `Kiwi ${String(i + 1).padStart(2, "0")}`));
});

test("the down arrow goes from the field into the results, where the arrows move and ⌘Enter opens, and Enter in the field opens the first", async ({ page }) => {
  await searching(page, ["# Lemur one\n\nlemur\n", "# Lemur two\n\nlemur\n", "# Lemur three\n\nlemur\n"]);
  const focused = () => results(page).and(page.locator(":focus")).locator(".card-title");

  await field(page).fill("lemur");
  // The same three notes are listed before the search is answered, so it is the count that says it was.
  await expect(status(page)).toHaveText("3 of 3 notes");
  await expect(titles(page)).toHaveText(["Lemur three", "Lemur two", "Lemur one"]);

  await page.keyboard.press("ArrowDown");
  await expect(focused()).toHaveText(["Lemur three"]);
  await page.keyboard.press("ArrowDown");
  await expect(focused()).toHaveText(["Lemur two"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(focused()).toHaveText(["Lemur one"]);
  await page.keyboard.press("ArrowUp");
  await expect(focused()).toHaveText(["Lemur two"]);
  await expect(field(page)).toHaveValue("lemur");

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/note\/lemur-two-[a-z0-9]{12}$/);
  await expect(editor(page)).toContainText("Lemur two");
  await expect(editor(page)).toBeFocused();
  expect(noteIdIn(page)).toHaveLength(12);

  await page.goBack();
  await expect(field(page)).toBeFocused();
  await expect(status(page)).toHaveText("3 of 3 notes");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/lemur-three-[a-z0-9]{12}$/);
  await expect(editor(page)).toBeFocused();
});

test("Enter right after typing asks for what was typed, and never opens a result of the search before", async ({ page }) => {
  await searching(page, ["# Lemur\n\nlemur\n", "# Okapi\n\nokapi\n"]);
  await field(page).fill("lemur");
  await expect(titles(page)).toHaveText(["Lemur"]);

  await field(page).pressSequentially("xyz");
  await page.keyboard.press("Enter");
  await expect(nothing(page)).toHaveText(/^No notes match “lemurxyz”/);
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
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+Enter");
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
  await expect(status(page)).toHaveText("1 of 2 notes");
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
  await expect(nothing(page)).toHaveText("No notes match “zebra”. Archived notes are left out: choose All to search them too.");
  await expect(searchPage(page).getByText("Still indexing notes. Results may be missing some.")).toBeVisible();

  await expect(titles(page)).toHaveText(["Zebra"]);
  await expect(status(page)).toHaveText("1 of 1 note");
  await expect(searchPage(page).getByText("Still indexing notes.")).toHaveCount(0);
  expect(asks).toBe(2);
  await page.waitForTimeout(2000);
  expect(asks).toBe(2);
});
