import { expect, type Locator, type Page } from "@playwright/test";
import { asViewerOfNote, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const lines = (page: Page) => page.locator(".cm-line");
const line = (page: Page, text: string | RegExp) => lines(page).filter({ hasText: text }).first();
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const authors = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => `${c.author.kind} ${c.author.name}`);
const cell = (page: Page, row: number, column: number, group = 0) => editor(page, group).locator(`[data-focus="${row},${column}"]`);
/** What a line shows: its text without the marks that are there but not painted. */
const shownIn = (el: Element) => {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let painted = true;
    for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.opacity === "0" || style.visibility === "hidden" || style.webkitTextFillColor === "rgba(0, 0, 0, 0)") painted = false;
    }
    if (painted) text += node.textContent;
  }
  return text;
};
const expectShown = (line: Locator, text: string | RegExp, message?: string) => (typeof text === "string" ? expect.poll(() => line.evaluate(shownIn), message).toBe(text) : expect.poll(() => line.evaluate(shownIn), message).toMatch(text));
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await page.keyboard.press("Enter");
};

/** Signs in and opens a note with this text, with the cursor at its very start, on the title. */
async function open(page: Page, text: string, settings?: Record<string, unknown>) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (settings) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  return note;
}

/** Puts the cursor at the end of the first line that says `text`, by a click past its end. */
async function clickLine(page: Page, text: string | RegExp) {
  const box = (await line(page, text).boundingBox())!;
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

/** Folds the bullet on the first line in `within` that says `text` with the key, the cursor at that line's end. */
async function fold(page: Page, text: string | RegExp, within = editor(page)) {
  const at = within.locator(".cm-line").filter({ hasText: text }).first();
  const box = (await at.boundingBox())!;
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await expect(at).toContainText("…");
}

const TABLE = "# Stock\n\n| Name  | Qty |\n| ----- | --: |\n| Pens  | 12  |\n| Paper | 500 |\n\nAfter.";
const OUTLINE = "# Trip\n\n- pack\n  - socks\n  - maps\n- book\n  - train\n- go\n\nAfter.";
const MAC = process.platform === "darwin";
/** The chords that move a bullet in and out: Option+→ and Option+← on a Mac, and with Shift elsewhere, where Alt+← and Alt+→ go back and forward. */
const [RIGHT, LEFT] = MAC ? ["Alt+ArrowRight", "Alt+ArrowLeft"] : ["Alt+Shift+ArrowRight", "Alt+Shift+ArrowLeft"];

test("markdown is drawn where it is written, only what the cursor is on shows its marks, and the note's text is never changed by it", async ({ page }) => {
  const text = "# Title\n\nSome **bold**, *italic*, ~~struck~~, `code` and a [link](https://example.com/a).\n\n## Section ##\n\n> quoted\n\n---\n\nPlain <b>html</b> <img src=x onerror=\"document.title='pwned'\"> stays.\n";
  const note = await open(page, text);

  await expectShown(lines(page).nth(0), "# Title");
  await expectShown(lines(page).nth(2), "Some bold, italic, struck, code and a link.");
  await expectShown(lines(page).nth(4), "Section");
  await expectShown(lines(page).nth(6), /^\s*quoted$/);
  await expect(lines(page).nth(8)).toHaveClass(/md-rule/);
  await expectShown(lines(page).nth(8), "");
  // HTML in a note is text: nothing it names is made, and nothing it carries runs.
  await expect(lines(page).nth(10)).toHaveText("Plain <b>html</b> <img src=x onerror=\"document.title='pwned'\"> stays.");
  await expect(editor(page).locator("img:not(.cm-widgetBuffer), b")).toHaveCount(0);
  await expect.poll(() => page.title()).not.toBe("pwned");

  // The cursor at the end of the line is on none of them: the line stays drawn. On a word, that word alone shows its marks.
  await clickLine(page, "Some bold");
  await expectShown(lines(page).nth(2), "Some bold, italic, struck, code and a link.");
  await expectShown(lines(page).nth(0), "Title");
  for (const [word, written] of [
    ["bold", "Some **bold**, italic, struck, code and a link."],
    ["italic", "Some bold, *italic*, struck, code and a link."],
    ["struck", "Some bold, italic, ~~struck~~, code and a link."],
    ["code", "Some bold, italic, struck, `code` and a link."],
  ] as const) {
    await lines(page).nth(2).getByText(word, { exact: true }).click();
    await expectShown(lines(page).nth(2), written, `with the cursor on "${word}"`);
  }
  // A click on a drawn link opens it, so the cursor comes to this one by the keys: back from the end of the line, to the link's edge.
  await keys(page, "End", "ArrowLeft");
  await expectShown(lines(page).nth(2), "Some bold, italic, struck, code and a [link](https://example.com/a).");
  // A heading's marks go by its line.
  await clickLine(page, "Section");
  await expectShown(lines(page).nth(4), "## Section ##");
  await expectShown(lines(page).nth(2), "Some bold, italic, struck, code and a link.");
  // A quote's mark shows with the cursor on the mark, and not from its words.
  await clickLine(page, "quoted");
  await expectShown(lines(page).nth(6), /^\s*quoted$/);
  await page.keyboard.press("Home");
  await expectShown(lines(page).nth(6), "> quoted");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectShown(lines(page).nth(8), "---");
  await expect(lines(page).nth(8)).not.toHaveClass(/md-rule/);

  await page.keyboard.type("-");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("---", "----"));
});

test("a link in a table cell shows it can be clicked and opens its page, a bare address too, and the rest of the cell is still typed in", async ({ page }) => {
  await open(page, "# Shop\n\n| Item | Where |\n| --- | --- |\n| Press | [Harbor Freight](https://example.com/press) |\n| Brake | https://example.org/brake |\n\nAfter.");
  await page.evaluate(() => {
    (window as unknown as { opened: unknown[][] }).opened = [];
    window.open = (...args: unknown[]) => ((window as unknown as { opened: unknown[][] }).opened.push(args), null);
  });
  const links = editor(page).locator(".md-table .md-link");
  await expect(links).toHaveText(["Harbor Freight", "https://example.org/brake"]);
  for (const link of await links.all()) expect(await link.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  await expect(links.first()).toHaveAttribute("title", "https://example.com/press\nClick to open");

  await links.first().click();
  await links.last().click();
  expect(await page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened)).toEqual([
    ["https://example.com/press", "_blank", "noopener,noreferrer"],
    ["https://example.org/brake", "_blank", "noopener,noreferrer"],
  ]);
  await expect(editor(page).locator(".md-cell-typing")).toHaveCount(0);

  // The cell's own words are typed in, shown as written.
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toBeFocused();
  await cell(page, 1, 1).focus();
  await expect(cell(page, 1, 1)).toHaveText("[Harbor Freight](https://example.com/press)");
});

test("a drawn link opens in a new tab on a click, only for a web or mail address, and on a link the cursor is on a plain click is for the cursor and ⌘ or Ctrl-click opens it", async ({ page }) => {
  await open(page, "# Links\n\nSee [the docs](https://example.com/docs) or [this](javascript:alert(1)) or https://example.org/bare today.\n");
  await page.evaluate(() => {
    (window as unknown as { opened: unknown[][] }).opened = [];
    window.open = (...args: unknown[]) => ((window as unknown as { opened: unknown[][] }).opened.push(args), null);
  });
  const opened = () => page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened);

  // Drawn, with the cursor on another line: a plain click follows the link, and the cursor stays where it was.
  await expect(editor(page).locator(".md-link").first()).toHaveAttribute("title", "https://example.com/docs\nClick to open");
  await editor(page).getByText("the docs").click();
  await editor(page).getByText("https://example.org/bare").click({ modifiers: ["ControlOrMeta"] });
  expect(await opened()).toEqual([
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
    ["https://example.org/bare", "_blank", "noopener,noreferrer"],
  ]);
  await expectShown(lines(page).nth(2), "See the docs or this or https://example.org/bare today.");

  // A link to anything else is never opened: the click is a click in the text, which shows that link as written and no other.
  await editor(page).getByText("this", { exact: true }).click();
  await expect(lines(page).nth(2)).toContainText("[this](javascript:alert(1))");
  await expect(lines(page).nth(2)).not.toContainText("](https://example.com/docs)");
  await expect.poll(async () => (await opened()).length).toBe(2);

  // With the cursor elsewhere on the same line, a plain click on a drawn link still opens it.
  await editor(page).getByText("the docs").click();
  await expect.poll(async () => (await opened())[2]).toEqual(["https://example.com/docs", "_blank", "noopener,noreferrer"]);

  // On a link the cursor is on, a plain click is for the cursor, and ⌘ or Ctrl-click opens the link.
  await keys(page, "Home", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
  await expect(lines(page).nth(2)).toContainText("[the docs](https://example.com/docs)");
  await expect(editor(page).locator(".md-link").first()).toHaveAttribute("title", /-click to open$/);
  await editor(page).getByText("the docs").click();
  await page.keyboard.type("!");
  await expect(lines(page).nth(2)).toContainText("](https://example.com/docs)");
  await expect(lines(page).nth(2)).toContainText("!");
  await expect.poll(async () => (await opened()).length).toBe(3);
  await editor(page).locator(".md-link").first().click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(async () => (await opened())[3]).toEqual(["https://example.com/docs", "_blank", "noopener,noreferrer"]);
});

test("a task's checkbox writes [x] and [ ] into the note as the member's change, and is undone like typing", async ({ page }) => {
  const note = await open(page, "# Chores\n\n- [ ] sweep\n- [x] mop\n1. [ ] numbered\n\n```\n- [ ] in code\n```\n");

  await expect(editor(page).getByRole("checkbox")).toHaveCount(3);
  await expect(editor(page).getByRole("checkbox", { name: "Not done" })).toHaveCount(2);
  await line(page, "sweep").getByRole("checkbox").click();
  await expect.poll(() => read(page, note.id)).toContain("- [x] sweep\n- [x] mop");
  await expect(line(page, "sweep").getByRole("checkbox", { name: "Done" })).toBeChecked();
  await line(page, "mop").getByRole("checkbox").click();
  await expect.poll(() => read(page, note.id)).toContain("- [x] sweep\n- [ ] mop");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toContain("- [x] sweep\n- [x] mop");
  await expect(line(page, "mop").getByRole("checkbox")).toBeChecked();

  // With the cursor on its line the box stays drawn, and is still clicked. On the box itself, the note shows what it writes.
  await clickLine(page, "numbered");
  await expect(editor(page).getByRole("checkbox")).toHaveCount(3);
  await line(page, "numbered").getByRole("checkbox").click();
  await expect.poll(() => read(page, note.id)).toContain("1. [x] numbered");
  await keys(page, "Home", "ArrowRight", "ArrowRight", "ArrowRight");
  await expectShown(line(page, "numbered"), "1. [x] numbered");
  await expect(editor(page).getByRole("checkbox")).toHaveCount(2);
  await keys(page, "End");
  await expect(editor(page).getByRole("checkbox")).toHaveCount(3);
});

test("a table is drawn as a table, and typing in a cell rewrites the markdown as the member's change", async ({ page }) => {
  const note = await open(page, TABLE);
  const table = editor(page).getByRole("table");

  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Qty"]);
  await expect(table.getByRole("cell")).toHaveText(["Pens", "12", "Paper", "500"]);
  await expect(cell(page, 1, 1)).toHaveCSS("text-align", "right");
  await expect(editor(page)).not.toContainText("-----");

  await cell(page, 1, 1).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("144");
  await page.keyboard.press("Tab");
  await expect(cell(page, 2, 0)).toBeFocused();
  await expect.poll(() => read(page, note.id)).toBe(TABLE.replace("| 12  |", "| 144 |"));
  await page.keyboard.type("Paper | A4");
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# Stock\n\n| Name        | Qty |\n| ----------- | --: |\n| Pens        | 144 |\n| Paper \\| A4 | 500 |\n|             |     |\n\nAfter.");
  await expect(cell(page, 3, 0)).toBeFocused();
  await expect(cell(page, 2, 0)).toHaveText("Paper | A4");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // Escape leaves a cell as the note has it.
  await page.keyboard.type("never kept");
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await expect(cell(page, 3, 0)).toHaveText("");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).not.toContain("|             |     |");
  await expect(table.getByRole("row")).toHaveCount(3);
});

test("rows and columns are inserted and deleted from a cell's menu, by the pointer and by the keys, one plus on the bottom edge and one on the right add at the end, and a cell draws its markdown until it is typed in", async ({ page }) => {
  const note = await open(page, "# Stock\n\n| Name | Qty |\n| ---- | --- |\n| **Pens** | 12 |\n\nAfter.");
  const table = editor(page).getByRole("table");
  const menu = page.getByRole("menu", { name: "Table" });
  const item = (name: string) => menu.getByRole("menuitem", { name, exact: true });
  const written = (rows: string) => `# Stock\n\n${rows}\n\nAfter.`;

  await expect(cell(page, 1, 0).locator("strong")).toHaveText("Pens");
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toHaveText("**Pens**");
  // The table has two buttons and no more: the plus on each edge.
  await expect(editor(page).locator(".md-table").getByRole("button")).toHaveText(["+", "+"]);

  // A right-click on a cell lists what can be done from it.
  await cell(page, 1, 0).click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Insert row above", "Insert row below", "Insert column left", "Insert column right", "Delete row", "Delete column"]);
  await item("Insert column right").click();
  await expect(menu).toHaveCount(0);
  await expect(cell(page, 1, 1)).toBeFocused();
  await page.keyboard.type("blue");

  // From the keys: Shift+F10 opens the cell's menu, the arrows move in it, and Enter picks. What was being typed is kept.
  await page.keyboard.press("Shift+F10");
  await expect(item("Insert row above")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Insert row below")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cell(page, 2, 1)).toBeFocused();
  await page.keyboard.type("Ink");
  await editor(page).focus();
  await expect.poll(() => read(page, note.id)).toBe(written("| Name     |      | Qty |\n| -------- | ---- | --- |\n| **Pens** | blue | 12  |\n|          | Ink  |     |"));
  await expect(table.getByRole("row")).toHaveCount(3);

  // The menu key opens it too, Escape closes it with nothing done and the cell has the keyboard again, and End goes to the last item.
  await cell(page, 1, 1).click();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(cell(page, 1, 1)).toBeFocused();
  await keys(page, "Shift+F10", "End");
  await expect(item("Delete column")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe(written("| Name     | Qty |\n| -------- | --- |\n| **Pens** | 12  |\n|          |     |"));
  await cell(page, 2, 0).click({ button: "right" });
  await item("Delete row").click();
  await expect.poll(() => read(page, note.id)).toBe(written("| Name     | Qty |\n| -------- | --- |\n| **Pens** | 12  |"));
  // The cursor is in the row that has come to where the deleted one was, which shows what it writes.
  await expect(cell(page, 1, 0)).toBeFocused();
  await expect(table.getByRole("cell")).toHaveText(["**Pens**", "12"]);

  // Nothing goes above the header and the header can't be deleted: the menu says so, and a row goes below it.
  await cell(page, 0, 0).click({ button: "right" });
  await expect(item("Insert row above")).toBeDisabled();
  await expect(item("Delete row")).toBeDisabled();
  await expect(item("Insert row below")).toBeFocused();
  await item("Insert row below").click();
  await expect(cell(page, 1, 0)).toBeFocused();

  // The plus on the bottom edge adds a row at the end, and the plus on the right edge a column at the end.
  await editor(page).getByRole("button", { name: "Add a row at the end" }).click();
  await expect(cell(page, 3, 0)).toBeFocused();
  await page.keyboard.type("Last");
  await editor(page).getByRole("button", { name: "Add a column at the end" }).click();
  await expect(cell(page, 0, 2)).toBeFocused();
  await page.keyboard.type("New");
  await editor(page).focus();
  await expect.poll(() => read(page, note.id)).toBe(written("| Name     | Qty | New |\n| -------- | --- | --- |\n|          |     |     |\n| **Pens** | 12  |     |\n| Last     |     |     |"));

  // From the palette, the same commands act on the cell last typed in.
  await run(page, "Table: delete column");
  await expect.poll(() => read(page, note.id)).toBe(written("| Name     | Qty |\n| -------- | --- |\n|          |     |\n| **Pens** | 12  |\n| Last     |     |"));
  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Qty"]);

  // Undo right after an action, from the empty cell it left the cursor in, puts the table back and writes nothing over the cell that returns to that place.
  const before = await read(page, note.id);
  await cell(page, 0, 0).click({ button: "right" });
  await item("Insert column left").click();
  await expect(cell(page, 0, 0)).toBeFocused();
  await expect(table.getByRole("columnheader")).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.getByRole("columnheader")).toHaveCount(2);
  await clickLine(page, "After.");
  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Qty"]);
  await expect.poll(() => read(page, note.id)).toBe(before);

  // The keyboard taken by the palette closes an open menu.
  await cell(page, 1, 0).click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a table's lines are shown only by the keys: not by selecting the whole note that ends with it, and not by a press in the margin beside it", async ({ page }) => {
  const text = "# Ends\n\nAbove.\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const note = await open(page, text);
  const source = editor(page).locator(".cm-line.md-table-source");
  await expect(editor(page).getByRole("table")).toBeVisible();

  await clickLine(page, "Above.");
  await page.keyboard.press("ControlOrMeta+a");
  await expect(editor(page).getByRole("table")).toBeVisible();
  await expect(source).toHaveCount(0);

  // A press left of the table, level with its middle: the cursor does not go into lines that are out of sight, and what is typed is not typed into them.
  await clickLine(page, "Above.");
  const box = (await editor(page).getByRole("table").boundingBox())!;
  await page.mouse.click(box.x - 20, box.y + box.height / 2);
  await expect(source).toHaveCount(0);
  await page.keyboard.type("x");
  await expect(editor(page).getByRole("table").getByRole("row")).toHaveCount(2);
  await expect.poll(() => read(page, note.id)).toMatch(/^# Ends\n\nAbove\.x?\n\n?x?\| a \| b \|\n\| - \| - \|\n\| 1 \| 2 \|$/);
});

test("a table stays drawn wherever the cursor is, the arrow keys go into its lines, which are shown as written above it and typed in, and another member's change is drawn without taking a cell being typed in", async ({ page }) => {
  const note = await open(page, TABLE);
  const table = editor(page).getByRole("table");
  const source = editor(page).locator(".cm-line.md-table-source");

  // Down from the line above goes into the table's first line. Its lines are shown, and the table under them is still drawn.
  await keys(page, "ArrowDown", "ArrowDown");
  await expect(source).toHaveText(["| Name  | Qty |", "| ----- | --: |", "| Pens  | 12  |", "| Paper | 500 |"]);
  await expect(table).toBeVisible();
  await expect(editor(page)).toBeFocused();
  // Down through them and out below: they are out of sight again.
  await keys(page, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
  await expect(source).toHaveCount(0);
  await page.keyboard.type("x");
  await expect.poll(() => read(page, note.id)).toBe(TABLE.replace("\n\nAfter.", "\nx\nAfter."));
  await page.keyboard.press("Backspace");
  // Up from the line below goes into its last line, which is typed in as any line is, and the table drawn under it follows.
  await page.keyboard.press("ArrowUp");
  await expect(source).toHaveCount(4);
  await keys(page, "Home", "ArrowRight", "ArrowRight");
  await page.keyboard.type("Blue ");
  await expect(cell(page, 2, 0)).toHaveText("Blue Paper");
  await expect(source.nth(3)).toHaveText("| Blue Paper | 500 |");
  await expect.poll(() => read(page, note.id)).toBe(TABLE.replace("| Paper |", "| Blue Paper |"));
  await keys(page, "Backspace", "Backspace", "Backspace", "Backspace", "Backspace");
  await expect(cell(page, 2, 0)).toHaveText("Paper");
  await keys(page, "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp");
  await expect(source).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("y");
  await expect.poll(() => read(page, note.id)).toBe(TABLE.replace("# Stock\n\n", "# Stock\ny\n"));
  await page.keyboard.press("Backspace");

  // A click in a cell is typed in the cell, and the table's lines stay out of sight.
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toBeFocused();
  await expect(source).toHaveCount(0);
  // The arrows go through the rows from a cell, and out of the table past its first and last.
  await keys(page, "ArrowDown");
  await expect(cell(page, 2, 0)).toBeFocused();
  await keys(page, "ArrowDown");
  await expect(editor(page)).toBeFocused();
  await expect(source).toHaveCount(0);

  // Selecting everything doesn't write the table out either.
  await page.keyboard.press("ControlOrMeta+a");
  await expect(table).toBeVisible();
  await expect(source).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(cell(page, 0, 0)).toBeFocused();

  await cell(page, 2, 0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Card");
  const now = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, text: now.text.replace("| 12  |", "| 13  |"), baseRevision: now.revision });
  await expect(cell(page, 1, 1)).toHaveText("13");
  await expect(cell(page, 2, 0)).toBeFocused();
  await expect(cell(page, 2, 0)).toHaveText("Card");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Stock\n\n| Name | Qty |\n| ---- | --: |\n| Pens | 13  |\n| Card | 500 |\n\nAfter.");

  // Someone else adds a row above and a column before the cell being typed in. The cell keeps the keyboard and what was typed, where its row and column now are.
  await cell(page, 2, 1).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("501 and typing");
  const then = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: then.revision, text: "# Stock\n\n| Name | New | Qty |\n| ---- | --- | --: |\n| Ink | n | 7 |\n| Pens | n | 13 |\n| Card | n | 500 |\n\nAfter." });
  await expect(editor(page).getByRole("table").getByRole("row")).toHaveCount(4);
  await expect(cell(page, 3, 2)).toBeFocused();
  await expect(cell(page, 3, 2)).toHaveText("501 and typing");
  await page.keyboard.type("!");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Stock\n\n| Name | New | Qty             |\n| ---- | --- | --------------: |\n| Ink  | n   | 7               |\n| Pens | n   | 13              |\n| Card | n   | 501 and typing! |\n|      |     |                 |\n\nAfter.");
});

test("looking at a table writes nothing: a click into a cell and away, or Escape, leaves a table that isn't lined up as it was written", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => request.url().endsWith("/ops") && /"note\.(write|undo|redo)"/.test(request.postData() ?? "") && writes.push(request.postData()!));
  const text = "# Agent's table\n\n|Name|Qty|\n|:-|-:|\n|Pens|12|\n|**Paper**|500|\nwords directly under it\n\nAfter.";
  const note = await open(page, text);

  // The line of words directly under the table is a line of text, and the table is drawn above it.
  await expect(editor(page).getByRole("table").getByRole("row")).toHaveCount(3);
  await expectShown(line(page, "words directly"), "words directly under it");

  await cell(page, 1, 0).click();
  await cell(page, 2, 0).click();
  await expect(cell(page, 2, 0)).toHaveText("**Paper**");
  await keys(page, "Tab", "Shift+Tab", "ArrowUp", "ArrowDown");
  await page.keyboard.type("typed and dropped");
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await clickLine(page, "After.");
  await page.waitForTimeout(1200);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(writes).toEqual([]);
  await expect.poll(() => read(page, note.id)).toBe(text);
  await expect.poll(() => authors(page, note.id)).toHaveLength(1);

  // A cell that says something else is written, and the words under the table are still words under it.
  await cell(page, 1, 1).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("13");
  await clickLine(page, "After.");
  await expect.poll(() => read(page, note.id)).toBe("# Agent's table\n\n| Name      | Qty |\n| :-------- | --: |\n| Pens      | 13  |\n| **Paper** | 500 |\nwords directly under it\n\nAfter.");
});

test("in vim mode a deletion that reaches into a table from outside takes the whole table, never half of it", async ({ page }) => {
  const text = "# Vim tables\n\nabove\n| a | b |\n| - | - |\n| 1 | 2 |\n\nbelow\nlast";
  const note = await open(page, text, { "vim.enabled": true });
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  const from = async (says: string, ...presses: string[]) => {
    await clickLine(page, says);
    await keys(page, ...presses);
  };
  const restored = async () => {
    await keys(page, "u");
    await expect.poll(() => read(page, note.id)).toBe(text);
    await expect(editor(page).getByRole("table")).toBeVisible();
  };

  // To an operator, j from the line above is one step over the table's unseen lines, to the blank line after it: dj takes the line above, the table, and that line.
  await from("above", "d", "j");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\nbelow\nlast");
  await restored();
  // Three lines from the line above end on the table's second line. The rest of the table goes with them.
  await from("above", "3", "d", "d");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\n\nbelow\nlast");
  await restored();
  await from("above", "Shift+V", "j", "d");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\nbelow\nlast");
  await restored();
  // From below, dk is one step over the table the other way: it takes the blank line, the table, and the line above it.
  await from("below", "k", "d", "k");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\nbelow\nlast");
  await restored();
  // A deletion that stops short of the table leaves it alone.
  await from("above", "d", "d");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nbelow\nlast");
  await expect(editor(page).getByRole("table")).toBeVisible();

  // With the cursor in the table's lines they are lines: dd takes the one it is on, and the table is drawn from the rest.
  await keys(page, "g", "g", "j", "j", "j", "j");
  await expect(editor(page).locator(".cm-line.md-table-source")).toHaveCount(3);
  await keys(page, "d", "d");
  await expect.poll(() => read(page, note.id)).toBe("# Vim tables\n\n| a | b |\n| - | - |\n\nbelow\nlast");
  await expect(editor(page).getByRole("table").getByRole("row")).toHaveCount(1);
});

test("LaTeX is drawn in a line and on lines of its own, money is left alone, and the cursor shows a formula as written", async ({ page }) => {
  const text = "# Sums\n\nSo $e = mc^2$ holds, and it cost $5, then $10.\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\nAfter `$x$` in code.\n";
  const note = await open(page, text);

  await expect(line(page, "holds").locator(".katex")).toHaveCount(1);
  await expect(line(page, "holds")).toContainText("it cost $5, then $10.");
  await expect(line(page, "holds")).not.toContainText("$e = mc^2$");
  await expect(editor(page).locator(".math-block .katex-display")).toBeVisible();
  await expect(editor(page).locator(".math-block .mfrac")).toHaveCount(1);
  await expect(line(page, "in code")).toHaveText("After $x$ in code.");
  // The fonts came with the drawing: the formula is set in KaTeX's own face.
  await expect.poll(() => editor(page).locator(".math-block .katex").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("KaTeX_Main");

  await line(page, "holds").locator(".katex").first().click();
  await expect(line(page, "holds")).toContainText("So $e = mc^2$ holds");
  await expect(line(page, "holds").locator(".katex")).toHaveCount(0);
  await editor(page).locator(".math-block").click();
  await expect(editor(page).locator(".math-block")).toHaveCount(0);
  await expect(lines(page).nth(5)).toHaveText("\\sum_{i=1}^n i = \\frac{n(n+1)}{2}");
  await page.keyboard.press("End");
  await page.keyboard.type("+0");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(editor(page).locator(".math-block .katex-display")).toBeVisible();
  await expect.poll(() => read(page, note.id)).toBe(text.replace("{2}\n", "{2}+0\n"));
});

test("a formula in a heading is drawn at the heading's size, as one in a paragraph is at the paragraph's", async ({ page }) => {
  await open(page, "# Sizes\n\n# Big $x^2$ head\n\n## Less $y^2$ head\n\nSmall $z^2$ words.\n");
  const sizes = () =>
    page.evaluate(() =>
      ["Big", "Less", "Small"].map((word) => {
        const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(word))!;
        const words = [...line.querySelectorAll<HTMLElement>("span")].find((el) => el.firstChild?.nodeType === Node.TEXT_NODE && el.textContent!.includes(word)) ?? line;
        const katex = line.querySelector<HTMLElement>(".katex");
        return katex ? Math.round((parseFloat(getComputedStyle(katex).fontSize) / parseFloat(getComputedStyle(words).fontSize)) * 100) / 100 : null;
      }),
    );
  // KaTeX sets a formula at 1.21 times the size of the words it is among, in a heading of either size as in a paragraph.
  await expect.poll(sizes).toEqual([1.21, 1.21, 1.21]);
  const heading = await line(page, "Big").locator(".katex").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const paragraph = await line(page, "Small").locator(".katex").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(heading / paragraph).toBeGreaterThan(1.4);
});

test("a formula in a table's cell is drawn, shown as written while the cell is typed in, and by its own rule in the table's lines", async ({ page }) => {
  const text = "# Grid\n\nAbove.\n\n| Formula | Not one |\n| - | - |\n| **b** $y^2$ | `c $z$` |\n| $\\frac{a*b}{c}$ x | $5 and $10 |\n\nAfter.";
  const note = await open(page, text);
  await expect(cell(page, 1, 0).locator(".katex")).toHaveCount(1);
  await expect(cell(page, 1, 0).locator("strong")).toHaveText("b");
  await expect(cell(page, 2, 0).locator(".katex .mfrac")).toHaveCount(1);
  await expect(cell(page, 2, 0)).toContainText("x");
  // Code and money are left as written.
  await expect(cell(page, 1, 1)).toHaveText("c $z$");
  await expect(cell(page, 2, 1)).toHaveText("$5 and $10");
  await expect(cell(page, 1, 0).locator(".katex")).toHaveCSS("font-family", /KaTeX_Main/);

  // Typed in, the cell shows what the note writes for it, and drawn again once the cursor leaves.
  await cell(page, 1, 0).locator(".katex").click();
  await expect(cell(page, 1, 0)).toHaveText("**b** $y^2$");
  await page.keyboard.press("End");
  await page.keyboard.type("+1");
  await page.keyboard.press("Tab");
  await expect(cell(page, 1, 1)).toBeFocused();
  await expect(cell(page, 1, 0).locator(".katex")).toHaveCount(1);
  await expect(cell(page, 1, 0)).not.toContainText("$");
  // Written back, the table is lined up as a table the member types in is.
  const typed = "| Formula           | Not one    |\n| ----------------- | ---------- |\n| **b** $y^2$+1     | `c $z$`    |\n| $\\frac{a*b}{c}$ x | $5 and $10 |";
  await expect.poll(() => read(page, note.id)).toBe(text.replace(/\| Formula[^]*\$10 \|/, () => typed));

  // In the table's lines, reached by the keys, a formula is drawn in its own faces, and shown as written with the cursor on it.
  await clickLine(page, "Above.");
  await keys(page, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
  const source = editor(page).locator(".cm-line.md-table-source");
  await expect(source).toHaveCount(4);
  await expect(source.nth(3).locator(".katex")).toHaveCSS("font-family", /KaTeX_Main/);
  await keys(page, "Home", "ArrowRight", "ArrowRight", "ArrowRight");
  await expect(source.nth(3)).toContainText("$\\frac{a*b}{c}$");
  await expect(source.nth(2).locator(".katex")).toHaveCount(1);

  // With the math turned off a cell shows its formula as written.
  await run(page, "Disable plugin: LaTeX");
  await expect(cell(page, 2, 0)).toHaveText("$\\frac{a*b}{c}$ x");
  await run(page, "Enable plugin: LaTeX");
  await expect(cell(page, 2, 0).locator(".katex")).toHaveCount(1);
  await expect.poll(() => read(page, note.id)).toBe(text.replace(/\| Formula[^]*\$10 \|/, () => typed));
});

test("a formula can't make a link, load an image, or put markup in the page", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await open(page, "# Unsafe\n\n$\\href{javascript:document.title='pwned'}{click}$ and $\\includegraphics{https://example.com/pixel.png}$ and $\\htmlData{onclick=alert(1)}{x}$\n\n$$\n\\url{https://example.com/tracked} \\frac{<img src=https://example.com/x.png onerror=alert(1)>\n$$\n");

  await expect(editor(page).locator(".katex").first()).toBeVisible();
  await expect(editor(page).locator(".math-block")).toBeVisible();
  await expect(editor(page).locator("a, img:not(.cm-widgetBuffer), [onclick], [data-onclick]")).toHaveCount(0);
  await editor(page).locator(".md-chip-math").first().click();
  await expect.poll(() => page.title()).not.toBe("pwned");
  expect(requests.filter((url) => new URL(url).hostname !== new URL(page.url()).hostname)).toEqual([]);
});

test("a code block has its language's colors and two icons shown while the pointer is over it: Copy, and a toggle for wrapping that says which way it is and is remembered", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const long = "const greeting = 'hello'; // " + "long ".repeat(60);
  const text = `# Code\n\n\`\`\`ts\n${long}\nexport default greeting;\n\`\`\`\n\n\`\`\`python\ndef f():\n    return 1\n\`\`\`\n\n\`\`\`nosuchlanguage\nplain text\n\`\`\`\n`;
  const note = await open(page, text);
  const first = line(page, "const greeting");

  await expect(first.locator(".tok-keyword")).toHaveText("const");
  await expect(first.locator(".tok-string")).toHaveText("'hello'");
  await expect(line(page, "def f").locator(".tok-keyword")).toHaveText("def");
  await expect(line(page, "plain text").locator("[class^=tok-]")).toHaveCount(0);
  await expect(first).toHaveCSS("font-family", /mono/i);
  // Off the cursor's line a fence isn't painted, and the language is the block's label.
  await expectShown(lines(page).nth(2), /^\s*ts\s*$/);

  // The icons are the block's, seen while the pointer is over any line of it and not otherwise, and no other block's are.
  const tools = editor(page).locator(".code-tools");
  await expect(tools).toHaveCount(3);
  await page.mouse.move(5, 5);
  await expect(tools.nth(0)).toHaveCSS("opacity", "0");
  await line(page, "export default").hover({ position: { x: 60, y: 8 } });
  await expect(tools.nth(0)).toHaveCSS("opacity", "1");
  await expect(tools.nth(1)).toHaveCSS("opacity", "0");
  await expect(tools.nth(0).getByRole("button")).toHaveCount(2);

  await editor(page).getByRole("button", { name: "Copy code" }).first().click();
  await expect(editor(page).getByRole("button", { name: "Copied" })).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${long}\nexport default greeting;`);
  await expect(editor(page).getByRole("button", { name: "Copy code" })).toHaveCount(3);

  // A toggle: pressed while long lines wrap and not while they scroll, and it looks and reads differently in the two.
  const wrap = editor(page).getByRole("button", { name: "Wrap long lines" }).first();
  const look = () => wrap.evaluate((el) => `${getComputedStyle(el).backgroundColor} ${getComputedStyle(el).color}`);
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(wrap).toHaveAttribute("title", "Long lines wrap. Press to scroll them instead.");
  await expect(wrap).toHaveText("");
  await page.mouse.move(5, 5);
  const pressed = await look();
  const turning = await wrap.innerHTML();
  const wrapped = (await first.boundingBox())!.height;
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(wrap).toHaveAttribute("title", "Long lines scroll. Press to wrap them.");
  await page.mouse.move(5, 5);
  expect(await look()).not.toBe(pressed);
  expect(await wrap.innerHTML(), "its icon is another one").not.toBe(turning);
  await expect(first).toHaveCSS("white-space", "pre");
  await expect.poll(async () => (await first.boundingBox())!.height).toBeLessThan(wrapped / 2);
  // Every block follows the one toggle, and prose still wraps.
  await expect(line(page, "def f")).toHaveCSS("white-space", "pre");
  await expect(lines(page).nth(0)).not.toHaveCSS("white-space", "pre");

  await page.reload();
  await expect(editor(page).getByRole("button", { name: "Wrap" }).first()).toHaveAttribute("aria-pressed", "false");
  await expect(line(page, "const greeting")).toHaveCSS("white-space", "pre");

  // The code is drawn the same with the cursor in it, and a fence is shown as written with the cursor on its line.
  // Not a click past the line's end, which without wrapping is off the screen. And not before the colors are in: they redraw the line, and a click
  // that finds its line redrawn under it is tried again with the whole of that line scrolled to, which is far off to the side.
  await expect(line(page, "export default").locator(".tok-keyword").first()).toHaveText("export");
  await line(page, "export default").click({ position: { x: 60, y: 8 } });
  await expectShown(lines(page).nth(2), /^\s*ts\s*$/);
  await expect(line(page, "const greeting").locator(".tok-keyword")).toHaveText("const");
  await keys(page, "ArrowUp", "ArrowUp");
  await expectShown(lines(page).nth(2), /^```ts\s*$/);
  // Naming another language on the fence colors the code as that language.
  await page.keyboard.press("End");
  await keys(page, "Backspace", "Backspace");
  await page.keyboard.type("python");
  await expect(line(page, "const greeting").locator(".tok-keyword")).toHaveCount(0);
  await keys(page, ..."python".split("").map(() => "Backspace"));
  await page.keyboard.type("ts");
  await expect(line(page, "const greeting").locator(".tok-keyword")).toHaveText("const");
  await expect.poll(() => read(page, note.id)).toBe(text);
});

test("Tab and Shift+Tab indent and outdent a bullet with what is under it, and Alt+arrows move it among its siblings", async ({ page }) => {
  const note = await open(page, OUTLINE);

  await clickLine(page, "book");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - socks\n  - maps\n  - book\n    - train\n- go\n\nAfter.");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toContain("  - book!\n    - train");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);

  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- book\n  - train\n- pack\n  - socks\n  - maps\n- go\n\nAfter.");
  await page.keyboard.type("?");
  await expect.poll(() => read(page, note.id)).toContain("- book?\n  - train\n- pack");
  await page.keyboard.press("Backspace");
  await keys(page, "Alt+ArrowDown", "Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - socks\n  - maps\n- go\n- book\n  - train\n\nAfter.");
  // The last of its list has nowhere further to go.
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.type(".");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - socks\n  - maps\n- go\n- book.\n  - train\n\nAfter.");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  await page.keyboard.press("Backspace");
  await clickLine(page, "go");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toContain("  - maps\n  - go\n- book");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toContain("  - maps\n- go\n- book");
});

test("Option+arrows move a bullet with what is under it up, down, in and out, and do nothing where the outline has no room for it", async ({ page }) => {
  const text = "# Plan\n\n- a\n- b\n  - under b\n- c\n\nAfter.";
  const note = await open(page, text);

  await clickLine(page, /^\s*- b$/);
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n- c\n- b\n  - under b\n\nAfter.");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe(text);

  await page.keyboard.press(RIGHT);
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n  - b\n    - under b\n- c\n\nAfter.");
  // Two levels further in than the bullet above is refused: nothing changes, and the cursor stays at the end of its bullet, not a word along.
  await page.keyboard.press(RIGHT);
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n  - b!\n    - under b\n- c\n\nAfter.");
  await page.keyboard.press("Backspace");

  await page.keyboard.press(LEFT);
  await expect.poll(() => read(page, note.id)).toBe(text);
  // A bullet under nothing has nowhere further out to go.
  await page.keyboard.press(LEFT);
  await page.keyboard.type("?");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("- b\n", "- b?\n"));
  await page.keyboard.press("Backspace");

  // The first bullet of a list has nothing to go under.
  await clickLine(page, /^\s*- a$/);
  await page.keyboard.press(RIGHT);
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("- a\n", "- a!\n"));
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));
});

test("Option+arrows move the bullets a selection takes in together, and the selection goes with them", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- a\n- b\n- c\n- d");

  await clickLine(page, /^\s*- b$/);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n- d\n- b\n- c");
  await page.keyboard.press(RIGHT);
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n- d\n  - b\n  - c");
  await page.keyboard.press(LEFT);
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n- d\n- b\n- c");

  // A selection of whole lines, which ends at the start of the line after them, goes with them, so the next press moves them again.
  await clickLine(page, /^\s*- d$/);
  await keys(page, "Home", "Shift+ArrowDown", "Shift+ArrowDown", "Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- d\n- b\n- a\n- c");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n- d\n- b\n- c");
});

test("a numbered list is numbered in order again after a bullet moves or goes in, and undo takes back the move and the numbers in one step", async ({ page }) => {
  const text = "# Steps\n\n1. one\n2. two\n3. three\n4. four\n\nAfter.";
  const note = await open(page, text);

  await clickLine(page, "three");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe("# Steps\n\n1. one\n2. three\n3. two\n4. four\n\nAfter.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(text);

  await clickLine(page, "three");
  await page.keyboard.press(RIGHT);
  await expect.poll(() => read(page, note.id)).toBe("# Steps\n\n1. one\n2. two\n   1. three\n3. four\n\nAfter.");
  await page.keyboard.press(LEFT);
  await expect.poll(() => read(page, note.id)).toBe(text);
  await page.keyboard.press(RIGHT);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(text);
});

test("Option+arrows off a list are the editor's own: in a paragraph they move the cursor by words", async ({ page }) => {
  const text = "# Words\n\nsome plain words\n\n- a\n- b";
  const note = await open(page, text);

  await clickLine(page, "some plain words");
  await page.keyboard.press("Home");
  await page.keyboard.press(RIGHT);
  if (MAC) {
    await page.keyboard.type("!");
    await expect.poll(() => read(page, note.id)).toBe(text.replace("some plain", "some! plain"));
    await page.keyboard.press("Backspace");
    await page.keyboard.press(LEFT);
    await page.keyboard.type("^");
    await expect.poll(() => read(page, note.id)).toBe(text.replace("some plain", "^some plain"));
  } else await expect.poll(() => read(page, note.id)).toBe(text);
});

test("in vim's normal mode Option+arrows move a bullet and vim stays in normal mode", async ({ page }) => {
  const text = "# Plan\n\n- a\n- b";
  const note = await open(page, text, { "vim.enabled": true });

  await clickLine(page, /^\s*- b$/);
  await page.keyboard.press("Escape");
  await page.keyboard.press(RIGHT);
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n  - b");
  await keys(page, "$", "x");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- a\n  - ");
  await page.keyboard.press("u");
  await page.keyboard.press(LEFT);
  await expect.poll(() => read(page, note.id)).toBe(text);
});

test("a bullet folds what is under it without changing the note, stays folded after a reload, and unfolds when asked", async ({ page }) => {
  const note = await open(page, OUTLINE);

  // A bullet that has something under it has a disclosure out in the margin, which is no letter of its line.
  await expectShown(line(page, "pack"), /^\s*pack$/);
  await expect(editor(page).getByRole("button", { name: "Fold" })).toHaveCount(2);
  await expectShown(line(page, "go"), /^\s*go$/);
  await expect(line(page, "go").locator(".bullet-dot")).toHaveCount(1);
  await fold(page, "pack");
  await expectShown(line(page, "pack"), /^\s*pack\s*…$/);
  await expect(editor(page)).not.toContainText("socks");
  await expect(editor(page)).toContainText("train");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);

  // The arrow keys step over what is folded, and typing after it lands after it.
  await clickLine(page, "pack");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE.replace("- book", "- book!"));
  await expect(editor(page)).not.toContainText("socks");

  await page.reload();
  await expect(line(page, "pack")).toContainText("…");
  await expect(editor(page)).not.toContainText("socks");

  await clickLine(page, "train");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await expect(editor(page)).not.toContainText("train");
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await expect(editor(page)).toContainText("train");

  await line(page, "pack").getByRole("button", { name: "Unfold" }).last().click();
  await expect(editor(page)).toContainText("socks");
  await page.reload();
  await expect(editor(page)).toContainText("socks");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE.replace("- book", "- book!"));
});

test("a folded bullet moves with what is folded under it and stays folded, and nothing folded is deleted or typed over unseen", async ({ page }) => {
  const note = await open(page, OUTLINE);

  await fold(page, "pack");
  await clickLine(page, "pack");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- book\n  - train\n- pack\n  - socks\n  - maps\n- go\n\nAfter.");
  await expect(line(page, "pack")).toContainText("…");
  await expect(editor(page)).not.toContainText("socks");

  // A selection that reaches what is folded opens it, so what the next key deletes is on screen first.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(editor(page)).toContainText("socks");
  await expect(line(page, "pack")).not.toContainText("…");
  await page.keyboard.type("x");
  await expect.poll(() => read(page, note.id)).toMatch(/^# Trip\n\n- book\n  - train\nx/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- book\n  - train\n- pack\n  - socks\n  - maps\n- go\n\nAfter.");

  // Deleting a folded bullet's own line, by any key, leaves what was under it and shows it.
  await fold(page, "pack");
  await expect(editor(page)).not.toContainText("socks");
  await clickLine(page, "pack");
  await keys(page, "Backspace", "Backspace", "Backspace", "Backspace", "Backspace", "Backspace", "Backspace");
  await expect(editor(page)).toContainText("socks");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- book\n  - train\n  - socks\n  - maps\n- go\n\nAfter.");

  // The arrow keys go into what is folded, which opens it, and typing at its edge shows what was typed.
  await fold(page, "book");
  await expect(editor(page)).not.toContainText("train");
  await clickLine(page, "book");
  await page.keyboard.press("ArrowRight");
  await expect(editor(page)).toContainText("train");
  await fold(page, "book");
  await clickLine(page, "go");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect(editor(page)).toContainText("maps!");
  await expect.poll(() => read(page, note.id)).toContain("  - maps!\n- go");
});

test("a line that only looks like a bullet, in code or in a block of math, is not one: no key moves it and nothing is drawn on it", async ({ page }) => {
  const text = "# Not bullets\n\n- real\n- also real\n\n```\n- in code\n- more code\n  - under code\n```\n\n$$\n- x\n- y\n$$\n\nAfter.";
  const note = await open(page, text);
  await expect(editor(page).locator(".math-block")).toHaveCount(1);
  await expect(editor(page).locator(".bullet-dot")).toHaveCount(2);

  await line(page, "more code").click();
  await keys(page, "Alt+ArrowUp", "Alt+ArrowDown", "ControlOrMeta+Shift+.");
  // Shift+Tab there outdents the line as text, and nothing under it goes with it.
  await line(page, "under code").click();
  await page.keyboard.press("Shift+Tab");
  await editor(page).locator(".math-block").click();
  await expect(line(page, "- y")).toBeVisible();
  await line(page, "- y").click();
  await keys(page, "ControlOrMeta+Shift+.");
  await expect(editor(page)).not.toContainText("…");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("- y", "- y!").replace("  - under code", "- under code"));

  // The same keys on a real bullet are the outline's.
  await clickLine(page, "also real");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toContain("- real\n  - also real\n\n```\n- in code\n- more code\n- under code\n```");
});

test("each kind of rendering is its own plugin: turning one off shows that markdown as written and leaves the rest drawn", async ({ page }) => {
  const text = "# All\n\nSome **bold** here.\n\n- [ ] task\n  - under\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nMath $x^2$ here.\n\n```js\nconst a = 1;\n```\n";
  const note = await open(page, text);
  const drawn = {
    gfm: () => editor(page).locator(".md-hang"),
    todos: () => editor(page).getByRole("checkbox"),
    tables: () => editor(page).getByRole("table"),
    math: () => editor(page).locator(".katex"),
    "code-blocks": () => editor(page).getByRole("button", { name: "Copy" }),
    bullets: () => editor(page).locator(".bullet-dot"),
  };
  const names = { gfm: "GitHub-flavored markdown", todos: "Todos", tables: "Tables", math: "LaTeX", "code-blocks": "Code blocks", bullets: "Outline bullets" };

  for (const each of Object.values(drawn)) await expect(each()).toHaveCount(1);
  await expect(line(page, "const a").locator(".tok-keyword")).toHaveCount(1);
  await expectShown(line(page, "Some"), "Some bold here.");

  for (const id of Object.keys(drawn) as (keyof typeof drawn)[]) {
    await run(page, `Disable plugin: ${names[id]}`);
    await expect(drawn[id]()).toHaveCount(0);
    for (const [other, each] of Object.entries(drawn)) if (other !== id) await expect(each(), `${other} with ${id} off`).toHaveCount(1);
    await run(page, `Enable plugin: ${names[id]}`);
    await expect(drawn[id]()).toHaveCount(1);
  }

  await run(page, "Disable plugin: GitHub-flavored markdown");
  await expectShown(line(page, "Some"), "Some **bold** here.");
  await run(page, "Disable plugin: Code blocks");
  await expect(editor(page).locator("[class^=tok-]")).toHaveCount(0);
  await expect(line(page, "const a")).not.toHaveClass(/code-line/);
  await run(page, "Disable plugin: Outline bullets");
  await expectShown(line(page, "under"), "  - under");
  await expect.poll(() => read(page, note.id)).toBe(text);
});

test("when the math can't be loaded the Plugins page says so and formulas are shown as written", async ({ page }) => {
  await page.route(/math\/rendering|assets\/rendering-/, (route) => route.abort());
  await open(page, "# Sums\n\nSo $e = mc^2$ holds and **bold** is drawn.\n");

  await expectShown(lines(page).nth(2), "So $e = mc^2$ holds and bold is drawn.");
  await run(page, "Go to Plugins");
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "LaTeX" }).getByRole("alert")).toContainText("The math couldn't be loaded");
});

test("a note with no math and no code loads neither's drawing", async ({ page }) => {
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(request.url()));
  await open(page, "# Plain\n\nJust **words** and a list that cost $5, or $10 for two.\n\n- one\n- two\n");

  await expectShown(lines(page).nth(2), "Just words and a list that cost $5, or $10 for two.");
  expect(loaded.filter((url) => /katex|math\/rendering|assets\/rendering-|highlighting|language-data/i.test(url))).toEqual([]);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Now $a+b$ here");
  await page.keyboard.press("Enter");
  await expect(line(page, "Now").locator(".katex")).toHaveCount(1);
});

test("embeds are drawn beside bullets and tasks, a board after a list still works, and / on a bullet opens the insert menu but not in code", async ({ page }) => {
  const text = "# Mix\n\n- [ ] steep /timer(5m) then pour\n  - cup $x^2$\n- wait\n\n/kanban()\n~~~markdown\n## To do\n- write\n\n## Done\n~~~\n\n```\ncode\n```\n";
  const note = await open(page, text);

  await expect(line(page, "steep").getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();
  await expect(line(page, "steep").getByRole("checkbox")).toBeVisible();
  await expect(line(page, "cup").locator(".katex")).toHaveCount(1);
  await expect(editor(page).getByRole("region", { name: "To do", exact: true }).getByRole("listitem")).toHaveCount(1);
  // The board's own list is the board's: no dots or checkboxes are drawn into it.
  await expect(editor(page).locator(".embed-block .bullet-dot")).toHaveCount(0);

  await line(page, "steep").getByRole("checkbox").click();
  await expect.poll(() => read(page, note.id)).toContain("- [x] steep /timer(5m) then pour");
  await clickLine(page, "wait");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("- [ ] steep /timer(5m) then pour\n  - cup $x^2$\n- wait", "- wait\n- [x] steep /timer(5m) then pour\n  - cup $x^2$"));
  await expect(editor(page).getByRole("region", { name: "To do", exact: true }).getByRole("listitem")).toHaveCount(1);
  await expect(line(page, "steep").getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();

  await page.keyboard.type(" /");
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText("Heading 1");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await clickLine(page, /^code/);
  await page.keyboard.type(" /");
  await page.waitForTimeout(300);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("in vim mode, j and k go through a table's lines, go through a formula and a code block line by line, and dd on a folded bullet shows what was under it", async ({ page }) => {
  const text = "# Vim\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n```js\nlet a;\n```\n\n- pack\n  - socks\n  - maps\n- go\n";
  const note = await open(page, text, { "vim.enabled": true });
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await keys(page, "g", "g");

  // Onto the blank line, through the table's three lines, which are shown above it while the cursor is in them, to the blank line after it.
  const source = editor(page).locator(".cm-line.md-table-source");
  await keys(page, "j", "j");
  await expect(source).toHaveText(["| a | b |", "| - | - |", "| 1 | 2 |"]);
  await expect(editor(page).getByRole("table")).toBeVisible();
  await keys(page, "j", "j", "j");
  await expect(source).toHaveCount(0);
  await expect(editor(page).getByRole("table")).toBeVisible();
  await expect(editor(page).locator(".math-block")).toHaveCount(1);
  await keys(page, "j");
  await expect(editor(page).locator(".math-block")).toHaveCount(0);
  await expect(line(page, "$$")).toBeVisible();
  await keys(page, "j", "x");
  await expect.poll(() => read(page, note.id)).toContain("$$\n^2\n$$");
  await keys(page, "j", "j");
  await expect(editor(page).locator(".math-block .katex")).toHaveCount(1);
  // Onto the opening fence, which is then shown, then the code, then the closing fence.
  await keys(page, "j");
  await expectShown(line(page, "js"), /^```js/);
  await keys(page, "j");
  await expectShown(line(page, "js"), /^\s*js/);
  await keys(page, "d", "w");
  await expect.poll(() => read(page, note.id)).toContain("```js\na;\n```");
  await keys(page, "j");
  await expectShown(lines(page).filter({ hasText: /^```$/ }), "```");
  await keys(page, "k", "k", "k");
  await expect(editor(page).locator(".math-block")).toHaveCount(1);
  await keys(page, "k");
  await expect(editor(page).locator(".math-block")).toHaveCount(0);
  await keys(page, "k", "k", "k");
  await expect(editor(page).locator(".math-block")).toHaveCount(1);
  // Up through the table's lines, last to first, to the blank line above it, and on to the title.
  await keys(page, "k");
  await expect(source).toHaveCount(3);
  await keys(page, "k", "k", "k");
  await expect(source).toHaveCount(0);
  await keys(page, "k", "x");
  await expect.poll(() => read(page, note.id)).toMatch(/^ Vim\n/);

  await fold(page, "pack");
  await expect(editor(page)).not.toContainText("socks");
  await clickLine(page, "pack");
  await expect(line(page, "pack")).toContainText("…");
  // dd takes the one line vim has in its register, and what was folded under it is shown, not deleted with it.
  await keys(page, "d", "d");
  await expect.poll(() => read(page, note.id)).toBe(" Vim\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\n^2\n$$\n\n```js\na;\n```\n\n  - socks\n  - maps\n- go\n");
  await expect(editor(page)).toContainText("socks");
  await keys(page, "Shift+P");
  await expect.poll(() => read(page, note.id)).toContain("```\n\n- pack\n  - socks\n  - maps\n- go\n");
});

test("a long note draws only what is on screen and stays quick to type in", async ({ page }) => {
  const section = (n: number) => `## Part ${n}\n\nSome **bold** and $x_{${n}}^2$ and \`code\`.\n\n- [ ] item ${n}\n  - under ${n}\n\n| a | b |\n| - | - |\n| ${n} | 2 |\n\n\`\`\`js\nconst part = ${n};\n\`\`\`\n`;
  const text = `# Long\n\n${Array.from({ length: 320 }, (_, n) => section(n)).join("\n")}`;
  expect(text.split("\n").length).toBeGreaterThan(4500);
  const note = await open(page, text);

  await expect(editor(page).locator(".katex").first()).toBeVisible();
  await expect(line(page, "const part = 0").locator(".tok-keyword")).toHaveCount(1);
  await expect.poll(() => lines(page).count()).toBeLessThan(400);
  await expect.poll(() => editor(page).locator(".md-chip").count()).toBeLessThan(120);

  await clickLine(page, "Some bold");
  const started = Date.now();
  await page.keyboard.type("The quick brown fox jumps over the lazy dog. ".repeat(4));
  const typed = await page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(Date.now())))));
  // 180 keys. A redraw of the whole note on each would take many times this.
  expect(typed - started).toBeLessThan(6000);

  await page.keyboard.press("ControlOrMeta+End");
  await expect(line(page, "const part = 319")).toBeVisible();
  await expect(line(page, "const part = 319").locator(".tok-keyword")).toHaveCount(1);
  await expect(editor(page).getByRole("table").last().getByRole("cell").first()).toHaveText("319");
  await page.keyboard.type("end");
  await expect.poll(() => read(page, note.id).then((t) => t.endsWith("```\nend") && t.includes("lazy dog. ")), { timeout: 20_000 }).toBe(true);
});

test("each side of a split draws its own note, a fold and a table edit stay with their side, and focus keeps the drawing", async ({ page }) => {
  const body = (title: string) => `# ${title}\n\n| Name  | Qty |\n| ----- | --: |\n| Pens  | 12  |\n\n- pack\n  - socks ${title}\n\nSo $x^2$.\n`;
  const alpha = await open(page, body("Alpha"));
  const beta = await perform(page, { type: "note.create", text: body("Beta") });
  await run(page, "Keep tab open");
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("Beta");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Beta");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await run(page, "Split editor right");
  // A note split off is copied, so the copy left in the first group is closed, and Alpha is drawn there.
  await page.getByRole("tablist", { name: "Open notes" }).nth(0).getByTitle("Close Beta", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toHaveCount(2);
  for (const group of [0, 1]) {
    await expect(editor(page, group).getByRole("table")).toBeVisible();
    await expect(editor(page, group).locator(".katex")).toHaveCount(1);
    await expect(editor(page, group).locator(".bullet-dot")).toHaveCount(2);
  }

  await cell(page, 1, 1, 0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("99");
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, alpha.id)).toContain("| Pens | 99  |\n|      |     |");
  await expect(cell(page, 1, 1, 1)).toHaveText("12");
  await expect.poll(() => read(page, beta.id)).toBe(body("Beta"));

  await fold(page, "pack", editor(page, 1));
  await expect(editor(page, 1)).not.toContainText("socks Beta");
  await expect(editor(page, 0)).toContainText("socks Alpha");

  // In focus the side in front fills the window, drawn as it was, and leaving puts both sides back as they were.
  await editor(page, 1).focus();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note text" })).toHaveCount(1);
  await expect(editor(page).getByRole("table")).toBeVisible();
  await expect(editor(page).locator(".katex")).toHaveCount(1);
  await expect(editor(page)).toContainText("Beta");
  await expect(editor(page)).not.toContainText("socks Beta");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
  for (const group of [0, 1]) {
    await expect(editor(page, group).getByRole("table")).toBeVisible();
    await expect(editor(page, group).locator(".katex")).toHaveCount(1);
  }
  await expect(editor(page, 1)).not.toContainText("socks Beta");
  await expect(editor(page, 0)).toContainText("socks Alpha");
});

test("a member who can't change the note sees it drawn, and no checkbox, cell, or bullet key changes it", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => request.url().endsWith("/ops") && /"note\.(write|undo|redo)"/.test(request.postData() ?? "") && writes.push(request.postData()!));
  const written = "# Plan\n\n- [ ] sweep\n  - under\n- mop\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSo $x^2$.\n\n```js\nlet a;\n```\n";
  const { note, admin } = await asViewerOfNote(page, written);
  await page.goto(`/note/${note.id}`);

  await expect(page.getByRole("button", { name: "Ada's workspace Viewer" })).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  // It takes the keyboard, for the keys that change nothing in it: folding a bullet.
  await expect(editor(page)).toHaveAttribute("tabindex", "0");
  await expect(editor(page).getByRole("table")).toBeVisible();
  await expect(editor(page).locator(".katex")).toHaveCount(1);
  await expect(line(page, "let a").locator(".tok-keyword")).toHaveText("let");
  await expect(editor(page).getByRole("checkbox")).toBeDisabled();
  await expect(cell(page, 1, 0)).not.toHaveAttribute("contenteditable");
  await expect(editor(page).getByRole("button", { name: /^(Add|Delete) (row|column)$/ })).toHaveCount(0);
  // Copying and folding change nothing in the note, so a reader has them.
  await expect(editor(page).getByRole("button", { name: "Copy" })).toBeVisible();

  await editor(page).getByRole("checkbox").click({ force: true });
  await cell(page, 1, 0).click();
  await page.keyboard.type("typed");
  await line(page, "mop").click();
  await keys(page, "Tab", "Alt+ArrowUp", "Shift+Tab", "ControlOrMeta+Alt+t");
  await page.keyboard.type("typed");
  await fold(page, "sweep");
  await expect(editor(page)).not.toContainText("under");
  await expect(cell(page, 1, 0)).toHaveText("1");
  // A note the member can't change says so where a note says it is saved.
  await expect(page.getByRole("status")).toHaveText("View only");
  expect(writes).toEqual([]);
  await expect.poll(() => read(admin, note.id)).toBe(written);
});
