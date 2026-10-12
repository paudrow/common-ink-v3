import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";
import { openDetails, pluginRow } from "./plugins-helpers.ts";

const bar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const boxOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return [x, y, width, height] as [number, number, number, number];
    });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();
  return note;
}

test("the bottom bar is one thin line along the foot of the window, under the sidebar, the editor area and the inspector", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  await expect(bar(page)).toBeVisible();

  const window = page.viewportSize()!;
  const [x, y, width, height] = await boxOf(page, ".bar");
  expect([x, width, y + height]).toEqual([0, window.width, window.height]);
  expect(height).toBeGreaterThanOrEqual(22);
  expect(height).toBeLessThanOrEqual(28);
  for (const above of [".sidebar", "main", ".inspector"]) {
    const [, top, , tall] = await boxOf(page, above);
    expect(top + tall, above).toBeLessThanOrEqual(y);
  }
});

test("Word count shows the words and reading time of the note in front as it is typed, and nothing with no note in front", async ({ page }) => {
  const note = await open(page, "# Tea\n\nSteep the leaves.\n");
  const words = bar(page).getByLabel("Word count");

  await expect(words).toHaveText("4 words · 1 min read");
  await expect(words).toBeInViewport({ ratio: 1 });
  // It is at the right end, as an editor's status bar has it.
  const [x, , width] = await boxOf(page, ".bar [aria-label='Word count']");
  expect(page.viewportSize()!.width - (x + width)).toBeLessThan(24);
  const [, , , height] = await boxOf(page, ".bar");
  const main = await boxOf(page, "main");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Then pour it out.");
  await expect(words).toHaveText("8 words · 1 min read");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("Then pour it out.");

  // A page in front is no note, so there is no count. The bar keeps its height, and nothing above it moves.
  await page.goto("/history");
  await expect(bar(page)).toBeVisible();
  await expect(words).toHaveCount(0);
  expect((await boxOf(page, ".bar"))[3]).toBe(height);
  expect((await boxOf(page, "main"))[3]).toBe(main[3]);
  await page.goto("/folder/all");
  await expect(page.getByRole("navigation", { name: "Notes" })).toBeVisible();
  await expect(words).toHaveCount(0);
});

test("Word count says how many of the note's words are selected while some are, and the note's count again once none are", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  const words = bar(page).getByLabel("Word count");
  await expect(words).toHaveText("4 words · 1 min read");

  await page.locator(".cm-line", { hasText: "Steep the leaves." }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(words).toHaveText("3 of 4 words selected");
  await page.keyboard.press("ControlOrMeta+a");
  await expect(words).toHaveText("4 of 4 words selected");
  await page.keyboard.press("ArrowRight");
  await expect(words).toHaveText("4 words · 1 min read");
});

test("with Word count turned off nothing is left in the bar, so there is no bar, and its own page says what it adds", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  await expect(bar(page).getByLabel("Word count")).toBeVisible();
  const withBar = await boxOf(page, "main");

  await page.goto("/plugins");
  await openDetails(page, "Word count");
  await expect(page.getByRole("group", { name: "Views" })).toContainText("The bottom bar");
  await page.getByRole("checkbox", { name: "Word count" }).uncheck();
  await expect(bar(page)).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(editor(page)).toBeVisible();
  expect((await boxOf(page, "main"))[3]).toBeGreaterThan(withBar[3]);

  await page.goto("/plugins");
  await pluginRow(page, "Word count").getByRole("checkbox").check();
  await expect(bar(page)).toBeVisible();
});

test("any plugin puts an item in the bottom bar, at the left or the right end and in the order it asks for", async ({ page }) => {
  await page.addInitScript(() => {
    type Register = (slot: string, view: unknown) => void;
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register: Register } }) {
          host.views.register("bar", { id: "second", order: 2, component: () => "second" });
          host.views.register("bar", { id: "first", order: 1, component: ({ app }: { app: { noteId: string | null } }) => (app.noteId ? "first, on a note" : "first") });
          host.views.register("bar", { id: "plain", component: () => "plain" });
          host.views.register("bar", { id: "far", side: "right", order: 9, component: () => "far" });
          host.views.register("bar", { id: "near", side: "right", order: -1, component: () => "near" });
          host.views.register("bar", { id: "broken", component: () => { throw new Error("a bar item that throws"); } });
        },
      },
    ];
  });
  page.removeAllListeners("pageerror");
  await open(page, "# Tea\n\nSteep the leaves.\n");

  // Left to right: the left end by order, then the right end by order, with what the app's own plugins put there in between.
  await expect(bar(page).locator("[data-bar-item]:not(:empty)")).toHaveText(["plain", "first, on a note", "second", "near", "4 words · 1 min read", "far"]);
  const places = await bar(page)
    .locator("[data-bar-item]:not(:empty)")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().x)));
  expect(places).toEqual([...places].sort((a, b) => a - b));
  const [second, near] = [places[2]!, places[3]!];
  expect(near - second).toBeGreaterThan(300);
  // One that throws is left out, and the rest of the bar and the app are as they were.
  await expect(editor(page)).toBeVisible();

  await page.goto("/plugins");
  await openDetails(page, "Fixture");
  await expect(page.getByRole("group", { name: "Views" }).getByText("The bottom bar")).toHaveCount(6);
});

test("in focus there is no bottom bar, and it is back, as it was, on leaving", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  const before = await boxOf(page, ".bar");
  await expect(bar(page)).toBeVisible();

  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect(bar(page)).toBeHidden();
  const window = page.viewportSize()!;
  const filled = await page
    .locator(".group-body")
    .filter({ visible: true })
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect(filled).toBe(window.height);

  await page.keyboard.press("ControlOrMeta+.");
  await expect(bar(page)).toBeVisible();
  expect(await boxOf(page, ".bar")).toEqual(before);
  await expect(bar(page).getByLabel("Word count")).toHaveText("4 words · 1 min read");
});
