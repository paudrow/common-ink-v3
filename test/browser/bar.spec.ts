import { expect, type Page } from "@playwright/test";
import { ownPlugin, perform, pinPanel, signInAsNewPerson, test } from "./helpers.ts";
import { openDetails, pluginRow } from "./plugins-helpers.ts";

const bar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
/** Word count runs shut off from the app, in a frame of its own in the bar: what it says is in that frame, and where it is is the frame's place. */
const wordCount = (page: Page) => ownPlugin(page, "Word count").getByLabel("Word count");
const WORDS = ".bar [data-bar-item='word-count']";
/** The items that have something to say, as the bar lays them out: one whose frame has drawn nothing takes no room. */
const SAYING = "[data-bar-item]:not(:empty):not(:has(.bar-frame[data-empty]))";
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
  await pinPanel(page, "Info");
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
  const words = wordCount(page);

  await expect(words).toHaveText("4 words · 1 min read");
  await expect(words).toBeInViewport({ ratio: 1 });
  // It is at the right end, as an editor's status bar has it.
  const [x, , width] = await boxOf(page, WORDS);
  expect(page.viewportSize()!.width - (x + width)).toBeLessThan(24);
  // Its frame is as wide as what it says, and not the most its manifest lets it be.
  expect(width).toBeGreaterThan(80);
  expect(width).toBeLessThan(200);
  const [, , , height] = await boxOf(page, ".bar");
  const main = await boxOf(page, "main");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Then pour it out.");
  await expect(words).toHaveText("8 words · 1 min read");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("Then pour it out.");

  // A page in front is no note, so there is no count, with the note still open in a tab behind it. The bar keeps its height, and nothing above it moves.
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("tab", { name: "Calendar" })).toHaveAttribute("aria-selected", "true");
  await expect(bar(page)).toBeVisible();
  await expect(words).toHaveCount(0);
  // With nothing to say its frame takes no room, as any item with nothing to say.
  await expect(bar(page).locator(SAYING)).toHaveAttribute("data-bar-item", "coin");
  await expect(bar(page).locator(WORDS)).toBeHidden();
  expect((await boxOf(page, ".bar"))[3]).toBe(height);
  expect((await boxOf(page, "main"))[3]).toBe(main[3]);
  await page.goto("/folder/all");
  await expect(page.getByRole("navigation", { name: "Notes" })).toBeVisible();
  await expect(words).toHaveCount(0);
});

test("Word count says how many of the note's words are selected while some are, and the note's count again once none are", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  const words = wordCount(page);
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

test("with a note in two editors, Word count reads the one the member is in, and goes on counting when that one closes", async ({ page }) => {
  await page.addInitScript(() => {
    type Shown = { panes: string[] };
    const shown = window as unknown as Shown & { __INK_FIXTURE_PLUGINS__: unknown[] };
    shown.panes = ["first"];
    // The app's own tabs keep a note to one group, so another editor area stands in: the same note once for each pane named.
    const pane = (name: string, children: unknown) => ({ $$typeof: Symbol.for("react.transitional.element"), type: "div", key: name, ref: null, props: { "data-pane": name, style: { height: "50%" }, children }, _store: { validated: 1 } });
    shown.__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          host.views.register("editor", {
            id: "twice",
            component: ({ app, renderNote }: { app: { noteId: string | null }; renderNote(id: string): unknown }) => (app.noteId ? shown.panes.map((name) => pane(name, renderNote(app.noteId!))) : null),
          });
        },
      },
    ];
  });
  await open(page, "# Tea\n\nSteep the leaves.\n");
  const words = wordCount(page);
  const line = (name: string) => page.locator(`[data-pane=${name}] .cm-line`, { hasText: "Steep the leaves." });
  /** Draws the panes named: the sidebar's key has the app draw again, and moves the caret nowhere. */
  const show = async (...panes: string[]) => {
    await page.evaluate((names) => ((window as unknown as { panes: string[] }).panes = names), panes);
    await page.keyboard.press("ControlOrMeta+\\");
    await expect(page.locator("[data-pane]")).toHaveCount(panes.length);
  };

  await line("first").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(words).toHaveText("3 of 4 words selected");

  // A second editor on the note, opened while the first is being written in, takes nothing over.
  await show("first", "second");
  await expect(line("second")).toBeVisible();
  await expect(words).toHaveText("3 of 4 words selected");
  await line("second").click();
  await expect(words).toHaveText("4 words · 1 min read");
  await page.keyboard.press("ControlOrMeta+a");
  await expect(words).toHaveText("4 of 4 words selected");

  // The one being written in closes, and the note is still open in the other, with what is selected there.
  await show("first");
  await expect(words).toHaveText("3 of 4 words selected");
  await show();
  await expect(words).toHaveCount(0);
});

test("with Word count turned off, and the clocks that share the bar, nothing is left in it, so there is no bar, and its own page says what it adds", async ({ page }) => {
  await open(page, "# Tea\n\nSteep the leaves.\n");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "note-clocks.enabled": false, "quick-timer.enabled": false, "uploads.enabled": false, "coin.enabled": false }), baseRevision: 0 });
  await page.reload();
  await expect(wordCount(page)).toBeVisible();
  const withBar = await boxOf(page, "main");

  await page.goto("/plugins");
  await openDetails(page, "Word count");
  await expect(page.getByRole("group", { name: "Views" })).toContainText("The bottom bar");
  await page.getByRole("checkbox", { name: "Word count" }).uncheck();
  await expect(bar(page)).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(editor(page)).toBeVisible();
  // With a note in front the bar stays, to say whether it is saved.
  await expect(bar(page).locator(SAYING)).toHaveCount(0);
  await expect(bar(page).getByRole("status")).toHaveText("Saved");
  expect((await boxOf(page, "main"))[3]).toBe(withBar[3]);

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
          host.views.register("bar", { id: "plain-too", component: () => "plain too" });
          host.views.register("bar", { id: "also-first", order: 1, component: () => "also first" });
          host.views.register("bar", { id: "far", side: "right", order: 9, component: () => "far" });
          host.views.register("bar", { id: "near", side: "right", order: -1, component: () => "near" });
          host.views.register("bar", { id: "broken", component: () => { throw new Error("a bar item that throws"); } });
        },
      },
    ];
  });
  page.removeAllListeners("pageerror");
  await open(page, "# Tea\n\nSteep the leaves.\n");

  // Left to right: the left end by order, those of one order as they were registered, then the right end by order, with what the app's own plugins put there in between.
  await expect(wordCount(page)).toHaveText("4 words · 1 min read");
  await expect(bar(page).locator(SAYING)).toHaveText(["", "plain", "plain too", "first, on a note", "also first", "second", "near", "", "far"]);
  expect(await bar(page).locator(SAYING).evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.barItem))).toEqual(["coin", "plain", "plain-too", "first", "also-first", "second", "near", "word-count", "far"]);
  const places = await bar(page)
    .locator(SAYING)
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().x)));
  expect(places).toEqual([...places].sort((a, b) => a - b));
  const [second, near] = [places[5]!, places[6]!];
  expect(near - second).toBeGreaterThan(300);
  // One that throws is left out, and the rest of the bar and the app are as they were.
  await expect(editor(page)).toBeVisible();

  await page.goto("/plugins");
  await openDetails(page, "Fixture");
  await expect(page.getByRole("group", { name: "Views" }).getByText("The bottom bar")).toHaveCount(8);
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
  await expect(wordCount(page)).toHaveText("4 words · 1 min read");
});

test("in a window too narrow for both ends of the bar, the right end is whole and the left end is cut short inside the bar", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          for (const id of ["one", "two", "three"]) host.views.register("bar", { id, component: () => `a long thing to say at the left end, ${id}` });
        },
      },
    ];
  });
  await page.setViewportSize({ width: 420, height: 700 });
  await open(page, "# Tea\n\nSteep the leaves.\n");

  await expect(wordCount(page)).toBeInViewport({ ratio: 1 });
  const [, , width] = await boxOf(page, ".bar");
  expect(width).toBe(420);
  const [leftX, , leftWidth] = await boxOf(page, ".bar-side[data-side=left]");
  const [wordsX] = await boxOf(page, WORDS);
  expect(leftX + leftWidth).toBeLessThanOrEqual(wordsX);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(420);
});

test("with vim on, the bottom bar, vim's bar and a notice each keep their own place: vim's above the bar, the notice above both and saying what it is for", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Feet\n\nSome words to count." });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await expect(wordCount(page)).toHaveText(/words/);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Archive or unarchive note");
  await page.keyboard.press("Enter");
  const notice = page.getByRole("group", { name: "Notice" }).last();
  await expect(notice).toContainText("Archived");
  await expect(notice.getByRole("button", { name: "Undo" })).toBeVisible();
  // Each box once the notice has finished arriving.
  await page.waitForTimeout(400);
  const [barBox, vimBox, noticeBox] = await Promise.all([boxOf(page, ".bar"), boxOf(page, ".note-foot .cm-vim-panel"), boxOf(page, ".toast-card")]);
  const bottom = ([, y, , h]: [number, number, number, number]) => y + h;
  expect(bottom(vimBox), "vim's bar ends where the bottom bar begins").toBeLessThanOrEqual(barBox[1] + 0.5);
  expect(bottom(noticeBox), "the notice is above vim's bar").toBeLessThanOrEqual(vimBox[1]);
  // Nothing at the notice's corners but the notice itself.
  for (const [x, y] of [
    [noticeBox[0] + 14, noticeBox[1] + 14],
    [noticeBox[0] + noticeBox[2] - 14, noticeBox[1] + noticeBox[3] - 14],
  ])
    expect(await page.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest(".toast-card"), [x, y])).toBe(true);
});
