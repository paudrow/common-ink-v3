import { expect, type Locator, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson, test, toggleInspector, toggleSidebar } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const LINES = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of the note.`);
const TITLE = "Line 1 of the note.";
const group = (page: Page, n = 0) => page.getByRole("region", { name: `Editor group ${n + 1}` });
const editor = (page: Page, n = 0) => group(page, n).getByRole("textbox", { name: "Note text" });
const tabIn = (page: Page, title: string, n = 0) => group(page, n).getByRole("tab", { name: title, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** The first of `rows` not wholly above the top of what scrolls them, and how far its top is above that top. Null until a row is drawn. */
const topOf = (scroller: Locator, rows: string) =>
  scroller.evaluate((el, selector) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>(selector)].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return row
      ? {
          text: row.textContent,
          above: Math.round(top - row.getBoundingClientRect().top) + 0,
        }
      : null;
  }, rows);
type Top = Awaited<ReturnType<typeof topOf>>;

/**
 * Scrolls until the row of `rows` with `words` in it is at the top: the editor draws only the lines near what is in view, so it goes
 * near first. It is put there again a moment later, once rows still reading what they show have grown.
 */
async function scrollTo(scroller: Locator, rows: string, words: string) {
  const there = () =>
    expect
      .poll(() =>
        scroller.evaluate(
          (el, [selector, start]) => {
            const all = [...el.querySelectorAll<HTMLElement>(selector)];
            const row = all.find((r) => r.textContent?.includes(start));
            if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
            else el.scrollTop += el.clientHeight;
            return row ? Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top) + 0 : null;
          },
          [rows, words] as const,
        ),
      )
      .toBe(0);
  await there();
  await scroller.page().waitForTimeout(1000);
  await there();
  await expect.poll(() => topOf(scroller, rows)).toMatchObject({ above: 0 });
  return (await topOf(scroller, rows))!;
}

/** A list is back within a few pixels of where it was: its rows may be drawn a little taller or shorter as they read what they show. */
const nearly = (scroller: Locator, rows: string, before: Top) =>
  expect
    .poll(async () => {
      const now = await topOf(scroller, rows);
      return now && { text: now.text, near: Math.abs(now.above - before!.above) <= 4 };
    }, "the list is scrolled where it was")
    .toEqual({ text: before!.text, near: true });

const pane = (page: Page, n = 0) => group(page, n).locator(".note-scroll");
const topLine = (page: Page, n = 0) => topOf(pane(page, n), ".cm-content .cm-line");

/** Signs in, makes a short note and the long one, and opens both kept in tabs, the long one in front. */
async function longNote(page: Page, { text = LINES.join("\n"), settings = {} }: { text?: string; settings?: Record<string, unknown> } = {}) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (Object.keys(settings).length)
    await perform(page, {
      type: "settings.write",
      text: JSON.stringify(settings),
      baseRevision: 0,
    });
  const other = await perform(page, {
    type: "note.create",
    text: "# Short\n\nA short note.",
  });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${other.id}`);
  await expect(editor(page)).toContainText("A short note.");
  await runCommand(page, "Keep tab open");
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  await runCommand(page, "Keep tab open");
  await page.evaluate(() => document.fonts.ready);
  return note;
}

/** Scrolls the note in a group so line 100 is at its top, and puts the cursor at the end of line 110. */
async function partway(page: Page, n = 0, line = "Line 110 of the note.") {
  await scrollTo(pane(page, n), ".cm-content .cm-line", "Line 100 of");
  const at = editor(page, n)
    .locator(".cm-line")
    .filter({ hasText: new RegExp(`${line.replace(".", "\\.")}$`) });
  const { width, height } = (await at.boundingBox())!;
  await at.click({ position: { x: width - 2, y: height / 2 } });
  return (await topLine(page, n))!;
}

/**
 * The note is where it was, and typing goes where the cursor was. The cursor is given back to the
 * editor without scrolling, as a member clicking where they were would, and what is typed is taken out again.
 */
async function unmoved(page: Page, before: Top, n = 0, line = "Line 110 of the note.") {
  await expect.poll(() => topLine(page, n), "the note is scrolled where it was").toEqual(before);
  await editor(page, n).evaluate((el) => el.focus({ preventScroll: true }));
  await page.keyboard.type("§");
  await expect(editor(page, n).locator(".cm-line").filter({ hasText: "§" }), "the cursor is where it was").toHaveText(new RegExp(`${line.replace(".", "\\.")}§$`));
  await page.keyboard.press("Backspace");
  await expect.poll(() => topLine(page, n), "typing scrolls nothing").toEqual(before);
}

/** Splits off the short note to the right, by its tab's menu, leaving the long note in front on the left. */
async function shortToTheRight(page: Page) {
  await tabIn(page, "Short").click({ button: "right" });
  await menuItem(page, "Split right").click();
  await expect(editor(page, 1)).toContainText("A short note.");
  await expect(tabIn(page, TITLE)).toHaveAttribute("aria-selected", "true");
}

test.describe("a note scrolled partway", () => {
  test("splitting the editor right keeps it where it was, and the new half starts there too", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await runCommand(page, "Split editor right");
    await expect(editor(page, 1)).toBeVisible();
    await unmoved(page, before, 1);
    await unmoved(page, before, 0);
  });

  test("splitting the editor down keeps it where it was, and the new half starts there too", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await runCommand(page, "Split editor down");
    await expect(editor(page, 1)).toBeVisible();
    await unmoved(page, before, 1);
    await unmoved(page, before, 0);
  });

  test("splitting from the tab's menu keeps it where it was, and the new half starts there too", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await tabIn(page, TITLE).click({ button: "right" });
    await menuItem(page, "Split right").click();
    await expect(editor(page, 1)).toBeVisible();
    await unmoved(page, before, 1);
    await unmoved(page, before, 0);
  });

  test("a half split off again, after the last one was closed, starts where the note is and not where that one was", async ({ page }) => {
    await longNote(page);
    await runCommand(page, "Split editor right");
    await expect(editor(page, 1)).toBeVisible();
    await scrollTo(pane(page, 1), ".cm-content .cm-line", "Line 150 of");
    await group(page, 1).getByTitle(`Close ${TITLE}`, { exact: true }).click();
    await expect(group(page, 1)).toHaveCount(0);
    const before = await partway(page);
    await runCommand(page, "Split editor right");
    await expect(editor(page, 1)).toBeVisible();
    await unmoved(page, before, 1);
  });

  test("moving its tab to another group keeps it where it was", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await shortToTheRight(page);
    await tabIn(page, TITLE).click();
    await runCommand(page, "Move tab to next group");
    await expect(tabIn(page, TITLE, 1)).toBeVisible();
    await unmoved(page, before, 1);
  });

  test("switching to another tab and back keeps it where it was", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await tabIn(page, "Short").click();
    await expect(editor(page)).toContainText("A short note.");
    await tabIn(page, TITLE).click();
    await unmoved(page, before);
  });

  test("switching tabs in one half of a split keeps each half where it was", async ({ page }) => {
    await longNote(page);
    await runCommand(page, "Split editor right");
    await expect(editor(page, 1)).toBeVisible();
    await scrollTo(pane(page, 1), ".cm-content .cm-line", "Line 150 of");
    const right = (await topLine(page, 1))!;
    const before = await partway(page);
    await tabIn(page, "Short").click();
    await expect(editor(page)).toContainText("A short note.");
    await tabIn(page, TITLE).click();
    await unmoved(page, before);
    expect(await topLine(page, 1)).toEqual(right);
  });

  test("going to the other half of a split and back by vim's keys keeps each half where it was", async ({ page }) => {
    await longNote(page, { settings: { "vim.enabled": true } });
    await runCommand(page, "Split editor right");
    await expect(editor(page, 1)).toBeVisible();
    await scrollTo(pane(page, 1), ".cm-content .cm-line", "Line 150 of");
    const right = (await topLine(page, 1))!;
    const before = await partway(page);
    await page.keyboard.press("Control+l");
    await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
    await page.keyboard.press("Control+h");
    await expect(group(page, 0)).toHaveAttribute("data-focused", "true");
    await expect.poll(() => topLine(page, 0)).toEqual(before);
    expect(await topLine(page, 1)).toEqual(right);
    await page.keyboard.type("a§");
    await expect(editor(page).locator(".cm-line").filter({ hasText: "§" })).toHaveText("Line 110 of the note.§");
  });

  test("a dialog that gives the cursor back with a plain focus, after the browser's selection went into it, leaves it where it was", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    // As a dialog with a field does: the cursor goes into the field, and back where it was by `focus()` as the dialog closes.
    await page.evaluate(() => {
      const was = document.activeElement as HTMLElement;
      const field = document.body.appendChild(document.createElement("input"));
      field.value = "words";
      field.focus();
      field.select();
      const words = document.body.appendChild(document.createElement("p"));
      words.textContent = "Some words in the dialog.";
      getSelection()!.selectAllChildren(words);
      field.remove();
      words.remove();
      was.focus();
    });
    await expect.poll(() => topLine(page)).toEqual(before);
    await page.keyboard.type("§");
    await expect(editor(page).locator(".cm-line").filter({ hasText: "§" })).toHaveText("Line 110 of the note.§");
  });

  test("reloading keeps it where it was", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    await page.reload();
    await expect(editor(page)).toContainText("Line");
    await unmoved(page, before);
  });

  test("dragging another tab to split the group, opening a note in the new half and closing that half keep it where it was", async ({ page }) => {
    await longNote(page);
    await perform(page, { type: "note.create", text: "# Third\n\nA third note." });
    const before = await partway(page);
    const box = (await group(page).locator(".group-body").boundingBox())!;
    await tabIn(page, "Short").hover();
    await page.mouse.down();
    for (const across of [0.5, 0.95, 0.96]) await page.mouse.move(box.x + box.width * across, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(editor(page, 1)).toContainText("A short note.");
    await expect.poll(() => topLine(page)).toEqual(before);

    await editor(page, 1).click();
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("Third");
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Third");
    await page.keyboard.press("Enter");
    await expect(editor(page, 1)).toContainText("A third note.");
    await expect.poll(() => topLine(page)).toEqual(before);

    for (const title of ["Third", "Short"]) await group(page, 1).getByTitle(`Close ${title}`, { exact: true }).click();
    await expect(group(page, 1)).toHaveCount(0);
    await unmoved(page, before);
  });

  test("closing another tab, the sidebar and the inspector, resizing, focus, night shift and leaving the window keep it where it was", async ({ page }) => {
    await longNote(page, { settings: { "night-shift.enabled": true, "night-shift.on": false } });
    const before = await partway(page);
    const still = (what: string) => expect.poll(() => topLine(page), `${what} leaves it where it was`).toEqual(before);
    await page.getByTitle("Close Short", { exact: true }).click();
    await expect(tabIn(page, "Short")).toHaveCount(0);
    await still("closing another tab");
    await toggleSidebar(page);
    await toggleSidebar(page);
    await still("the sidebar");
    await toggleInspector(page);
    await toggleInspector(page);
    await still("the inspector");
    await page.getByRole("separator", { name: "Resize sidebar" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await still("resizing");
    await runCommand(page, "Toggle focus");
    await expect(page.locator(".app[data-focus-mode]")).toHaveCount(1);
    await runCommand(page, "Toggle focus");
    await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
    await still("focus");
    await runCommand(page, "Toggle night shift");
    await expect(page.locator(":root[data-night-shift]")).toHaveCount(1);
    await runCommand(page, "Toggle night shift");
    await expect(page.locator(":root[data-night-shift]")).toHaveCount(0);
    await still("night shift");
    await page.evaluate(() => {
      const shown = (state: string) => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      shown("hidden");
      window.dispatchEvent(new Event("blur"));
      shown("visible");
      window.dispatchEvent(new Event("focus"));
    });
    await unmoved(page, before);
  });

  test("the palette, quick open, the shortcuts, Settings and a plain focus back keep it where it was", async ({ page }) => {
    await longNote(page);
    const before = await partway(page);
    const typed = async () => {
      await expect.poll(() => topLine(page)).toEqual(before);
      await page.keyboard.type("§");
      await expect(editor(page).locator(".cm-line").filter({ hasText: "§" })).toHaveText("Line 110 of the note.§");
      await page.keyboard.press("Backspace");
    };
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByRole("dialog", { name: "Go to note" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await typed();
    await runCommand(page, "Keyboard shortcuts");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await typed();
    await runCommand(page, "Go to settings (UI)");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await typed();
    await page.evaluate(() => {
      const was = document.activeElement as HTMLElement;
      const button = document.body.appendChild(document.createElement("button"));
      button.focus();
      button.remove();
      was.focus();
    });
    await typed();
  });

  test("an edit arriving from elsewhere, and folding and unfolding a bullet, keep it where it was", async ({ page }) => {
    const bullets = (lines: string[]) => lines.map((l, i) => (i === 109 ? `- ${l}\n  - Under line 110.` : `- ${l}`)).join("\n");
    const note = await longNote(page, { text: bullets(LINES) });
    const before = await partway(page);
    await perform(page, { type: "note.write", id: note.id, baseRevision: note.revision, text: bullets(LINES.map((l, i) => (i === 104 ? "Line 105 changed by an agent." : l))) });
    await expect(editor(page)).toContainText("Line 105 changed by an agent.");
    await expect.poll(() => topLine(page)).toEqual(before);
    await page.keyboard.press("ControlOrMeta+Shift+.");
    await expect(editor(page)).not.toContainText("Under line 110.");
    await page.keyboard.press("ControlOrMeta+Shift+.");
    await expect(editor(page)).toContainText("Under line 110.");
    await unmoved(page, before);
  });

  test("typewriter mode on and off leaves the cursor where it was", async ({ page }) => {
    await longNote(page, { settings: { "typewriter.enabled": true, "typewriter.on": false } });
    await partway(page);
    await runCommand(page, "Toggle typewriter mode");
    await runCommand(page, "Toggle typewriter mode");
    await editor(page).evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.type("§");
    await expect(editor(page).locator(".cm-line").filter({ hasText: "§" })).toHaveText("Line 110 of the note.§");
    expect((await topLine(page))!.text).not.toBe(TITLE);
  });
});

test.describe("a list scrolled partway", () => {
  const todos = (page: Page) => page.getByRole("region", { name: "Todos" });
  const TODO_ROWS = ".todo-words";
  const chores = (count: number) => `# Chores\n\n${Array.from({ length: count }, (_, i) => `- [ ] Chore ${i + 1}`).join("\n")}`;

  async function longTodos(page: Page) {
    await signInAsNewPerson(page, "Ada Lovelace");
    const note = await perform(page, { type: "note.create", text: chores(80) });
    await perform(page, { type: "note.create", text: "# Short\n\nA short note." });
    await page.goto("/todos");
    await expect(todos(page).locator(TODO_ROWS).first()).toBeVisible();
    await runCommand(page, "Keep tab open");
    return { note, before: await scrollTo(todos(page), TODO_ROWS, "Chore 40") };
  }

  test("switching to another tab and back keeps the Todos page where it was", async ({ page }) => {
    const { before } = await longTodos(page);
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("Short");
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Short");
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("A short note.");
    await runCommand(page, "Keep tab open");
    await tabIn(page, "Todos").click();
    await nearly(todos(page), TODO_ROWS, before);
  });

  test("reloading keeps the Todos page where it was", async ({ page }) => {
    const { before } = await longTodos(page);
    await page.reload();
    await expect(todos(page).locator(TODO_ROWS).first()).toBeAttached();
    await nearly(todos(page), TODO_ROWS, before);
  });

  test("checking a todo, and a todo arriving from elsewhere, keep the Todos page where it was", async ({ page }) => {
    const { note, before } = await longTodos(page);
    const box = todos(page)
      .getByRole("listitem")
      .filter({ has: page.locator(TODO_ROWS, { hasText: /^Chore 45$/ }) })
      .getByRole("checkbox");
    await box.click();
    await expect(box).toBeChecked();
    await nearly(todos(page), TODO_ROWS, before);
    await perform(page, { type: "note.write", id: note.id, baseRevision: note.revision + 1, text: chores(81).replace("- [ ] Chore 45", "- [x] Chore 45") });
    await expect(todos(page).locator(TODO_ROWS, { hasText: /^Chore 81$/ })).toBeAttached();
    await nearly(todos(page), TODO_ROWS, before);
  });

  test("a note arriving from elsewhere, and switching to another tab and back, keep the list of notes where it was", async ({ page }) => {
    const notes = page.locator(".folder-list");
    await signInAsNewPerson(page, "Ada Lovelace");
    for (let i = 1; i <= 60; i++) await perform(page, { type: "note.create", text: `# Note ${i}\n\nAbout it.` });
    await page.goto("/");
    await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes", exact: true }).dblclick();
    await expect(notes.locator("article").first()).toBeVisible();
    const before = await scrollTo(notes, "article", "Note 50");
    await perform(page, { type: "note.create", text: "# Note 61\n\nAbout it." });
    await expect(notes.locator("article", { hasText: "Note 61" })).toBeAttached();
    // The note arrives at the head of the list, above what is in view, which stays in view a card lower.
    await nearly(notes, "article", { text: before!.text!.replaceAll("50", "51"), above: before!.above });
    await notes.getByRole("article", { name: "Note 49", exact: true }).getByRole("link", { name: "Edit" }).click();
    await expect(editor(page)).toContainText("Note 49");
    await tabIn(page, "All notes").click();
    await nearly(notes, "article", { text: before!.text!.replaceAll("50", "51"), above: before!.above });
  });
});
