import { expect, type Page } from "@playwright/test";
import { listedNote, me, noteIdIn, openAllNotes, perform, pinPanel, signInAsNewPerson, test } from "./helpers.ts";

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
/** Each result's Edit, which is the way into its note. */
const edits = (page: Page) => results(page).getByRole("link", { name: /^Edit / });
/** How many notes are listed, beside the heading, which is also where a search says it is on its way. */
const status = (page: Page) => searchPage(page).locator(".folder-count");
const nothing = (page: Page) => searchPage(page).locator(".empty");
const create = (page: Page, text: string, workspaceId?: string) => perform(page, { type: "note.create", text }, workspaceId);

/** Signs in, makes the notes in order, and opens the Search page. The workspace is asked for once, so each note is one request to a slow server, not two. */
async function searching(page: Page, texts: readonly string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = (await me(page)).workspaces[0]!.id;
  const notes = [];
  for (const text of texts) notes.push(await create(page, text, workspaceId));
  await page.goto("/search");
  await expect(field(page)).toBeFocused();
  return notes;
}

const GARDEN = "# Garden plan\n\nPlant the tomatoes by the fence.\n";
const ERRANDS = "# Errands\n\n- [ ] Call the bank about the mortgage +Home\n";
const READING = "# Reading\n\nNotes on gardening books #botany\n";
const SCRAPS = "# Scraps\n\nfence the by, tomatoes later\n";

test("the inspector is about the notes the search lists: Info counts them and History is theirs, and both follow the query", async ({ page }) => {
  await searching(page, [GARDEN, ERRANDS, READING, SCRAPS]);
  await pinPanel(page, "Info");
  const panel = page.getByRole("complementary", { name: "Inspector" });
  await expect(panel.getByRole("term")).toHaveText(["Showing", "Notes", "Last changed"]);
  await expect(panel.getByRole("definition").first()).toHaveText("Search");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("4 notes");
  await field(page).fill("fence");
  await expect(titles(page)).toHaveCount(2);
  await expect(panel.getByRole("definition").first()).toHaveText("Search: fence");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("2 notes");
  await page.getByRole("navigation", { name: "Inspector bar" }).getByRole("button", { name: "History" }).click();
  const changed = panel.getByRole("tree", { name: "Notes that changed" }).locator('[aria-level="1"]');
  await expect(changed).toHaveCount(2);
  await expect(changed.filter({ hasText: "Garden plan" })).toHaveCount(1);
  await expect(changed.filter({ hasText: "Scraps" })).toHaveCount(1);
  await field(page).fill("tomatoes in:title");
  await expect(nothing(page)).toBeVisible();
  await expect(changed).toHaveCount(0);
});

test("while a search is on its way the inspector says what it said of the last answer, never the new query with the old notes", async ({ page }) => {
  await searching(page, [GARDEN, ERRANDS, READING, SCRAPS]);
  await pinPanel(page, "Info");
  const panel = page.getByRole("complementary", { name: "Inspector" });
  await expect(panel.getByRole("definition").nth(1)).toHaveText("4 notes");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/ops", async (route) => {
    if (route.request().postData()?.includes('"type":"search"')) await held;
    await route.fallback();
  });
  await field(page).fill("fence");
  await expect(status(page)).toContainText("Searching");
  await expect(panel.getByRole("definition").first()).toHaveText("Search");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("4 notes");
  release();
  await expect(panel.getByRole("definition").first()).toHaveText("Search: fence");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("2 notes");
});

test("search finds a note by a word of its text, a todo's words, a tag, and a phrase in quotes", async ({ page }) => {
  await searching(page, [GARDEN, ERRANDS, READING, SCRAPS]);
  // With nothing typed it is every note, as the list of All notes is.
  await expect(titles(page)).toHaveText(["Scraps", "Reading", "Errands", "Garden plan"]);
  await expect(status(page)).toHaveText("4 notes");
  await expect(field(page)).toHaveAttribute("placeholder", 'Search all notes: words, "a phrase", #tag, is:archived');

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
  await expect(results(page).locator("mark")).toHaveText(["Home"]);

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
  await expect(results(page).first().locator(".card-head, .card-matches").locator("i, img, script, strong, b")).toHaveCount(0);
  // The note drawn under them is the editor's reading of it, where its HTML is characters too.
  await expect(results(page).first().locator(".card-body .cm-line").nth(2)).toContainText("<script>window.pwned = 2</script>");
  await expect(results(page).first().locator(".card-body").locator("img:not(.cm-widgetBuffer), script, i, b")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
});

test("an archived note is found only when the query asks for archived notes, and a note in Trash never; the query is the page's one control", async ({ page }) => {
  const [, archived, trashed, burrow] = await searching(page, ["# Live quokka\n\nquokka facts\n", "# Old quokka\n\nquokka history\n", "# Binned quokka\n\nquokka rubbish\n", "# Burrow\n\nwombat\n"]);
  await perform(page, { type: "note.archive", id: archived!.id, archived: true });
  await perform(page, { type: "note.archive", id: burrow!.id, archived: true });
  await perform(page, { type: "note.trash", id: trashed!.id });

  // The page has the bar and Advanced, and no Open, Archived or All, Has todos or Sort beside them.
  await expect(searchPage(page).getByRole("radio")).toHaveCount(0);
  await expect(searchPage(page).getByRole("button", { name: "Has todos" })).toHaveCount(0);
  await expect(searchPage(page).getByRole("combobox", { name: "Sort by" })).toHaveCount(0);
  await expect(searchPage(page).locator(".finder-tools")).toHaveCount(0);

  await field(page).fill("quokka");
  await expect(titles(page)).toHaveText(["Live quokka"]);
  // The results are as far under the bar as a folder's list is under its tools.
  const bar = (await searchPage(page).locator(".query-bar").boundingBox())!;
  expect(Math.round((await results(page).first().boundingBox())!.y - (bar.y + bar.height))).toBe(16);

  await field(page).fill("quokka (is:open OR is:archived)");
  await expect(titles(page)).toHaveText(["Old quokka", "Live quokka"]);
  await expect(results(page).filter({ hasText: "Old quokka" }).locator(".state-label")).toHaveText("Archived");
  await expect(results(page).filter({ hasText: "Live quokka" }).locator(".state-label")).toHaveCount(0);
  // Counted among the notes the query is of, archived ones included.
  await expect(status(page)).toHaveText("2 of 3 notes");
  await expect(page).toHaveURL(/\/search\?q=quokka\+%28is%3Aopen\+OR\+is%3Aarchived%29$/);

  await field(page).fill("quokka is:archived");
  await expect(titles(page)).toHaveText(["Old quokka"]);
  await expect(page).toHaveURL(/\/search\?q=quokka\+is%3Aarchived$/);

  await field(page).fill("wombat is:archived");
  await expect(titles(page)).toHaveText(["Burrow"]);
  await field(page).fill("wombat");
  await expect(nothing(page)).toHaveText("No notes match “wombat”. Archived notes are left out: add is:archived to search them.");
  await expect(results(page)).toHaveCount(0);

  await field(page).fill("rubbish");
  await expect(nothing(page)).toHaveText("No notes match “rubbish”. Archived notes are left out: add is:archived to search them.");
  await field(page).fill("wombat is:trashed");
  await expect(nothing(page)).toHaveText("No notes match “wombat is:trashed”.");
  await field(page).fill("rubbish (is:open OR is:archived)");
  await expect(nothing(page)).toHaveText("No notes match “rubbish (is:open OR is:archived)”.");

  // Whether a note has todos, and the order, are said in the query too, and the address keeps it.
  await field(page).fill("quokka has:todo");
  await expect(nothing(page)).toHaveText("No notes match “quokka has:todo”. Archived notes are left out: add is:archived to search them.");
  await field(page).fill("is:open sort:title-desc");
  await expect(titles(page)).toHaveText(["Live quokka"]);
  await page.reload();
  await expect(field(page)).toHaveValue("is:open sort:title-desc");
  await expect(titles(page)).toHaveText(["Live quokka"]);

  // Advanced writes each of them for a member who doesn't type them.
  await field(page).fill("quokka");
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 2).getByRole("combobox", { name: "Field" }).selectOption({ label: "State" });
  await condition(page, 2).getByRole("combobox", { name: "Value" }).selectOption("archived");
  await expect(field(page)).toHaveValue("quokka is:archived");
  await expect(titles(page)).toHaveText(["Old quokka"]);
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 3).getByRole("combobox", { name: "Field" }).selectOption({ label: "Has" });
  await condition(page, 3).getByRole("combobox", { name: "Value" }).selectOption("todo");
  await expect(field(page)).toHaveValue("quokka is:archived has:todo");
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("title-asc");
  await expect(field(page)).toHaveValue("quokka is:archived has:todo sort:title-asc");
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

  await edits(page).first().click();
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

test("a result's Edit is a link to its note: a click with the modifier opens it in a tab behind and leaves the search where it is", async ({ page }) => {
  const [garden] = await searching(page, [GARDEN]);
  await field(page).fill("tomatoes");
  await expect(titles(page)).toHaveText(["Garden plan"]);
  await expect(edits(page)).toHaveAccessibleName("Edit Garden plan");
  await expect(edits(page)).toHaveAttribute("href", `/note/garden-plan-${garden!.id}`);

  await edits(page).first().click({ modifiers: ["ControlOrMeta"] });
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

test("the down arrow goes from the field into the results, where the arrows move, ⌘Enter opens one in a tab behind and Enter opens it, and Enter in the field opens the first", async ({ page }) => {
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
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveText(["Search", "Lemur two"]);
  await expect(page).toHaveURL(/\/search\?q=lemur$/);
  await expect(focused()).toHaveText(["Lemur two"]);
  await page.keyboard.press("Enter");
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
  await expect(nothing(page)).toHaveText("No notes match “zebra”. Archived notes are left out: add is:archived to search them.");
  await expect(searchPage(page).getByText("Still indexing notes. Results may be missing some.")).toBeVisible();

  await expect(titles(page)).toHaveText(["Zebra"]);
  await expect(status(page)).toHaveText("1 of 1 note");
  await expect(searchPage(page).getByText("Still indexing notes.")).toHaveCount(0);
  expect(asks).toBe(2);
  await page.waitForTimeout(2000);
  expect(asks).toBe(2);
});

const advanced = (page: Page) => searchPage(page).getByRole("button", { name: "Advanced" });
const builder = (page: Page) => searchPage(page).getByRole("group", { name: "Advanced search" });
const condition = (page: Page, n: number) => builder(page).getByRole("group", { name: `Condition ${n}` });
const offers = (page: Page) => searchPage(page).getByRole("listbox", { name: "Completions" }).getByRole("option");
const unread = (page: Page) => searchPage(page).getByRole("status");

/** Notes in two folders, by one member, for the filters to tell apart. */
async function library(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const ink = await perform(page, { type: "folder.create", name: "Common Ink" });
  const plans = await perform(page, { type: "folder.create", name: "Plans", parentId: ink.id });
  const budget = await perform(page, { type: "note.create", folderId: ink.id, text: "# Budget\n\nThe second quarter #money\n\n- [ ] Call the bank\n" });
  const roadmap = await perform(page, { type: "note.create", folderId: plans.id, text: `# Roadmap\n\nSee [[${budget.id}]] for the budget plan.\n\n- [x] Draft it\n` });
  const recipes = await perform(page, { type: "note.create", text: "# Recipes\n\nA quarter cup of milk #food\n" });
  const old = await perform(page, { type: "note.create", text: "# Old budget\n\nLast year's.\n" });
  await perform(page, { type: "note.archive", id: old.id, archived: true });
  await page.goto("/search");
  await expect(field(page)).toBeFocused();
  return { ink, plans, budget, roadmap, recipes, old };
}

test("the search field takes filters with words, OR, NOT and groups, and each is asked of the server with the member's own day", async ({ page }) => {
  await library(page);
  const asked = async (query: string, found: string[]) => {
    await field(page).fill(query);
    await expect.poll(async () => (await titles(page).allTextContents()).sort(), { message: query }).toEqual([...found].sort());
  };
  await asked('folder:"Common Ink"', ["Budget", "Roadmap"]);
  await asked("folder:Plans OR #food", ["Recipes", "Roadmap"]);
  await asked("budget -folder:Plans", ["Budget"]);
  await asked("has:link", ["Roadmap"]);
  await asked("has:backlink", ["Budget"]);
  await asked("has:todo no:open-todo", ["Roadmap"]);
  await asked("is:archived", ["Old budget"]);
  await asked("budget (is:open OR is:archived)", ["Budget", "Old budget", "Roadmap"]);
  await asked("is:trashed", []);
  await perform(page, { type: "note.trash", id: (await perform(page, { type: "note.create", text: "# Scrapped\n\nNever mind.\n" })).id });
  await asked("is:trashed OR milk", ["Recipes", "Scrapped"]);
  await asked("editor:@me -tag:money -has:link", ["Recipes"]);
  await asked("quarter NOT milk", ["Budget"]);
  await asked("(milk OR bank) -#money", ["Recipes"]);
  await asked("budget in:title", ["Budget"]);
  // Today is the member's, said by the page: every note was made today, and none yesterday.
  await asked("created:today", ["Budget", "Recipes", "Roadmap"]);
  await asked("updated:>=yesterday has:tag", ["Budget", "Recipes"]);
  await field(page).fill("created:<today");
  await expect(nothing(page)).toContainText("No notes match");
  // The order a query asks for is the order shown, and a sort: alone is the list in that order.
  await field(page).fill("is:open sort:title-desc");
  await expect(titles(page)).toHaveText(["Roadmap", "Recipes", "Budget"]);
  await field(page).fill("sort:title-asc");
  await expect(titles(page)).toHaveText(["Budget", "Recipes", "Roadmap"]);
});

test("a filter's name and its values are offered as they are typed: Tab takes one, the arrows and Enter pick, Escape closes, and Tab is left alone when nothing is offered", async ({ page }) => {
  await library(page);
  await field(page).pressSequentially("budget fo");
  await expect(offers(page)).toHaveText([/^folder:\s*In a folder/]);
  await page.keyboard.press("Tab");
  await expect(field(page)).toHaveValue("budget folder:");
  await expect(field(page)).toBeFocused();
  // The folders the member has, by their paths. A name with a space is written in quotes.
  await expect(offers(page)).toHaveText(["Common Ink", "Common Ink / Plans", "Unsorted"]);
  await page.keyboard.press("ArrowDown");
  await expect(offers(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue('budget folder:"Common Ink" ');
  await expect(titles(page)).toHaveText(["Budget", "Roadmap"]);
  await expect(offers(page)).toHaveCount(0);

  // Typing narrows what is offered, and the words a filter takes come with what each means.
  await field(page).fill("");
  await field(page).pressSequentially("is:ar");
  await expect(offers(page)).toHaveText([/^archived\s*Archived\./]);
  await page.keyboard.press("Tab");
  await expect(field(page)).toHaveValue("is:archived ");
  await expect(titles(page)).toHaveText(["Old budget"]);
  await field(page).pressSequentially("#");
  await expect(offers(page)).toHaveText(["food", "money"]);
  await field(page).pressSequentially("mo");
  await expect(offers(page)).toHaveText(["money"]);
  await page.keyboard.press("Tab");
  await expect(field(page)).toHaveValue("is:archived #money ");
  await field(page).fill("");
  await field(page).pressSequentially("-editor:");
  await expect(offers(page)).toHaveText(["@me", "Ada Lovelace"]);
  await page.keyboard.press("Tab");
  await expect(field(page)).toHaveValue("-editor:@me ");
  await expect(nothing(page)).toContainText("No notes match");

  // Enter with nothing picked runs the query as typed, and never takes an offer.
  await field(page).fill("");
  await field(page).pressSequentially("author");
  await expect(offers(page)).toHaveText([/^author:/]);
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("author");
  // Escape closes what is offered and leaves the field as it is, and then Tab goes on to the next control.
  await field(page).fill("");
  await field(page).pressSequentially("has");
  await expect(offers(page)).toHaveText([/^has:/]);
  await page.keyboard.press("Escape");
  await expect(offers(page)).toHaveCount(0);
  await expect(field(page)).toHaveValue("has");
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(advanced(page)).toBeFocused();
  // A word that starts no filter is offered nothing, so Tab is not taken from it either.
  await field(page).fill("");
  await field(page).pressSequentially("budget");
  await expect(offers(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(advanced(page)).toBeFocused();
  await expect(field(page)).toHaveValue("budget");
});

test("a query that can't be read says where under the field and is not asked; one naming a folder nobody has is said by the server", async ({ page }) => {
  await library(page);
  const sent: string[] = [];
  page.on("request", (request) => {
    const body = request.postData();
    if (body?.includes('"type":"search"')) sent.push((JSON.parse(body) as { query: string }).query);
  });
  await field(page).fill("budget titel:x");
  await expect(unread(page)).toContainText('There is no filter "titel:"');
  await expect(unread(page).locator("mark")).toHaveText("titel:");
  await expect(unread(page).locator("code")).toHaveText("budget titel:x");
  await expect(field(page)).toHaveAttribute("aria-invalid", "true");
  // The list is the notes it was: nothing is searched for.
  await expect(titles(page)).toHaveText(["Recipes", "Roadmap", "Budget"]);
  await field(page).fill("is:opne");
  await expect(unread(page)).toContainText("Did you mean open?");
  await expect(unread(page).locator("mark")).toHaveText("opne");
  await field(page).fill("(budget OR");
  await expect(unread(page)).toContainText("OR needs a term on both sides");
  await field(page).fill("due:today");
  await expect(unread(page)).toContainText("due: is for todos");
  expect(sent).toEqual([]);

  await field(page).fill("budget -plan");
  await expect(unread(page)).toHaveCount(0);
  await expect(field(page)).not.toHaveAttribute("aria-invalid", "true");
  await expect(titles(page)).toHaveText(["Budget"]);

  await field(page).fill("folder:Nowhere budget");
  await expect(searchPage(page).getByRole("alert")).toContainText('No folder named "Nowhere"');
  await expect(results(page)).toHaveCount(0);
});

test("Advanced builds the query a row at a time, writes each change in the field, and reads back what is typed there", async ({ page }) => {
  await library(page);
  await expect(builder(page)).toHaveCount(0);
  await advanced(page).click();
  await expect(advanced(page)).toHaveAttribute("aria-expanded", "true");
  // A first condition is there to fill in, and says nothing until it is filled in.
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(1);
  await expect(condition(page, 1).getByRole("combobox", { name: "Field" })).toHaveValue("text");
  await expect(condition(page, 1).getByRole("textbox", { name: "Value" })).toHaveValue("");
  await expect(field(page)).toHaveValue("");
  await builder(page).getByRole("radio", { name: "Match any" }).check();
  await expect(field(page)).toHaveValue("");
  await builder(page).getByRole("radio", { name: "Match all" }).check();

  // From the builder to the field.
  await condition(page, 1).getByRole("textbox", { name: "Value" }).fill("budget");
  await expect(field(page)).toHaveValue("budget");
  await expect.poll(async () => (await titles(page).allTextContents()).sort()).toEqual(["Budget", "Roadmap"]);
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await expect(condition(page, 2).getByRole("combobox", { name: "Field" }).getByRole("option")).toHaveText(["Words", "Folder", "Tag", "Updated", "Created", "Editor", "Author", "Mentions", "State", "Visibility", "Has"]);
  await condition(page, 2).getByRole("combobox", { name: "Field" }).selectOption({ label: "Folder" });
  // A row with nothing chosen is no part of the query yet.
  await expect(field(page)).toHaveValue("budget");
  await condition(page, 2).getByRole("combobox", { name: "Value" }).selectOption({ label: "Common Ink / Plans" });
  await expect(field(page)).toHaveValue("budget folder:Plans");
  await expect(titles(page)).toHaveText(["Roadmap"]);
  await condition(page, 2).getByRole("combobox", { name: "Is or is not" }).selectOption("is not");
  await expect(field(page)).toHaveValue("budget -folder:Plans");
  await expect(titles(page)).toHaveText(["Budget"]);
  await builder(page).getByRole("radio", { name: "Match any" }).check();
  await expect(field(page)).toHaveValue("budget OR -folder:Plans");
  await expect.poll(async () => (await titles(page).allTextContents()).sort()).toEqual(["Budget", "Recipes", "Roadmap"]);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("title-desc");
  await expect(field(page)).toHaveValue("budget OR -folder:Plans sort:title-desc");
  await expect(titles(page)).toHaveText(["Roadmap", "Recipes", "Budget"]);
  await builder(page).getByRole("combobox", { name: "Words in" }).selectOption("title");
  await expect(field(page)).toHaveValue("budget OR -folder:Plans in:title sort:title-desc");
  await condition(page, 1).getByRole("button", { name: "Remove condition 1" }).click();
  await expect(field(page)).toHaveValue("-folder:Plans in:title sort:title-desc");
  // The address holds the query the builder wrote, so it is linked and reloaded as any search is.
  await expect(page).toHaveURL(/q=-folder%3APlans\+in%3Atitle\+sort%3Atitle-desc/);

  // From the field to the builder: every kind of row.
  await field(page).fill('"second quarter" -tag:food updated:>=7d created:2020-01-01..today no:link is:open');
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(6);
  await expect(condition(page, 1).getByRole("combobox", { name: "Field" })).toHaveValue("text");
  await expect(condition(page, 1).getByRole("textbox", { name: "Value" })).toHaveValue("second quarter");
  await expect(condition(page, 2).getByRole("combobox", { name: "Field" })).toHaveValue("tag");
  await expect(condition(page, 2).getByRole("combobox", { name: "Is or is not" })).toHaveValue("not");
  await expect(condition(page, 2).getByRole("combobox", { name: "Value" })).toHaveValue("food");
  await expect(condition(page, 3).getByRole("combobox", { name: "Comparison" })).toHaveValue(">=");
  await expect(condition(page, 3).getByRole("combobox", { name: "Value" })).toHaveValue("7d");
  await expect(condition(page, 4).getByRole("combobox", { name: "Comparison" })).toHaveValue("between");
  await expect(condition(page, 4).getByRole("combobox", { name: "Value" })).toHaveValue("2020-01-01");
  await expect(condition(page, 4).getByRole("combobox", { name: "To" })).toHaveValue("today");
  await expect(condition(page, 5).getByRole("combobox", { name: "Field" })).toHaveValue("has");
  await expect(condition(page, 5).getByRole("combobox", { name: "Is or is not" })).toHaveValue("not");
  await expect(condition(page, 5).getByRole("combobox", { name: "Value" })).toHaveValue("link");
  await expect(condition(page, 6).getByRole("combobox", { name: "Value" })).toHaveValue("open");
  await expect(builder(page).getByRole("radio", { name: "Match all" })).toBeChecked();
  await expect(titles(page)).toHaveText(["Budget"]);
  // A change in a row rewrites the field in the one way a query is written.
  await condition(page, 2).getByRole("combobox", { name: "Is or is not" }).selectOption("is");
  await expect(field(page)).toHaveValue('"second quarter" tag:food updated:>=7d created:2020-01-01..today no:link is:open');
  await expect(nothing(page)).toContainText("No notes match");

  // Escape in the panel closes it and gives the keyboard back to Advanced. The query stays.
  await condition(page, 1).getByRole("textbox", { name: "Value" }).press("Escape");
  await expect(builder(page)).toHaveCount(0);
  await expect(advanced(page)).toBeFocused();
  await expect(advanced(page)).toHaveAttribute("aria-expanded", "false");
  await expect(field(page)).toHaveValue('"second quarter" tag:food updated:>=7d created:2020-01-01..today no:link is:open');
});

test("a row's value is read as it would be typed: a tag picked in capitals narrows by it, and a value that can't be read says why beside its row", async ({ page }) => {
  await library(page);
  await create(page, "# Trips\n\nBook the train #Travel\n");
  await page.goto("/search");
  await advanced(page).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption("tag");
  const value = condition(page, 1).getByRole("combobox", { name: "Value" });
  // The list offers a tag as it is written in the notes, and picking one puts exactly that in the field.
  await expect(condition(page, 1).locator("datalist option[value='Travel']")).toHaveCount(1);
  await value.fill("Travel");
  await expect(field(page)).toHaveValue("tag:travel");
  await expect(titles(page)).toHaveText(["Trips"]);
  await expect(value).toHaveValue("Travel");
  await value.fill("#MONEY");
  await expect(field(page)).toHaveValue("tag:money");
  await expect(titles(page)).toHaveText(["Budget"]);

  await value.fill("two words");
  await expect(condition(page, 1)).toContainText("\"two words\" is not a tag's name");
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await expect(field(page)).toHaveValue("");
  await value.fill("food");
  await expect(condition(page, 1)).not.toContainText("is not a tag's name");
  await expect(field(page)).toHaveValue("tag:food");

  // A word that is an operator's is looked for as the word.
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption("text");
  await condition(page, 1).getByRole("textbox", { name: "Value" }).fill("AND");
  await expect(field(page)).toHaveValue('"AND"');
});

test("a query the builder can't show as rows stays as typed, with one line saying so, and is never rewritten", async ({ page }) => {
  await library(page);
  await advanced(page).click();
  for (const query of ["budget (milk OR bank)", "budget plan OR milk", "NOT (milk OR bank)"]) {
    await field(page).fill(query);
    await expect(builder(page)).toContainText("This query has groups, or AND and OR together, which rows can't show. It stays as it is typed");
    await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(0);
    await expect(builder(page).getByRole("button", { name: "Add a condition" })).toHaveCount(0);
    await expect(field(page)).toHaveValue(query);
  }
  await expect(titles(page)).toHaveText(["Roadmap"]);
  // One that can't be read is left alone too, and rows come back when it can be shown.
  await field(page).fill("budget titel:x");
  await expect(builder(page)).toContainText("The query in the bar can't be read yet");
  await expect(field(page)).toHaveValue("budget titel:x");
  await field(page).fill("budget -milk");
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(2);
  await expect(condition(page, 2).getByRole("combobox", { name: "Is or is not" })).toHaveValue("not");
});

const help = (page: Page) => page.getByRole("dialog", { name: "Query syntax" });
const helpButton = (page: Page) => builder(page).getByRole("button", { name: "Query syntax" });

test("the ? in Advanced opens the help over the page: every filter and operator under the builder's headings, an example tried when pressed, and Escape or Close giving the keyboard back to the ?", async ({ page }) => {
  await library(page);
  await advanced(page).click();
  await expect(help(page)).toHaveCount(0);
  await expect(helpButton(page)).toHaveAttribute("aria-haspopup", "dialog");
  await helpButton(page).click();
  await expect(help(page)).toBeVisible();
  await expect(helpButton(page)).toHaveAttribute("aria-expanded", "true");
  // Over the page and holding the keyboard, not a section of the panel that scrolls.
  expect(await help(page).evaluate((el) => el.matches(":modal"))).toBe(true);
  await expect(help(page).getByRole("button", { name: "Close" })).toBeFocused();
  const forms = await help(page).getByRole("rowheader").allTextContents();
  for (const form of ["word", '"a phrase"', "a OR b", "-a, NOT a", "( )", "key:A..B", "#NAME", "folder:NAME", "tag:NAME", "updated:DAY", "created:DAY", "editor:NAME, edited-by:NAME", "author:NAME", "is:open", "is:archived", "is:trashed", "is:shared", "is:private", "has:todo", "has:open-todo", "has:link", "has:backlink", "has:tag", "no:WORD", "in:title", "in:body", "sort:updated-desc", "sort:title-asc"]) {
    expect(forms, form).toContain(form);
  }
  // What is for todos alone is not offered where notes are searched.
  for (const form of ["due:DAY", "priority:LEVEL, importance:LEVEL", "is:done", "has:repeat", "sort:due-asc"]) expect(forms, form).not.toContain(form);
  // The headings are the builder's fields: Shared and Private are Visibility, apart from the states.
  await expect(help(page).getByRole("heading", { level: 3 })).toHaveText(["Writing a query", "Folder", "Tag", "Updated", "Created", "Editor", "Author", "Mentions", "State", "Visibility", "Has", "Words in", "Sort"]);
  await expect(help(page).getByRole("table", { name: "State" }).getByRole("rowheader")).toHaveText(["is:open", "is:archived", "is:trashed"]);
  await expect(help(page).getByRole("table", { name: "Visibility" }).getByRole("rowheader")).toHaveText(["is:shared", "is:private"]);
  await expect(help(page).getByRole("row").filter({ hasText: "is:archived" }).first()).toContainText("Archived. A query that doesn't say so leaves archived notes out");

  // Escape closes the help alone: the builder stays open, and the ? has the keyboard again.
  await page.keyboard.press("Escape");
  await expect(help(page)).toHaveCount(0);
  await expect(builder(page)).toBeVisible();
  await expect(helpButton(page)).toBeFocused();
  await expect(helpButton(page)).toHaveAttribute("aria-expanded", "false");
  await helpButton(page).click();
  await help(page).getByRole("button", { name: "Close" }).click();
  await expect(help(page)).toHaveCount(0);
  await expect(helpButton(page)).toBeFocused();
  await helpButton(page).click();
  await page.mouse.click(4, 4);
  await expect(help(page)).toHaveCount(0);
  await expect(builder(page)).toBeVisible();
  await expect(helpButton(page)).toBeFocused();

  // An example is tried when pressed: its query is put in the field and run, and the help closes on it.
  const tryExample = async (example: string) => {
    await helpButton(page).click();
    await help(page).getByRole("button", { name: example, exact: true }).click();
    await expect(help(page)).toHaveCount(0);
    await expect(field(page)).toHaveValue(example);
  };
  await tryExample("is:archived");
  await expect(titles(page)).toHaveText(["Old budget"]);
  await expect(helpButton(page)).toBeFocused();
  await tryExample("has:link");
  await expect(titles(page)).toHaveText(["Roadmap"]);
  await tryExample("(budget OR plan) -draft");
  // Roadmap has a todo to draft it, which the example's -draft leaves out.
  await expect(titles(page)).toHaveText(["Budget"]);
  // Every example reads: none leaves the field saying it can't be read.
  await helpButton(page).click();
  const examples = await help(page).locator(".query-example").allTextContents();
  await page.keyboard.press("Escape");
  expect(examples.length).toBeGreaterThan(30);
  for (const example of examples) {
    await tryExample(example);
    await expect(field(page)).not.toHaveAttribute("aria-invalid", "true");
  }
});

test("the bar, the builder and the help fit a window 380 wide, and nothing in them runs off its side", async ({ page }) => {
  await library(page);
  await page.setViewportSize({ width: 380, height: 800 });
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  await field(page).fill('budget folder:"Common Ink" updated:2020-01-01..today');
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Query syntax" }).click();
  await expect(help(page)).toBeVisible();
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(3);
  const over = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".query-bar, .query-bar *")].filter((el) => el.getClientRects().length && (el.getBoundingClientRect().right > innerWidth + 0.5 || el.getBoundingClientRect().left < -0.5)).map((el) => `${el.tagName}.${el.className}`));
  expect(over).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The help is in the window, and its own words scroll inside it.
  const box = (await help(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
});
