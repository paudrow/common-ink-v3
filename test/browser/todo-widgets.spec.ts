import { expect, type Page } from "@playwright/test";
import { asViewerOfNote, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, words: string) => editor(page).locator(".cm-line").filter({ hasText: words });
/** The controls beside the todo line that shows them. */
const adds = (page: Page) => page.locator(".md-todo-adds");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const today = (page: Page) => page.evaluate(() => new Date().toLocaleDateString("en-CA"));

const NOTE = "# Chores\n\n- [ ] Water the plants\n- [ ] !! Call the plumber due:2031-10-01 every:1w\n- Not a todo\n- [ ]\n\nLast words.";

async function open(page: Page, text = NOTE) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last words.");
  await page.mouse.move(0, 0);
  return note;
}

test("a todo's line offers what isn't set yet, its due date, repeat and priority, only while it is pointed at or has the cursor, and each writes the token a person would type", async ({ page }) => {
  const note = await open(page);
  const plants = line(page, "Water the plants");

  // At rest a note shows only what is written.
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(0);

  // Pointed at, a todo with nothing set offers all three, and one with all three set offers none. A line that isn't a todo has none.
  await plants.getByText("Water the plants").hover();
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(3);
  await expect(adds(page).getByRole("button", { name: "Due date: none" })).toBeVisible();
  await expect(adds(page).getByRole("button", { name: "Repeat: none" })).toBeVisible();
  await expect(adds(page).getByRole("button", { name: "Priority: none" })).toBeVisible();
  await line(page, "Call the plumber").getByText("Call the plumber").hover();
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(0);
  await line(page, "Not a todo").hover();
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(0);
  // `- [ ]` with nothing after it yet is no box to set anything on.
  await editor(page).locator(".cm-line").filter({ hasText: /^- \[ \]$/ }).hover();
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(0);

  // Showing them moves nothing: not the line's words, nor the line after it.
  const where = () =>
    page.evaluate(() => {
      const lines = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")];
      const range = document.createRange();
      const text = document.evaluate(".//text()[contains(., 'Water the plants')]", document.querySelector(".cm-content")!, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue!;
      range.selectNodeContents(text);
      const { left, right, top } = range.getBoundingClientRect();
      return { left, right, top, next: lines.find((el) => el.textContent!.includes("Call the plumber"))!.getBoundingClientRect().top, scroll: document.querySelector(".cm-scroller")!.scrollWidth };
    });
  await page.mouse.move(0, 0);
  const before = await where();
  await plants.getByText("Water the plants").hover();
  await expect(adds(page).getByRole("button", { name: "Due date: none" })).toBeVisible();
  expect(await where()).toEqual(before);

  // Each opens the Todos page's own popover, and what is picked is written on the line as the member's edit.
  await adds(page).getByRole("button", { name: "Priority: none" }).click();
  await page.getByRole("button", { name: "High" }).click();
  await expect.poll(() => read(page, note.id)).toContain("- [ ] !!! Water the plants\n");

  await plants.getByText("Water the plants").hover();
  await adds(page).getByRole("button", { name: "Repeat: none" }).click();
  await page.getByRole("radio", { name: "Weekly" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => read(page, note.id)).toContain("- [ ] !!! Water the plants every:1w\n");

  await plants.getByText("Water the plants").hover();
  await adds(page).getByRole("button", { name: "Due date: none" }).click();
  await page.getByRole("button", { name: /^Tomorrow/ }).click();
  await expect.poll(() => read(page, note.id)).toMatch(/- \[ \] !!! Water the plants every:1w due:\d{4}-\d{2}-\d{2}\n/);
  await expect(adds(page).getByRole("button", { name: /: none$/ })).toHaveCount(0);

  // Undo takes back the last of them, as it would typing.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toContain("- [ ] !!! Water the plants every:1w\n");
});

test("with the cursor on a todo its controls show without the pointer, and the keyboard opens each by its command and picks in it", async ({ page }) => {
  const note = await open(page);
  const plants = line(page, "Water the plants");
  await plants.getByText("Water the plants").click();
  await page.keyboard.press("End");
  await page.mouse.move(0, 0);
  await expect(adds(page).getByRole("button", { name: "Due date: none" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(adds(page).getByRole("button", { name: "Due date: none" })).toBeHidden();
  await page.keyboard.press("ArrowUp");

  await runCommand(page, "Set this todo's due date");
  const menu = page.locator(".chip-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toContain(`- [ ] Water the plants due:${await today(page)}\n`);
  // The keyboard is back in the note, where it was.
  await expect(editor(page)).toBeFocused();

  // On a todo whose date is set, the command opens the date's own chip.
  await runCommand(page, "Set this todo's due date");
  await expect(menu.locator("[aria-current=true]")).toHaveText(/^Today/);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("a member who can only read a note sees what is set on its todos and nothing to set", async ({ page }) => {
  const { note } = await asViewerOfNote(page, NOTE);
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last words.");
  await line(page, "Water the plants").getByText("Water the plants").hover();
  await expect(editor(page).locator(".md-todo-adds")).toHaveCount(0);
  await expect(line(page, "Call the plumber").getByRole("button", { name: /^Due date/ })).toBeVisible();
});

test("a note's date, repeat and priority chips are the Todos page's: as wide as their words, the same height, padding, type and colours, and the line no taller", async ({ page }) => {
  await open(page, "# Chips\n\n- [ ] !! Pay the bill due:2031-10-30 every:1w\n- Plain line\n\nLast words.");
  const style = (el: Element) => {
    const s = getComputedStyle(el);
    return { height: s.height, padding: `${s.paddingLeft} ${s.paddingRight}`, radius: s.borderRadius, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`, background: s.backgroundColor, color: s.color };
  };
  const bill = line(page, "Pay the bill");
  const inNote = await Promise.all([".md-chip-due", ".md-chip-every", ".md-chip-importance"].map((chip) => bill.locator(chip).evaluate(style)));
  const widths = await bill.evaluate((el) => {
    const due = el.querySelector(".md-chip-due")!;
    const probe = Object.assign(document.createElement("span"), { textContent: "due:2031-10-30" });
    el.append(probe);
    const written = probe.getBoundingClientRect().width;
    probe.remove();
    return { chip: due.getBoundingClientRect().width, written };
  });
  expect(widths.chip, `the date chip is ${widths.chip}px, its token ${widths.written}px`).toBeLessThan(widths.written * 0.75);
  expect((await bill.boundingBox())!.height).toBe((await line(page, "Plain line").boundingBox())!.height);

  await page.goto("/todos");
  const row = page.getByRole("region", { name: "Todos" }).getByRole("listitem").filter({ hasText: "Pay the bill" });
  const onPage = await Promise.all([".todo-due", ".todo-every", ".todo-importance"].map((chip) => row.locator(chip).first().evaluate(style)));
  expect(inNote).toEqual(onPage);
});
