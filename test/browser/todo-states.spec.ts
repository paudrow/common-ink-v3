import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string) => page.locator(".cm-line").filter({ hasText: text }).first();
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const rows = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const words = (page: Page) => rows(page).locator(".todo-words");
const bar = (page: Page) => todosPage(page).getByRole("searchbox", { name: "Filter todos" });
const style = (el: Element, pseudo?: string) => {
  const s = getComputedStyle(el, pseudo);
  return { decoration: s.textDecorationLine, color: s.color, display: s.display, content: s.content, width: el.getBoundingClientRect().width };
};

const CHORES = "# Chores\n\n- [ ] Sweep\n- [-] Paint the fence due:2031-10-14\n- [>] Learn the cello\n- [x] Dust\n";

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  return note;
}

test("in a note, an abandoned todo is struck through, box and words, and one in the backlog is dimmed with a › in a dashed box, each box named by its state", async ({ page }) => {
  await open(page, CHORES);
  const boxes = editor(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(4);
  expect(await boxes.evaluateAll((all) => all.map((box) => [box.getAttribute("aria-label"), (box as HTMLInputElement).checked]))).toEqual([
    ["Not done", false],
    ["Abandoned", false],
    ["Backlog", false],
    ["Done", true],
  ]);

  const abandoned = line(page, "Paint the fence").locator(".md-todo-abandoned");
  await expect(abandoned).toHaveCount(1);
  expect((await abandoned.evaluate(style)).decoration).toBe("line-through");
  // The strike goes through the box, past its sides.
  const box = line(page, "Paint the fence").getByRole("checkbox");
  const strike = await box.evaluate((el) => [getComputedStyle(el.nextElementSibling!).display, el.nextElementSibling!.getBoundingClientRect().width - el.getBoundingClientRect().width]);
  expect(strike[0]).toBe("block");
  expect(strike[1]).toBeGreaterThan(0);

  const backlog = line(page, "Learn the cello").locator(".md-todo-backlog");
  await expect(backlog).toHaveText("Learn the cello");
  const dim = await backlog.evaluate(style);
  expect(dim.decoration).toBe("none");
  expect(dim.color).not.toBe((await line(page, "Sweep").evaluate(style)).color);
  const mark = await line(page, "Learn the cello").getByRole("checkbox").evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el.nextElementSibling!, "::before").content]);
  expect(mark).toEqual(["dashed", '"›"']);

  // An open todo and a done one are drawn as they were.
  await expect(line(page, "Sweep").locator(".md-todo-abandoned, .md-todo-backlog")).toHaveCount(0);
  await expect(line(page, "Dust").locator(".md-todo-abandoned, .md-todo-backlog")).toHaveCount(0);
});

test("in a note, a click on an abandoned or backlogged todo's box opens it again, as the member's edit, undone like typing", async ({ page }) => {
  const note = await open(page, CHORES);
  const lines = async () => (await read(page, note.id)).split("\n").slice(2, 6);

  await line(page, "Paint the fence").getByRole("checkbox").click();
  await expect.poll(lines).toEqual(["- [ ] Sweep", "- [ ] Paint the fence due:2031-10-14", "- [>] Learn the cello", "- [x] Dust"]);
  await expect(line(page, "Paint the fence").getByRole("checkbox")).toHaveAttribute("aria-label", "Not done");
  await expect(line(page, "Paint the fence").locator(".md-todo-abandoned")).toHaveCount(0);

  await line(page, "Learn the cello").getByRole("checkbox").click();
  await expect.poll(lines).toEqual(["- [ ] Sweep", "- [ ] Paint the fence due:2031-10-14", "- [ ] Learn the cello", "- [x] Dust"]);
  await expect(line(page, "Learn the cello").getByRole("checkbox")).not.toBeChecked();
  // Opened, it is checked off by the next click, as any open todo is.
  await line(page, "Learn the cello").getByRole("checkbox").click();
  await expect.poll(lines).toEqual(["- [ ] Sweep", "- [ ] Paint the fence due:2031-10-14", "- [x] Learn the cello", "- [x] Dust"]);

  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(line(page, "Learn the cello").getByRole("checkbox")).toHaveAttribute("aria-label", "Backlog");
});

test("Enter on an abandoned or backlogged todo starts an open todo under it, as it does under an open or done one", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [>] Learn the cello\n1. [-] Paint the fence");
  await line(page, "Learn the cello").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Buy strings");
  await line(page, "Paint the fence").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sand it");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- [>] Learn the cello\n- [ ] Buy strings\n1. [-] Paint the fence\n2. [ ] Sand it");
  await expect(line(page, "Buy strings").getByRole("checkbox")).toHaveAttribute("aria-label", "Not done");
});

test("the Todos page leaves out abandoned and backlogged todos until the query names them, draws each by its state, and its box opens one again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Chores\n\n- [ ] Sweep\n- [x] Dust\n- [-] Paint the fence\n- [>] Learn the cello" });
  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Sweep"]);

  await bar(page).fill("is:abandoned");
  await expect(words(page)).toHaveText(["Paint the fence"]);
  await expect(row(page, "Paint the fence")).toHaveAttribute("data-state", "abandoned");
  await expect(row(page, "Paint the fence").getByRole("checkbox", { name: "Abandoned" })).not.toBeChecked();
  expect((await row(page, "Paint the fence").locator(".todo-words").evaluate(style)).decoration).toBe("line-through");

  await bar(page).fill("is:open OR is:backlog");
  await expect(words(page)).toHaveText(["Sweep", "Learn the cello"]);
  await expect(row(page, "Sweep")).not.toHaveAttribute("data-state");
  await expect(row(page, "Learn the cello")).toHaveAttribute("data-state", "backlog");
  const dim = await row(page, "Learn the cello").locator(".todo-words").evaluate(style);
  expect(dim.decoration).toBe("none");
  expect(dim.color).not.toBe((await row(page, "Sweep").locator(".todo-words").evaluate(style)).color);

  await bar(page).fill("is:backlog");
  await expect(words(page)).toHaveText(["Learn the cello"]);
  await row(page, "Learn the cello").getByRole("checkbox", { name: "Backlog" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[5]).toBe("- [ ] Learn the cello");
  await expect(row(page, "Learn the cello").getByRole("checkbox")).toHaveAttribute("aria-label", "Not done");
  await expect(row(page, "Learn the cello")).not.toHaveAttribute("data-state");

  await bar(page).fill("");
  await expect(words(page)).toHaveText(["Sweep", "Learn the cello"]);
});
