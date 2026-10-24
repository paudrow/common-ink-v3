import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const column = (page: Page, name: string) => editor(page).getByRole("region", { name, exact: true });
const titles = (page: Page) => editor(page).locator(".kanban-column .kanban-title");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const content = async (page: Page, id: string) => /```markdown\n([\s\S]*?)```/.exec(await read(page, id))?.[1] ?? null;
const menuFor = async (page: Page, name: string) => {
  await editor(page).getByRole("button", { name: `${name} column menu` }).click();
  return page.getByRole("menu");
};

const BOARD = "## To do {.red}\n- write\n- review\n\n## Doing\n- build\n\n## Done\n";

async function open(page: Page, body: string | null, vim = false) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n/kanban()${body === null ? "" : `\n\`\`\`markdown\n${body}\`\`\``}\n\nafter` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page).locator(".kanban")).toBeVisible();
  return note;
}

/** Whether what has the keyboard, with its ring, is inside the board's row of columns, which cuts off what is past its edges. */
const ringInside = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement as HTMLElement;
    const row = focused.closest(".kanban-columns")!.getBoundingClientRect();
    const box = focused.getBoundingClientRect();
    const ring = parseFloat(getComputedStyle(focused).outlineWidth) + Math.max(0, parseFloat(getComputedStyle(focused).outlineOffset));
    return box.left - ring >= row.left && box.right + ring <= row.right && box.top - ring >= row.top && box.bottom + ring <= row.bottom;
  });

test("Add column puts a new column at the end of the board with its name ready to type, which Enter writes as a heading and keeps the keyboard on, and Escape takes away", async ({ page }) => {
  const note = await open(page, BOARD);
  const add = editor(page).getByRole("button", { name: "Add column" });
  await add.click();
  // The column is there at once, before Add column, its name typed in its head.
  const name = editor(page).getByRole("textbox", { name: "New column name" });
  await expect(name).toBeFocused();
  await expect(editor(page).locator(".kanban-column").last().getByRole("textbox", { name: "New column name" })).toBeVisible();
  expect(await ringInside(page)).toBe(true);
  await page.keyboard.type("Later");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["To do", "Doing", "Done", "Later"]);
  await expect.poll(() => content(page, note.id)).toBe(`${BOARD}\n## Later\n`);
  // The keyboard is on the new column's name, its ring whole.
  await expect(titles(page).last()).toBeFocused();
  expect(await ringInside(page)).toBe(true);
  await add.click();
  await page.keyboard.type("Never");
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await expect(editor(page).locator(".kanban-column")).toHaveCount(4);
  await expect(titles(page)).toHaveText(["To do", "Doing", "Done", "Later"]);
});

test("a board with no columns yet takes its first from Add column, which writes its content", async ({ page }) => {
  const note = await open(page, null);
  await expect(editor(page).locator(".kanban-empty")).toBeVisible();
  await editor(page).getByRole("button", { name: "Add column" }).click();
  await page.keyboard.type("To do");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["To do"]);
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n/kanban()\n```markdown\n## To do\n```\n\nafter");
});

test("a column is renamed in place, by a double-click or by Enter on its name, keeping its colour and its cards", async ({ page }) => {
  const note = await open(page, BOARD);
  await titles(page).first().dblclick();
  const name = editor(page).getByRole("textbox", { name: "Name of To do" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("To do");
  await page.keyboard.type("Next");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["Next", "Doing", "Done"]);
  await expect.poll(() => content(page, note.id)).toBe(BOARD.replace("## To do {.red}", "## Next {.red}"));
  await expect(column(page, "Next").getByRole("listitem")).toHaveText(["write", "review"]);
  await expect(titles(page).first()).toBeFocused();

  // By the keyboard: Enter on the name, and Escape leaves it as it was.
  await titles(page).nth(1).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Busy");
  await page.keyboard.press("Escape");
  await expect(titles(page)).toHaveText(["Next", "Doing", "Done"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Busy");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["Next", "Busy", "Done"]);
});

test("a column's menu moves it left and right, with everything under it, and can't move it past either end", async ({ page }) => {
  const note = await open(page, BOARD);
  let menu = await menuFor(page, "To do");
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename", "Move left", "Move right", "Delete"]);
  await expect(menu.getByRole("menuitem", { name: "Move left" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Move right" }).click();
  await expect(titles(page)).toHaveText(["Doing", "To do", "Done"]);
  await expect.poll(() => content(page, note.id)).toBe("## Doing\n- build\n\n## To do {.red}\n- write\n- review\n\n## Done\n");

  menu = await menuFor(page, "Done");
  await expect(menu.getByRole("menuitem", { name: "Move right" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Move left" }).click();
  await expect(titles(page)).toHaveText(["Doing", "Done", "To do"]);
  await expect(column(page, "To do").getByRole("listitem")).toHaveText(["write", "review"]);

  // Rename from the menu opens its name to type in.
  menu = await menuFor(page, "Doing");
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  await expect(editor(page).getByRole("textbox", { name: "Name of Doing" })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("Delete takes an empty column at once, and asks first for one with cards, offering to move them to the column on its left", async ({ page }) => {
  const note = await open(page, BOARD);
  let menu = await menuFor(page, "Done");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(titles(page)).toHaveText(["To do", "Doing"]);

  menu = await menuFor(page, "Doing");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("menu")).toContainText("Delete Doing and its card?");
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await expect(titles(page)).toHaveText(["To do", "Doing"]);

  menu = await menuFor(page, "Doing");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("menuitem", { name: "Move it to To do, and delete Doing" }).click();
  await expect(titles(page)).toHaveText(["To do"]);
  await expect(column(page, "To do").getByRole("listitem")).toHaveText(["write", "review", "build"]);
  await expect.poll(() => content(page, note.id)).toBe("## To do {.red}\n- write\n- review\n- build\n");

  // The first column has nothing on its left: its cards go with it.
  menu = await menuFor(page, "To do");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("menuitem", { name: /^Move/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Delete To do and its cards" }).click();
  await expect(editor(page).locator(".kanban-empty")).toBeVisible();
});

test("with vim on, a column's name and a new column take typing, and the keys are the field's, not vim's", async ({ page }) => {
  const note = await open(page, BOARD, true);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await titles(page).first().focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("jk dd");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["jk dd", "Doing", "Done"]);
  await editor(page).getByRole("button", { name: "Add column" }).click();
  await page.keyboard.type("Later x");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["jk dd", "Doing", "Done", "Later x"]);
  await expect.poll(() => content(page, note.id)).toBe(`${BOARD.replace("## To do {.red}", "## jk dd {.red}")}\n## Later x\n`);
});
