import { expect, test, type Locator, type Page } from "@playwright/test";
import { folderRow, listedNote, listedNotes, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const tabs = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group).getByRole("tab");
const tab = (page: Page, title: string) => tabs(page).filter({ hasText: new RegExp(`^${title}$`) });
const italic = (page: Page) => tabs(page).evaluateAll((els) => els.map((el) => getComputedStyle(el).fontStyle === "italic"));
const heading = (page: Page) => page.getByRole("main", { name: "Editor" }).getByRole("heading", { level: 1 });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

/** Runs a command from the palette. */
async function run(page: Page, command: string) {
  const palette = page.getByRole("dialog", { name: "Commands" });
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type(command);
  await expect(palette.getByRole("option").first()).toHaveText(command);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

/** What a line shows: its text without the marks that are there but not painted. */
const shown = (line: Locator) =>
  line.evaluate((el) => {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let painted = true;
      for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) if (getComputedStyle(up).opacity === "0") painted = false;
      if (painted) text += node.textContent;
    }
    return text;
  });

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

test("a group has one italic preview tab: a folder's is kept when a note is opened from it, and the next thing opened takes the preview's place", async ({ page }) => {
  const { projects, journal } = await withFolders(page);
  /** The tabs in order, which may never show more than one in italics. */
  const shows = async (titles: string[], previewAt: number) => {
    await expect(tabs(page)).toHaveText(titles);
    const slanted = await italic(page);
    expect(slanted.filter(Boolean).length, `italic tabs among ${titles.join(", ")}`).toBeLessThanOrEqual(1);
    expect(slanted.indexOf(true)).toBe(previewAt);
  };

  await folderRow(page, "Projects").click();
  await shows(["Projects"], 0);
  await expect(tab(page, "Projects")).toHaveAttribute("data-kind", "folder");
  await expect(tab(page, "Projects").locator("svg").first()).toBeVisible();
  await expect(heading(page)).toHaveText("Projects");
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(folderRow(page, "Projects")).toHaveAttribute("aria-selected", "true");
  await expect(listedNotes(page)).toHaveText(["Plan"]);

  // Another folder from the tree takes the preview's place.
  await folderRow(page, "Journal").click();
  await shows(["Journal"], 0);
  await expect(page).toHaveURL(new RegExp(`/folder/${journal.id}$`));

  // A note opened from the list: the list's tab stays, kept, and the note is the preview.
  await listedNote(page, "Monday").click();
  await shows(["Journal", "Monday"], 1);
  await expect(folderRow(page, "Journal")).toHaveAttribute("aria-selected", "true");

  // A folder from the tree takes the note's place.
  await folderRow(page, "Projects").click();
  await shows(["Journal", "Projects"], 1);
  await listedNote(page, "Plan").click();
  await shows(["Journal", "Projects", "Plan"], 2);
  await expect(folderRow(page, "Projects")).toHaveAttribute("aria-selected", "true");

  // Notes looked through from a list replace one another beside it.
  await tab(page, "Journal").click();
  await listedNote(page, "Monday").click();
  await shows(["Journal", "Projects", "Monday"], 2);

  // A double click keeps what it opens, and All notes from the tree then has the preview.
  await tab(page, "Monday").dblclick();
  await shows(["Journal", "Projects", "Monday"], -1);
  await openAllNotes(page);
  await shows(["Journal", "Projects", "Monday", "All notes"], 3);

  // A note opened behind is a kept tab, and the preview is as it was.
  await listedNote(page, "Plan").click({ modifiers: ["ControlOrMeta"] });
  await shows(["Journal", "Projects", "Monday", "All notes", "Plan"], 3);
});

test("a folder's tab has an address that Back, Forward, a reload and a link all come to", async ({ page }) => {
  const { projects, plan } = await withFolders(page);

  await openAllNotes(page);
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(heading(page)).toHaveText("All notes");
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);
  await folderRow(page, "Projects").dblclick();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await listedNote(page, "Plan").click();
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(tab(page, "Projects")).toHaveAttribute("aria-selected", "true");
  await expect(heading(page)).toHaveText("Projects");
  await page.goBack();
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(heading(page)).toHaveText("All notes");
  await page.goForward();
  await expect(heading(page)).toHaveText("Projects");

  await page.reload();
  // The note's preview gave way to All notes when Back came to it.
  await expect(tabs(page)).toHaveText(["Projects", "All notes"]);
  expect(await italic(page)).toEqual([false, true]);
  await expect(tab(page, "Projects")).toHaveAttribute("aria-selected", "true");
  await expect(heading(page)).toHaveText("Projects");

  // At `/` the app shows the tabs it has, with the one that was in front.
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(heading(page)).toHaveText("Projects");

  await page.goto("/folder/all");
  await expect(tab(page, "All notes")).toHaveAttribute("aria-selected", "true");
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);
  await expect(folderRow(page, "All notes")).toHaveAttribute("aria-selected", "true");

  // A list opened with no note before it has no note for the inspector to be about.
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);

  await page.goto("/folder/nosuchfolder");
  await expect(page.getByText("This folder doesn't exist, or you can't see it.")).toBeVisible();
});

test("a folder's tab splits and moves between groups like a note's", async ({ page }) => {
  await withFolders(page);
  const group = (n: number) => page.getByRole("region", { name: `Editor group ${n}` });
  await folderRow(page, "Projects").dblclick();
  await listedNote(page, "Plan").click();
  await expect(tabs(page)).toHaveText(["Projects", "Plan"]);

  const { width } = (await group(1).boundingBox())!;
  await tab(page, "Projects").dragTo(group(1), { targetPosition: { x: width * 0.2, y: 200 } });
  await expect(tabs(page, 0)).toHaveText(["Projects"]);
  await expect(tabs(page, 1)).toHaveText(["Plan"]);
  await expect(group(1).getByRole("heading", { level: 1 })).toHaveText("Projects");
  await expect(group(2).locator(".cm-line").first()).toHaveText("# Plan");
  await expect(folderRow(page, "Projects")).toHaveAccessibleDescription("1");

  // With the list in front the inspector stays, about the note that was in front before, so nothing moves under the pointer.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const listBox = await group(1).boundingBox();
  await group(1).getByRole("searchbox", { name: "Search notes" }).click();
  await expect(page).toHaveURL(/\/folder\/[a-z0-9]{12}$/);
  await expect(inspector.getByRole("textbox", { name: "Note URL" })).toHaveValue(/\/note\/plan-[a-z0-9]{12}$/);
  expect(await group(1).boundingBox()).toEqual(listBox);

  // The list stays beside the note: a title clicked in it shows its note in the group that already has it.
  await group(1).getByRole("link", { name: "Plan" }).click();
  await expect(tabs(page, 0)).toHaveText(["Projects"]);
  await expect(editor(page)).toBeFocused();

  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["Projects"]);
  await expect(tabs(page, 1)).toHaveText(["Plan"]);

  await page.getByRole("tablist", { name: "Open notes" }).nth(0).getByRole("tab").dragTo(page.getByRole("tablist", { name: "Open notes" }).nth(1));
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await expect(tabs(page)).toHaveText(["Plan", "Projects"]);
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
  await expect.poll(() => shown(card.locator(".cm-line").first())).toBe("Plan");
  await expect.poll(() => shown(card.locator(".cm-line").nth(2))).toBe("Write it down.");
  await expect(card.locator(".card-preview")).toHaveCount(0);
  await expect(card.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
  const box = card.getByRole("checkbox");
  await expect(box).toBeDisabled();
  await box.click({ force: true });
  await card.locator(".cm-line").nth(2).click();
  await page.keyboard.type("typed into a card");
  expect((await perform(page, { type: "note.read", id: plan.id })).text).toBe("# Plan\n\nWrite it **down**.\n\n- [ ] buy ink\n");
  await expect(card.getByRole("button", { name: "Show whole note" })).toHaveCount(0);

  await card.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(card.locator(".cm-line")).toHaveCount(0);
  await expect(card.locator(".card-preview")).toBeVisible();

  await card.getByRole("button", { name: "Expand Plan" }).click();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(tabs(page)).toHaveText(["Projects", "Plan"]);
  expect(await italic(page)).toEqual([true, false]);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- [ ] and paper");
  await expect(page.getByRole("status")).toHaveText("Saved");

  // Coming back to the list finds the card as it was left, with the note as it is now.
  await tab(page, "Projects").click();
  await expect(card.locator(".cm-line").filter({ hasText: "and paper" })).toBeVisible();
  await expect(card).toContainText("2 open");
});

test("a card expanded beside its note's editor is only a reading of it: what follows the editor still does", async ({ page }) => {
  await withFolders(page);
  const group = (n: number) => page.getByRole("region", { name: `Editor group ${n}` });
  const words = page.getByRole("group", { name: "Bottom bar" });
  await folderRow(page, "Projects").dblclick();
  await listedNote(page, "Plan").click();
  await tab(page, "Projects").dragTo(group(1), { targetPosition: { x: 40, y: 300 } });
  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(words).toContainText("6 words");

  const card = group(1).getByRole("article", { name: "Plan" });
  await card.getByRole("button", { name: "Expand Plan" }).click();
  await expect(card.locator(".cm-line").first()).toHaveText("# Plan");
  await card.getByRole("button", { name: "Collapse Plan" }).click();
  await expect(card.locator(".cm-line")).toHaveCount(0);

  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(words).toContainText("6 words");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("two more");
  await expect(words).toContainText("8 words");
});

test("a card's title and its pencil open the note with the cursor in it, the title as a preview", async ({ page }) => {
  await withFolders(page);
  await openAllNotes(page);

  await listedNote(page, "Plan").click();
  await expect(tabs(page)).toHaveText(["All notes", "Plan"]);
  expect(await italic(page)).toEqual([false, true]);
  await expect(editor(page)).toBeFocused();

  await openAllNotes(page);
  await noteCard(page, "Monday").hover();
  await noteCard(page, "Monday").getByRole("button", { name: "Edit Monday" }).click();
  await expect(tabs(page)).toHaveText(["All notes", "Plan", "Monday"]);
  expect(await italic(page)).toEqual([false, true, false]);
  await expect(editor(page)).toBeFocused();
  await expect(page.locator(".cm-line").first()).toHaveText("# Monday");
});

test("⌘-click or a middle click on a title or a collapsed card opens the note in a tab behind the list", async ({ page }) => {
  await withFolders(page);
  await openAllNotes(page);

  await listedNote(page, "Plan").click({ modifiers: ["ControlOrMeta"] });
  await expect(tabs(page)).toHaveText(["All notes", "Plan"]);
  expect(await italic(page)).toEqual([true, false]);
  await expect(tab(page, "All notes")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All notes");

  await noteCard(page, "Monday").click({ button: "middle", position: { x: 300, y: 60 } });
  await expect(tabs(page)).toHaveText(["All notes", "Plan", "Monday"]);
  await expect(tab(page, "All notes")).toHaveAttribute("aria-selected", "true");
  await expect(noteCard(page, "Monday").getByRole("button", { name: "Expand Monday" })).toHaveAttribute("aria-expanded", "false");

  await listedNote(page, "Monday").click({ button: "middle" });
  await noteCard(page, "Plan").click({ modifiers: ["ControlOrMeta"], position: { x: 300, y: 60 } });
  await expect(tabs(page)).toHaveText(["All notes", "Plan", "Monday"]);
  await expect(page).toHaveURL(/\/folder\/all$/);

  await tab(page, "Plan").click();
  await expect(page.locator(".cm-line").first()).toHaveText("# Plan");
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
  await expect(tabs(page)).toHaveText(["All notes", "Monday"]);
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
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const atRest = await placed(page, long.id);
      expect(atRest.scrolled, `${width}px`).toBe(scrolledBy);

      // The pointer over the card, and then the keyboard on it, bring up what can be done with it. Nothing else of the card moves.
      const archive = card.getByRole("button", { name: "Archive B long note", exact: true });
      expect(await archive.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
      await card.hover({ position: { x: 300, y: 60 } });
      await expect.poll(() => archive.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect(await placed(page, long.id), `hovered at ${width}px, scrolled ${scrolledBy}`).toEqual(atRest);
      await page.mouse.move(2, 2);
      await card.focus();
      await expect.poll(() => archive.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect(await placed(page, long.id), `focused at ${width}px, scrolled ${scrolledBy}`).toEqual(atRest);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

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

  // With nothing in front, as at the Dashboard, it goes in Unsorted.
  await expect(page.getByRole("region", { name: "Dashboard", exact: true })).toBeVisible();
  await run(page, "New note");
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("1");
  await expect(folderRow(page, "Unsorted")).toHaveAttribute("aria-selected", "true");

  await folderRow(page, "Journal").click();
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("2");
  await expect(page.getByRole("main", { name: "Editor" }).locator(".note-meta").getByText("Journal", { exact: true })).toBeVisible();

  // With a note in front, it goes beside that note.
  await run(page, "New note");
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("3");

  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("2");
});

test("with the note list off a folder's notes are listed by title, and with tabs off a folder is shown at its address", async ({ page }) => {
  const { projects, plan } = await withFolders(page);

  await expect(folderRow(page, "Projects")).toBeVisible();
  await run(page, "Disable plugin: Note list");
  await folderRow(page, "Projects").click();
  await expect(tabs(page)).toHaveText(["Projects"]);
  const plain = page.getByRole("region", { name: "Projects" });
  await expect(plain.getByRole("link")).toHaveText(["Plan"]);
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveCount(0);
  await plain.getByRole("link", { name: "Plan" }).click();
  await expect(tabs(page)).toHaveText(["Projects", "Plan"]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Plan");
  await run(page, "Enable plugin: Note list");

  await run(page, "Disable plugin: Tabs and splits");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await folderRow(page, "Projects").click();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(heading(page)).toHaveText("Projects");
  await listedNote(page, "Plan").click();
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));
  await expect(page.locator(".cm-line").first()).toHaveText("# Plan");
  await page.goBack();
  await expect(heading(page)).toHaveText("Projects");

  // With no sidebar there is no tree to click, and the command still leads to every note.
  await run(page, "Disable plugin: Sidebar");
  await expect(page.getByRole("tree")).toHaveCount(0);
  await run(page, "Open All notes");
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(listedNotes(page)).toHaveText(["Monday", "Plan"]);
});
