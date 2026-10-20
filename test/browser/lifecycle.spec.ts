import { expect, type Page } from "@playwright/test";
import { anotherPerson, asViewerOfNote, join, listedNotes, me, noteCard, openAllNotes, ownPlugin, perform, pinPanel, showPanel, signInAsNewPerson, test } from "./helpers.ts";

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lines = (page: Page) => editor(page).locator(".cm-line");
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: title, exact: true });
/** Brings the list of every note to the front, from a note or a page, and checks the titles in it. */
const listShows = async (page: Page, titles: string[]) => {
  await openAllNotes(page);
  await expect(page.getByRole("main", { name: "Editor" }).getByRole("heading", { level: 1 })).toHaveText("All notes");
  await expect(listedNotes(page)).toHaveText(titles);
};
/** The quiet line under an open note's title, and the bottom bar, which says whether it is saved. */
const bar = (page: Page) => page.locator(".note-marks");
const saveBar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
const banner = (page: Page) => page.getByRole("group", { name: "In Trash" });
const notice = (page: Page) => page.getByRole("group", { name: "Notice" });
const trashRows = (page: Page) => page.getByRole("list", { name: "Notes in Trash" }).getByRole("listitem");
const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });

const create = (page: Page, text: string, folderId?: string) => perform(page, { type: "note.create", text, folderId });
const stateOf = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).state;
const openNote = async (page: Page, note: { id: string }) => {
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();
};
const openInfo = (page: Page) => pinPanel(page, "Info");
/** The app lists everything again when its window takes focus, so a test needn't wait for it to ask what changed. */
const lookAgain = (page: Page) => page.evaluate(() => void window.dispatchEvent(new Event("focus")));
const UNSAVED_IN_TRASH = "Your last changes aren't saved: this note is in Trash. Restore it to save them.";
/** Longer than the app waits between asking what changed (`REFRESH_MS`), and shorter than it waits between whole listings. */
const WITHIN_A_RELIST = { timeout: 12_000 };

/** Holds back each save of what is typed on `page`, as a slow network does, until `release`. `waiting` settles once a save is held. */
async function holdingSaves(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked!: () => void;
  const waiting = new Promise<void>((resolve) => (asked = resolve));
  await page.route("**/ops", async (route) => {
    if (route.request().postData()?.includes('"type":"note.write"')) {
      asked();
      await held;
    }
    await route.continue();
  });
  return { waiting, release };
}

/** Everything the note's save state says on `page` from now on, read back with the function returned. */
async function saveStatesSaid(page: Page) {
  await saveBar(page)
    .getByRole("status")
    .evaluate((el) => {
      const said: string[] = ((window as unknown as { __said: string[] }).__said = [el.textContent ?? ""]);
      new MutationObserver(() => said.push(el.textContent ?? "")).observe(el, { childList: true, characterData: true, subtree: true });
    });
  return () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);
}

test("archive is one action on the open note, which stays editable and says it is archived without moving its text", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Old plan\n\nkept");
  await openNote(page, note);
  await openInfo(page);
  const top = async () => (await lines(page).first().boundingBox())!.y;
  const before = await top();

  await inspector(page).getByRole("button", { name: "Archive", exact: true }).click();

  await expect(bar(page)).toContainText("Archived");
  await expect.poll(() => stateOf(page, note.id)).toBe("archived");
  await expect.poll(() => top()).toBe(before);
  // Kept, so its tab is still there once a list is opened: a list from the tree takes a preview's place.
  await tab(page, "Old plan").dblclick();
  await listShows(page, []);
  await tab(page, "Old plan").click();

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and changed");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Old plan\n\nkept and changed");

  await bar(page).getByRole("button", { name: "Unarchive" }).click();
  await expect(bar(page)).not.toContainText("Archived");
  await expect.poll(() => stateOf(page, note.id)).toBe("live");
  await expect.poll(() => top()).toBe(before);
  await expect(inspector(page).getByRole("button", { name: "Archive", exact: true })).toBeEnabled();
  await listShows(page, ["Old plan"]);
});

test("the archive command and its key archive the open note and bring it back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Keyed");
  await openNote(page, note);
  // The editor reads its note by itself; the commands know the open note once the workspace's notes are listed, which its tab waits for.
  await expect(tab(page, "Keyed")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect.poll(() => stateOf(page, note.id)).toBe("archived");
  await expect(bar(page)).toContainText("Archived");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Archive or unarchive");
  await page.keyboard.press("Enter");
  await expect.poll(() => stateOf(page, note.id)).toBe("live");
});

test("a viewer sees archive and move to Trash disabled", async ({ page }) => {
  const { note } = await asViewerOfNote(page, "# Theirs");
  await openNote(page, note);
  await openInfo(page);

  await expect(inspector(page).getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
  await expect(inspector(page).getByRole("button", { name: "Move to Trash" })).toBeDisabled();
});

test("an archived note leaves the note list and Todos, and comes back when archived notes are shown", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const kept = await create(page, "# Kept\n\n- [ ] water plants");
  const old = await create(page, "# Old\n\n- [ ] file taxes");
  await page.goto("/");
  await listShows(page, ["Old", "Kept"]);

  await noteCard(page, "Old").locator(".card-head").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive" }).click();

  await expect(listedNotes(page)).toHaveText(["Kept"]);
  await expect.poll(() => stateOf(page, old.id)).toBe("archived");

  await page.getByRole("searchbox", { name: "Search notes" }).fill("(is:open OR is:archived)");
  await expect(listedNotes(page)).toHaveText(["Old", "Kept"]);
  await expect(noteCard(page, "Old").locator(".state-label")).toHaveText("Archived");
  await expect(noteCard(page, "Kept").locator(".state-label")).toHaveCount(0);

  await page.goto("/todos");
  await expect(todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem")).toHaveCount(1);
  await expect(todosPage(page)).toContainText("water plants");
  await expect(todosPage(page)).not.toContainText("file taxes");

  // The Todos page lists the todos of archived notes when its query names them.
  await todosPage(page).getByRole("searchbox", { name: "Filter todos" }).fill("is:archived");
  await expect(todosPage(page)).toContainText("file taxes");
  expect(kept.state).toBe("live");
});

test("a link to an archived note opens it, and the backlink from an archived note says so", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const old = await create(page, "# Old plan");
  const diary = await create(page, `# Diary\n\nSee [[${old.id}]] for more.`);
  await perform(page, { type: "note.archive", id: old.id, archived: true });
  await openNote(page, diary);

  await expect(lines(page).last()).toHaveText("See Old plan for more.");
  await editor(page).getByRole("link").click();

  await expect(page).toHaveURL(new RegExp(`${old.id}$`));
  await expect(bar(page)).toContainText("Archived");
  await expect(lines(page).first()).toHaveText("# Old plan");

  await perform(page, { type: "note.archive", id: old.id, archived: false });
  await perform(page, { type: "note.archive", id: diary.id, archived: true });
  await lookAgain(page);
  await showPanel(page, "Backlinks");
  await expect(ownPlugin(page, "Backlinks").getByRole("navigation", { name: "Backlinks" }).getByRole("link")).toContainText(["Archived"]);
});

test("a note moved to Trash leaves the list at once, and Undo brings it back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Scrap\n\nnot needed");
  await openNote(page, note);
  await openInfo(page);
  // Kept, so its tab is still there once a list is opened: a list from the tree takes a preview's place.
  await tab(page, "Scrap").dblclick();
  await listShows(page, ["Scrap"]);
  await tab(page, "Scrap").click();

  await inspector(page).getByRole("button", { name: "Move to Trash" }).click();

  await expect(notice(page)).toContainText("Moved to Trash");
  await expect(banner(page)).toBeVisible();
  await listShows(page, []);
  await tab(page, "Scrap").click();
  await expect(banner(page)).toBeVisible();
  await expect.poll(() => stateOf(page, note.id)).toBe("trashed");

  await notice(page).getByRole("button", { name: "Undo" }).click();

  await expect(banner(page)).toHaveCount(0);
  await expect.poll(() => stateOf(page, note.id)).toBe("live");
  await expect(notice(page)).toContainText("Restored from Trash.");
  await notice(page).locator(".toast-text").click();
  await expect(notice(page)).toHaveCount(0);
  await listShows(page, ["Scrap"]);
});

test("a tab's menu and the command move its note to Trash", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const first = await create(page, "# First");
  const second = await create(page, "# Second");
  await openNote(page, first);

  await page.getByRole("tab", { name: "First" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect.poll(() => stateOf(page, first.id)).toBe("trashed");

  await openNote(page, second);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Move note to Trash");
  await page.keyboard.press("Enter");
  await expect.poll(() => stateOf(page, second.id)).toBe("trashed");
  await listShows(page, []);
});

test("the Trash page says who trashed a note and how long it has, and restores it to its folder", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Projects" });
  const note = await create(page, "# Roadmap\n\nsteps", folder.id);
  await page.goto("/");
  await listShows(page, ["Roadmap"]);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Trash" }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.getByRole("region", { name: "Trash" })).toContainText("Trash is empty.");
  await expect(page.getByRole("region", { name: "Trash" })).toContainText("waits here for 30 days");

  await perform(page, { type: "note.trash", id: note.id });
  await lookAgain(page);

  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page)).toContainText("Roadmap");
  await expect(trashRows(page)).toContainText("Returns to Projects");
  await expect(trashRows(page)).toContainText("Trashed by Ada Lovelace just now");
  await expect(trashRows(page)).toContainText("30 days left");
  await listShows(page, []);
  await page.goBack();
  await expect(page).toHaveURL(/\/trash$/);

  await trashRows(page).getByRole("button", { name: "Restore" }).click();

  await expect(notice(page)).toContainText("Roadmap: Restored from Trash.");
  await expect(trashRows(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Trash" })).toContainText("Trash is empty.");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).folderId).toBe(folder.id);
  await listShows(page, ["Roadmap"]);
});

test("a note restored after its folder was deleted comes back to Unsorted, and the member is told", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Temporary" });
  const note = await create(page, "# Orphan", folder.id);
  await perform(page, { type: "note.trash", id: note.id });
  await perform(page, { type: "folder.delete", id: folder.id });
  await page.goto("/trash");

  await trashRows(page).getByRole("button", { name: "Restore" }).click();

  await expect(notice(page)).toContainText("Orphan: Restored to Unsorted, because its folder was deleted.");
  await expect.poll(() => stateOf(page, note.id)).toBe("live");
});

test("what an Undo answers is said in the card's place, and goes by itself once nothing is on it; pressed by the keys, the keyboard stays on it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Scrap\n\nnot needed");
  await openNote(page, note);
  await openInfo(page);
  await inspector(page).getByRole("button", { name: "Move to Trash" }).click();
  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(notice(page)).toHaveText("Restored from Trash.");
  await page.mouse.move(5, 5);
  // Five seconds for a card with nothing to press, with the pointer and the keyboard elsewhere.
  await expect(notice(page)).toHaveCount(0, { timeout: 9000 });

  await inspector(page).getByRole("button", { name: "Move to Trash" }).click();
  await notice(page).getByRole("button", { name: "Undo" }).press("Enter");
  await expect(notice(page)).toHaveText("Restored from Trash.");
  await expect(notice(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toHaveCount(0);
});

test("three notices with long titles still fit a small window, each cut to its card", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 560 });
  await signInAsNewPerson(page, "Ada Lovelace");
  const long = (n: number) => `${n} ${"averylongwordwithnoroomtobreak".repeat(2)} ${"and many more words after it ".repeat(6)}`.trim();
  for (const n of [1, 2, 3]) await perform(page, { type: "note.trash", id: (await create(page, `# ${long(n)}`)).id });
  await page.clock.install();
  await page.goto("/trash");
  await expect(trashRows(page)).toHaveCount(3);
  // Time stands still, so the cards wait for a slow server: each goes after five seconds otherwise.
  await page.clock.pauseAt(Date.now() + 60_000);
  for (const n of [1, 2, 3]) {
    const row = trashRows(page).filter({ hasText: `${n} averylong` });
    await row.getByRole("button", { name: "Restore" }).press("Enter");
    await expect(row).toHaveCount(0);
    await expect(notice(page)).toHaveCount(n);
  }
  for (const card of await notice(page).all()) {
    const box = (await card.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(420);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

for (const width of [1280, 420]) {
  test(`every notice is one card at the foot of the pane, centred under it: they stack, the newest at the foot, three at most, and none covers another, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signInAsNewPerson(page, "Ada Lovelace");
    const titles = ["First", "Second", "Third", "Fourth"];
    for (const title of titles) await perform(page, { type: "note.trash", id: (await create(page, `# ${title}`)).id });
    await page.goto("/trash");
    await expect(trashRows(page)).toHaveCount(4);

    for (const [i, title] of titles.slice(0, 3).entries()) {
      // By the keyboard: at 420px the cards lie over the foot of the list, where a pointer would press them.
      await trashRows(page).filter({ hasText: title }).getByRole("button", { name: "Restore" }).press("Enter");
      await expect(notice(page)).toHaveCount(i + 1);
    }
    await expect(notice(page)).toHaveText(["First: Restored from Trash.", "Second: Restored from Trash.", "Third: Restored from Trash."]);
    // A notice from any plugin is the same card: the todos' "Task completed" is drawn as these are.
    await expect(notice(page).first()).toHaveClass("toast-card");

    const boxes = async () => Promise.all((await notice(page).all()).map(async (card) => (await card.boundingBox())!));
    const laidOut = async () => {
      const shown = await boxes();
      // Centred under the pane in front, or as near it as keeps the stack 8px inside the window.
      const pane = (await page.locator(".group[data-front]").boundingBox())!;
      const stack = (await page.locator(".toasts").boundingBox())!;
      const centre = Math.min(Math.max(pane.x + pane.width / 2, stack.width / 2 + 8), width - stack.width / 2 - 8);
      expect(Math.abs(stack.x + stack.width / 2 - centre)).toBeLessThanOrEqual(1);
      for (const box of shown) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
      }
      // Each below the one before, with a gap: none covers another.
      for (let i = 1; i < shown.length; i++) expect(shown[i]!.y).toBeGreaterThanOrEqual(shown[i - 1]!.y + shown[i - 1]!.height + 4);
      return shown;
    };
    await laidOut();

    // A fourth sends the oldest away.
    await trashRows(page).filter({ hasText: "Fourth" }).getByRole("button", { name: "Restore" }).press("Enter");
    await expect(notice(page)).toHaveText(["Second: Restored from Trash.", "Third: Restored from Trash.", "Fourth: Restored from Trash."]);
    await laidOut();
  });
}

test("an open note that someone else moves to Trash turns read-only, with a banner that moves the text by its own height and no more", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Shared plan\n\nsteady");
  await openNote(page, note);
  await expect(lines(page).first()).toHaveText("# Shared plan");
  const top = async () => (await lines(page).first().boundingBox())!.y;
  const before = await top();

  await perform(page, { type: "note.trash", id: note.id });
  await lookAgain(page);

  await expect(banner(page)).toContainText("This note is in Trash");
  await expect(banner(page)).toContainText("It is removed for good in 30 days.");
  await expect.poll(async () => (await top()) - before).toBe((await banner(page).boundingBox())!.height);
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await editor(page).click();
  await page.keyboard.type("more");
  await expect(lines(page)).toHaveText(["# Shared plan", "", "steady"]);

  await banner(page).getByRole("button", { name: "Restore" }).click();

  await expect(banner(page)).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await expect.poll(() => top()).toBe(before);
  await expect.poll(() => stateOf(page, note.id)).toBe("live");
});

test("typing in a note that turns out to be in Trash is kept and said to be unsaved, and is saved when the note is restored", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Draft\n\nfirst");
  await openNote(page, note);
  await expect(lines(page).first()).toHaveText("# Draft");
  const saves = await holdingSaves(page);

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and second");
  await saves.waiting;
  await perform(page, { type: "note.trash", id: note.id });
  saves.release();

  await expect(banner(page)).toBeVisible();
  await expect(saveBar(page).getByRole("status")).toHaveText(UNSAVED_IN_TRASH);
  await expect(lines(page).last()).toHaveText("first and second");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Draft\n\nfirst");

  await banner(page).getByRole("button", { name: "Restore" }).click();

  await expect(saveBar(page).getByRole("status")).toHaveText("Saved");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Draft\n\nfirst and second");
});

test("a note someone else archives, trashes, and restores shows each state in a browser that is only left open", async ({ page }) => {
  // Five changes, each seen only when the next relist comes round.
  test.slow();
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const note = await create(page, "# Shared plan\n\nsteady");
  await page.goto("/");
  await openAllNotes(page);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("(is:open OR is:archived)");
  await expect(noteCard(page, "Shared plan")).toBeVisible();
  await expect(noteCard(page, "Shared plan")).not.toContainText("Archived");

  await perform(grace, { type: "note.archive", id: note.id, archived: true }, workspaceId);
  await expect(noteCard(page, "Shared plan")).toContainText("Archived", WITHIN_A_RELIST);

  await perform(grace, { type: "note.archive", id: note.id, archived: false }, workspaceId);
  await expect(noteCard(page, "Shared plan")).not.toContainText("Archived", WITHIN_A_RELIST);
  await perform(grace, { type: "note.archive", id: note.id, archived: true }, workspaceId);
  await expect(noteCard(page, "Shared plan")).toContainText("Archived", WITHIN_A_RELIST);

  await perform(grace, { type: "note.trash", id: note.id }, workspaceId);
  await expect(listedNotes(page)).toHaveCount(0, WITHIN_A_RELIST);

  await perform(grace, { type: "note.restore", id: note.id }, workspaceId);
  await expect(noteCard(page, "Shared plan")).toContainText("Archived", WITHIN_A_RELIST);
});

test("a save refused because someone else moved the note to Trash says so at once, keeps the typing, and saves it when the note is restored", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const note = await create(page, "# Draft\n\nfirst");
  await openNote(page, note);
  await expect(lines(page).first()).toHaveText("# Draft");
  const said = await saveStatesSaid(page);
  const saves = await holdingSaves(page);

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and second");
  await saves.waiting;
  await perform(grace, { type: "note.trash", id: note.id }, workspaceId);
  saves.release();

  await expect(saveBar(page).getByRole("status")).toHaveText(UNSAVED_IN_TRASH);
  await expect(banner(page)).toContainText("This note is in Trash");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(lines(page).last()).toHaveText("first and second");
  await expect.poll(async () => (await said()).filter((text) => text.includes("Couldn't save"))).toEqual([]);

  await banner(page).getByRole("button", { name: "Restore" }).click();

  await expect(saveBar(page).getByRole("status")).toHaveText("Saved");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Draft\n\nfirst and second");
  await expect.poll(async () => (await said()).filter((text) => text.includes("Couldn't save"))).toEqual([]);
});

test("delete forever asks first and names the note, and then a link to it reads as gone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const doomed = await create(page, "# Doomed");
  const diary = await create(page, `# Diary\n\nSee [[${doomed.id}]] here.`);
  await perform(page, { type: "note.trash", id: doomed.id });
  await openNote(page, diary);

  await expect(lines(page).last()).toHaveText("See Doomed (in Trash) here.");
  const drawn = (await lines(page).last().boundingBox())!;
  await lines(page).last().click();
  await page.keyboard.press("Home");
  const written = (await lines(page).last().boundingBox())!;
  expect([written.x, written.height]).toEqual([drawn.x, drawn.height]);
  await lines(page).first().click();

  await editor(page).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`${doomed.id}$`));
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole("button", { name: "Delete forever" }).click();
  const ask = page.getByRole("group", { name: "Delete Doomed forever" });
  await expect(ask).toContainText("Delete “Doomed” forever? The note and its history are removed now, and can't be brought back.");
  await expect.poll(() => stateOf(page, doomed.id)).toBe("trashed");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => stateOf(page, doomed.id)).toBe("trashed");

  await banner(page).getByRole("button", { name: "Delete forever" }).click();
  await ask.getByRole("button", { name: "Delete forever" }).click();

  await expect(page.getByText("This note doesn't exist, or you can't see it.")).toBeVisible();
  await expect.poll(() => perform(page, { type: "note.read", id: doomed.id }).then(() => "there", () => "gone")).toBe("gone");

  await openNote(page, diary);
  await expect(lines(page).last()).toHaveText("See Unavailable note here.");
});

test("an editor who didn't make a note is told plainly that they can't delete it forever", async ({ page }) => {
  await signInAsNewPerson(page, "Edith Editor");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const note = await perform(admin, { type: "note.create", text: "# Hers" });
  await perform(admin, { type: "note.trash", id: note.id });
  await expect.poll(async () => (await me(page)).workspaces.some((w) => w.id === workspaceId)).toBe(true);
  await page.goto(`/note/${note.id}`);
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole("button", { name: "Delete forever" }).click();
  await page.getByRole("group", { name: "Delete Hers forever" }).getByRole("button", { name: "Delete forever" }).click();

  await expect(banner(page).getByRole("alert")).toHaveText("Only an admin or the member who made a note can delete it for good");
  await expect.poll(async () => (await perform(admin, { type: "trash.list" })).notes.map((n) => n.id)).toEqual([note.id]);
});

test("quick open leaves out archived and trashed notes, and finds archived ones when they are included", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await create(page, "# Plan live");
  const archived = await create(page, "# Plan archived");
  const trashed = await create(page, "# Plan trashed");
  await perform(page, { type: "note.archive", id: archived.id, archived: true });
  await perform(page, { type: "note.trash", id: trashed.id });
  await page.goto("/");
  await listShows(page, ["Plan live"]);

  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await palette.getByRole("combobox").fill("plan");
  await expect(palette.getByRole("option")).toHaveText([/^Plan live/]);

  await palette.getByRole("button", { name: "Include archived" }).click();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await expect(palette.getByRole("option")).toHaveText([/^Plan archivedArchived/, /^Plan live/]);

  await palette.getByRole("option", { name: /Plan archived/ }).click();
  await expect(page).toHaveURL(new RegExp(`${archived.id}$`));
  await expect(bar(page)).toContainText("Archived");
});

test("the Info tab lists the open note's tags as they are typed, each a link to its page", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await create(page, "# Tagged\n\n#work and #Home\n\n```\n#notatag\n```");
  await openNote(page, note);
  await openInfo(page);
  const tags = inspector(page).getByRole("list", { name: "Tags" }).getByRole("link");
  await expect(tags).toHaveText(["#work", "#Home"]);

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" #new");
  await expect(tags).toHaveText(["#new", "#work", "#Home"]);

  await tags.first().click();
  await expect(page).toHaveURL(/\/tags\/new$/);
});
