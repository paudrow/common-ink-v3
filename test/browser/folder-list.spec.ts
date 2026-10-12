import { expect, test, type Page } from "@playwright/test";
import { folderRow, listedNote, listedNotes, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const heading = (page: Page) => page.getByRole("main", { name: "Editor" }).getByRole("heading", { level: 1 });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const newNote = (page: Page) => page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "New note" });

const LONG = Array.from({ length: 60 }, (_, i) => `## Part ${i + 1}\n\nParagraph ${i + 1} of a long note, with **bold** words in it.\n`).join("\n");

async function withFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const journal = await perform(page, { type: "folder.create", name: "Journal" });
  const plan = await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan\n\nWrite it **down**.\n\n- [ ] buy ink\n" });
  const monday = await perform(page, { type: "note.create", folderId: journal.id, text: "# Monday\n\nRain." });
  await page.reload();
  return { projects, journal, plan, monday };
}

test("clicking a folder shows its notes in the main area, where the second pane was, and a note opened from the list takes its place until Back", async ({ page }) => {
  const { projects, journal, monday } = await withFolders(page);
  const main = page.getByRole("main", { name: "Editor" });

  await folderRow(page, "Projects").click();
  await expect(heading(page)).toHaveText("Projects");
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(folderRow(page, "Projects")).toHaveAttribute("aria-selected", "true");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(main.getByRole("navigation", { name: "Notes" })).toBeVisible();
  // Notes are listed nowhere but in the main area: there is no pane of them between the sidebar and it.
  await expect(page.getByRole("navigation", { name: "Notes" })).toHaveCount(1);
  await expect(page.locator(".note-list")).toHaveCount(0);

  await folderRow(page, "Journal").click();
  await expect(heading(page)).toHaveText("Journal");
  await expect(page).toHaveURL(new RegExp(`/folder/${journal.id}$`));
  await page.getByRole("searchbox", { name: "Filter notes" }).fill("mon");

  await listedNote(page, "Monday").click();
  await expect(page).toHaveURL(new RegExp(`/note/monday-${monday.id}$`));
  await expect(editor(page)).toBeFocused();
  await expect(heading(page)).toHaveCount(0);
  await expect(folderRow(page, "Journal")).toHaveAttribute("aria-selected", "true");

  // Back is the way to the list, which is as it was left.
  await page.goBack();
  await expect(heading(page)).toHaveText("Journal");
  await expect(page.getByRole("searchbox", { name: "Filter notes" })).toHaveValue("mon");
  await expect(listedNotes(page)).toHaveText(["Monday"]);
});

test("a folder's list has an address that Back, Forward, a reload and a link all come to", async ({ page }) => {
  const { projects, plan } = await withFolders(page);

  await openAllNotes(page);
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(heading(page)).toHaveText("All notes");
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);
  await folderRow(page, "Projects").click();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await listedNote(page, "Plan").click();
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(heading(page)).toHaveText("Projects");
  await page.goBack();
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(heading(page)).toHaveText("All notes");
  await page.goForward();
  await expect(heading(page)).toHaveText("Projects");

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(heading(page)).toHaveText("Projects");
  await expect(listedNotes(page)).toHaveText(["Plan"]);

  await page.goto("/folder/all");
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);
  await expect(folderRow(page, "All notes")).toHaveAttribute("aria-selected", "true");
  await expect(folderRow(page, "All notes")).toHaveAccessibleDescription("2");

  // With a list in front the inspector is about the folder, and never about a note that was open before.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("definition")).toHaveText(["All notes", "2 notes", "just now by Ada Lovelace"]);
  await expect(inspector.getByRole("textbox", { name: "Note URL" })).toHaveCount(0);

  await page.goto("/folder/nosuchfolder");
  await expect(page.getByText("This folder doesn't exist, or you can't see it.")).toBeVisible();
});

test("a card expands to its note drawn to be read, which nothing in it changes, and Edit opens the note with the cursor in it", async ({ page }) => {
  const { plan } = await withFolders(page);
  await folderRow(page, "Projects").click();
  const card = noteCard(page, "Plan");
  await expect(card).toContainText("Ada Lovelace");
  await expect(card).toContainText("1 open");
  await expect(card.locator(".card-preview")).toHaveText("Write it down. buy ink");

  await card.click();
  await expect(card.getByRole("button", { name: "Collapse Plan" })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".cm-line").first()).toHaveText("# Plan");
  await expect(card.locator(".cm-line").nth(2)).toHaveText("Write it **down**.");
  await expect(card.locator(".card-preview")).toHaveCount(0);
  await expect(card.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
  await card.locator(".cm-line").nth(2).click();
  await page.keyboard.type("typed into a card");
  expect((await perform(page, { type: "note.read", id: plan.id })).text).toBe("# Plan\n\nWrite it **down**.\n\n- [ ] buy ink\n");
  await expect(card.getByRole("button", { name: "Show whole note" })).toHaveCount(0);

  await card.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(card.locator(".cm-line")).toHaveCount(0);
  await expect(card.locator(".card-preview")).toBeVisible();

  await card.getByRole("button", { name: "Expand Plan" }).click();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- [ ] and paper");
  await expect(page.getByRole("status")).toHaveText("Saved");

  // Coming back to the list finds the card as it was left, with the note as it is now.
  await page.goBack();
  await expect(card.locator(".cm-line").filter({ hasText: "and paper" })).toBeVisible();
  await expect(card).toContainText("2 open");
});

test("a card's title and its pencil open the note with the cursor in it", async ({ page }) => {
  await withFolders(page);
  await openAllNotes(page);

  await listedNote(page, "Plan").click();
  await expect(page).toHaveURL(/\/note\/plan-[a-z0-9]{12}$/);
  await expect(editor(page)).toBeFocused();

  await openAllNotes(page);
  await noteCard(page, "Monday").hover();
  await noteCard(page, "Monday").getByRole("button", { name: "Edit Monday" }).click();
  await expect(editor(page)).toBeFocused();
  await expect(page.locator(".cm-line").first()).toHaveText("# Monday");
});

test("⌘-click on a title leaves the list in front and opens the note in another tab of the browser", async ({ page }) => {
  const { plan } = await withFolders(page);
  await openAllNotes(page);

  const [other] = await Promise.all([page.context().waitForEvent("page"), listedNote(page, "Plan").click({ modifiers: ["ControlOrMeta"] })]);
  await expect(other).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(heading(page)).toHaveText("All notes");
  await expect(noteCard(page, "Plan").getByRole("button", { name: "Expand Plan" })).toHaveAttribute("aria-expanded", "false");
});

test("the arrow keys move between cards, Enter expands and collapses one, and ⌘Enter opens it", async ({ page }) => {
  await withFolders(page);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);

  await noteCard(page, "Monday").focus();
  await page.keyboard.press("ArrowDown");
  await expect(noteCard(page, "Plan")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(noteCard(page, "Plan")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(noteCard(page, "Plan").locator(".cm-line").first()).toHaveText("# Plan");
  await expect(noteCard(page, "Plan")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(noteCard(page, "Plan").locator(".cm-line")).toHaveCount(0);

  await page.keyboard.press("ArrowUp");
  await expect(noteCard(page, "Monday")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/note\/monday-[a-z0-9]{12}$/);
  await expect(editor(page)).toBeFocused();
  await expect(page.locator(".cm-line").first()).toHaveText("# Monday");
});

/** Where a card's title and details are, where the card above it is, and how far the list is scrolled. */
const placed = (page: Page, noteId: string) =>
  page.evaluate((id) => {
    const card = document.querySelector(`[data-note="${id}"]`)!;
    const box = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      title: box(card.querySelector(".card-title")!),
      details: box(card.querySelector(".card-details")!),
      cardAbove: box(card.closest("li")!.previousElementSibling!.querySelector(".card")!),
      scrolled: card.closest(".folder-list")!.scrollTop,
    };
  }, noteId);

test("a card's title and details stay where they are when it expands, shows the whole note, and collapses", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const letter of "ACDEFGHIJ") await perform(page, { type: "note.create", text: `# ${letter} note\n\nA few words about ${letter}, enough of them to fill a line and wrap onto a second one in a narrow window, and then a few more.` });
  const long = await perform(page, { type: "note.create", text: `# B long note\n\n${LONG}` });
  await page.reload();
  await openAllNotes(page);
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("Title");
  await expect(listedNotes(page).nth(1)).toHaveText("B long note");
  const card = noteCard(page, "B long note");
  const list = page.locator(".folder-list");

  for (const width of [1440, 1100, 870]) {
    for (const scrolledBy of [0, 90]) {
      await page.setViewportSize({ width, height: 900 });
      await list.evaluate((el, top) => (el.scrollTop = top), scrolledBy);
      const atRest = await placed(page, long.id);
      expect(atRest.scrolled, `${width}px`).toBe(scrolledBy);

      await card.getByRole("button", { name: "Expand B long note" }).click();
      await expect(card.locator(".cm-line").first()).toHaveText("# B long note");
      await expect(card.getByRole("button", { name: "Show whole note" })).toBeVisible();
      expect(await placed(page, long.id), `expanded at ${width}px, scrolled ${scrolledBy}`).toEqual(atRest);

      await card.getByRole("button", { name: "Show whole note" }).click();
      await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();
      expect((await card.boundingBox())!.height).toBeGreaterThan(1500);
      expect(await placed(page, long.id), `whole note at ${width}px, scrolled ${scrolledBy}`).toEqual(atRest);

      await card.getByRole("button", { name: "Collapse B long note" }).click();
      await expect(card.locator(".cm-line")).toHaveCount(0);
      expect(await placed(page, long.id), `collapsed at ${width}px, scrolled ${scrolledBy}`).toEqual(atRest);
    }
  }
});

test("showing less of a long note or collapsing it from its foot brings the card's head to the top of the list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const letter of "ACDEFGHIJ") await perform(page, { type: "note.create", text: `# ${letter} note\n\nWords about ${letter}.` });
  await perform(page, { type: "note.create", text: `# B long note\n\n${LONG}` });
  await page.reload();
  await openAllNotes(page);
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("Title");
  const card = noteCard(page, "B long note");
  const list = page.locator(".folder-list");

  await card.click();
  await card.getByRole("button", { name: "Show whole note" }).click();
  // The whole note is in the list's own scroll, with no scrolling of its own.
  await expect.poll(() => card.locator(".cm-scroller").evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
  const top = (await list.boundingBox())!.y;
  await card.getByRole("button", { name: "Show less" }).scrollIntoViewIfNeeded();
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(1500);
  expect((await card.boundingBox())!.y).toBeLessThan(0);

  await card.getByRole("button", { name: "Show less" }).click();
  await expect(card.getByRole("button", { name: "Show whole note" })).toBeVisible();
  await expect.poll(async () => (await card.boundingBox())!.y - top).toBeCloseTo(10, 0);
  await expect(card.getByRole("link", { name: "B long note" })).toBeInViewport();

  await card.getByRole("button", { name: "Show whole note" }).click();
  await card.getByRole("button", { name: "Collapse", exact: true }).scrollIntoViewIfNeeded();
  expect((await card.boundingBox())!.y).toBeLessThan(0);
  await card.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(card.locator(".cm-line")).toHaveCount(0);
  await expect.poll(async () => (await card.boundingBox())!.y - top).toBeCloseTo(10, 0);
  await expect(card.getByRole("link", { name: "B long note" })).toBeInViewport();
});

test("a new note goes in the folder whose list is in front, or the open note's folder, or Unsorted", async ({ page }) => {
  await withFolders(page);

  // With nothing in front it goes in Unsorted.
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await newNote(page).click();
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("1");
  await expect(folderRow(page, "Unsorted")).toHaveAttribute("aria-selected", "true");

  await folderRow(page, "Journal").click();
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("2");
  await expect(page.getByRole("main", { name: "Editor" }).locator(".note-meta").getByText("Journal", { exact: true })).toBeVisible();

  // With a note in front, it goes beside that note.
  await newNote(page).click();
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("3");

  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("2");
});
