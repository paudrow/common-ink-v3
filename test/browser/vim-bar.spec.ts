import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const statusLine = (page: Page, group = 0) => page.locator(".cm-vim-panel").nth(group);
const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await page.keyboard.press("Enter");
};
const box = async (page: Page, selector: string, nth = 0) => (await page.locator(selector).nth(nth).boundingBox())!;
/** Where the first letter of the line that says `word` is. */
const placeOf = (page: Page, word: string) =>
  page.evaluate((w) => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(w))!;
    const rect = line.getBoundingClientRect();
    return { x: rect.x, top: rect.top, height: rect.height };
  }, word);

async function withVim(page: Page, text: string, settings: Record<string, unknown> = {}) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true, ...settings }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await editor(page).click();
  return note;
}

const LONG = "A long line that wraps onto more rows because it has so very many words in it, far more than fit in one row of a note's column however wide the window, so it wraps at least twice and then goes on a little more to be sure of it.";

test("vim's mode bar is at the foot of the note's pane, and nothing above it moves as what it says changes", async ({ page }) => {
  await withVim(page, "# Short\n\nOne line of text.");
  const pane = await box(page, ".note");
  const bar = await box(page, ".cm-vim-panel");
  const last = await placeOf(page, "One line");

  // Far below the text, at the very bottom of the pane, as wide as the pane.
  expect(Math.abs(bar.y + bar.height - (pane.y + pane.height)), "the bar's bottom is the pane's bottom").toBeLessThanOrEqual(1);
  expect(Math.abs(bar.width - pane.width), "the bar is as wide as the pane").toBeLessThanOrEqual(1);
  expect(bar.y - (last.top + last.height), "the bar is not right under the text").toBeGreaterThan(200);

  // The bar is one height whatever it says, and the text stays put: insert mode, a count and an operator half typed, the : prompt, a search.
  const steady = async (when: string) => {
    const now = await box(page, ".cm-vim-panel");
    expect(Math.abs(now.y - bar.y), `the bar's top ${when}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(now.height - bar.height), `the bar's height ${when}`).toBeLessThanOrEqual(0.5);
    const line = await placeOf(page, "One line");
    for (const side of ["x", "top", "height"] as const) expect(Math.abs(line[side] - last[side]), `${side} of the text ${when}`).toBeLessThanOrEqual(0.5);
  };
  await page.keyboard.press("i");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await steady("in insert mode");
  await page.keyboard.press("Escape");
  await keys(page, "2", "d");
  await expect(statusLine(page)).toContainText("2d");
  await steady("with a command half typed");
  await page.keyboard.press("Escape");
  await page.keyboard.press(":");
  await expect(statusLine(page).locator("input")).toBeFocused();
  await steady("with the : prompt open");
  await page.keyboard.type("a long command typed into the prompt that goes on and on and on");
  await steady("with a long command typed");
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await expect(statusLine(page)).toHaveText("--VISUAL--");
  await steady("in visual mode");
  await page.keyboard.press("Escape");

  // Writing mode: still the foot of the pane.
  await run(page, "Toggle writing mode");
  await editor(page).click();
  const writing = { pane: await box(page, ".note"), bar: await box(page, ".cm-vim-panel") };
  expect(Math.abs(writing.bar.y + writing.bar.height - (writing.pane.y + writing.pane.height))).toBeLessThanOrEqual(1);
});

test("a long note scrolls under the mode bar, which stays at the foot of the pane", async ({ page }) => {
  await withVim(page, `# Long\n\n${Array.from({ length: 200 }, (_, n) => `Line ${n}`).join("\n\n")}`);
  const pane = await box(page, ".note");
  const at = async () => {
    const bar = await box(page, ".cm-vim-panel");
    return bar.y + bar.height - (pane.y + pane.height);
  };
  expect(Math.abs(await at())).toBeLessThanOrEqual(1);
  await page.keyboard.press("Shift+G");
  // The editor scrolls to the cursor a frame after G moves it, and goes on measuring its lines and scrolling after that, so each place is read until it has settled.
  await expect(page.locator(".cm-line").filter({ hasText: /^Line 199$/ })).toBeInViewport();
  await expect.poll(async () => Math.abs(await at())).toBeLessThanOrEqual(1);
  // The last line is above the bar, not behind it.
  const under = async () => {
    const last = await placeOf(page, "Line 199");
    return last.top + last.height - (await box(page, ".cm-vim-panel")).y;
  };
  await expect.poll(under, "the last line's bottom is above the bar's top").toBeLessThanOrEqual(1);
});

for (const side of ["right", "down"] as const) {
  test(`each side of a split ${side} has its own mode bar at its own foot`, async ({ page }) => {
    await withVim(page, "# Left\n\nShort.");
    await perform(page, { type: "note.create", text: "# Right\n\nShort too." });
    await run(page, "Keep tab open");
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("Right");
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Right");
    await page.keyboard.press("Enter");
    await run(page, `Split editor ${side}`);
    await expect(editor(page, 1)).toContainText("Right");
    await expect(page.locator(".cm-vim-panel")).toHaveCount(2);
    const main = await box(page, "main");
    for (const n of [0, 1]) {
      const pane = await box(page, ".note", n);
      const bar = await box(page, ".cm-vim-panel", n);
      const group = await box(page, '[aria-label^="Editor group"]', n);
      expect(Math.abs(pane.y + pane.height - (group.y + group.height)), `pane ${n}: the note ends where its side of the split does`).toBeLessThanOrEqual(1);
      if (side === "down") expect(group.height, `pane ${n}: its side is about half the window's height`).toBeLessThan(main.height * 0.6);
      expect(Math.abs(bar.y + bar.height - (pane.y + pane.height)), `pane ${n}: the bar's bottom is the pane's`).toBeLessThanOrEqual(1);
      expect(Math.abs(bar.x - pane.x), `pane ${n}: the bar starts at the pane's left`).toBeLessThanOrEqual(1);
      expect(Math.abs(bar.width - pane.width), `pane ${n}: the bar is as wide as the pane`).toBeLessThanOrEqual(1);
    }
    // Each says its own editor's mode.
    await editor(page, 1).click();
    await page.keyboard.press("i");
    await expect(statusLine(page, 1)).toHaveText("--INSERT--");
    await expect(statusLine(page, 0)).toHaveText("--NORMAL--");
    await expect(group(page, 2)).toBeVisible();
  });
}

for (const vim of [true, false]) {
  test(`a click in the empty room below a note's text puts the cursor at the note's end${vim ? ", in vim mode" : ""}`, async ({ page }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
    const note = await perform(page, { type: "note.create", text: "# Short\n\nfirst\n\nlast words" });
    await page.goto(`/note/${note.id}`);
    await expect(editor(page)).toContainText("last words");
    const pane = await box(page, ".note-scroll");
    const text = await placeOf(page, "last words");

    // Far below the last line, well inside the pane, and off to the side of the text's column too.
    for (const [x, y] of [[pane.x + pane.width / 2, pane.y + pane.height - 30], [pane.x + 12, text.top + text.height + 150]] as const) {
      await page.keyboard.press("ControlOrMeta+Home");
      await page.mouse.click(x, y);
      await expect(editor(page)).toBeFocused();
      if (vim) await page.keyboard.press("a");
      await page.keyboard.type("!");
      if (vim) await page.keyboard.press("Escape");
      await expect(page.locator(".cm-line").last()).toHaveText(/last words!+$/);
    }
    await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Short\n\nfirst\n\nlast words!!");
  });
}

test("with the setting on, j and k move by the rows on screen and dj still takes whole lines; off, they move by lines", async ({ page }) => {
  const note = await withVim(page, `# Rows\n\n${LONG}\n\nafter\nlast`, { "vim.screenLines": true });
  const cursorTop = () => page.evaluate(() => Math.round(document.querySelector(".cm-fat-cursor")!.getBoundingClientRect().top));
  const lineTop = async () => Math.round((await placeOf(page, "A long line")).top);

  await keys(page, "g", "g", "j", "j");
  await expect.poll(async () => Math.abs((await cursorTop()) - (await lineTop())), "two j reach the long line's first row").toBeLessThanOrEqual(3);
  const first = await cursorTop();
  await page.keyboard.press("j");
  await expect.poll(cursorTop, "j goes to the second row of the wrapped line").toBeGreaterThan(first + 10);
  await expect(page.locator(".cm-fat-cursor")).not.toHaveText("");
  const second = await cursorTop();
  expect((await placeOf(page, "A long line")).height).toBeGreaterThan(second - first + 10);
  await page.keyboard.press("k");
  await expect.poll(cursorTop, "k goes back up a row").toBe(first);

  // After an operator j is lines still: dj on the long line takes it and the line after, whole.
  await keys(page, "d", "j");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Rows\n\nafter\nlast");
  await page.keyboard.press("u");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`# Rows\n\n${LONG}\n\nafter\nlast`);

  // Off, which is the default: one j passes the whole wrapped line. It reaches the open editor without a reload.
  const settings = await perform(page, { type: "settings.read" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: settings.revision });
  await page.goto("/settings/plugins/vim");
  await expect(page.getByRole("region", { name: "Vim mode", exact: true })).toContainText("j and k move by the rows on screen");
  await page.goBack();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await editor(page).click();
  await keys(page, "g", "g", "j", "j");
  const top = await cursorTop();
  await page.keyboard.press("j");
  await expect.poll(async () => (await cursorTop()) - top, "j passes every row of the wrapped line").toBeGreaterThan((await placeOf(page, "A long line")).height - 5);
});

test("line numbers are shown by a setting, beside the text and off the text's own column: the text moves by the numbers' width, once, and by nothing else", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Numbered\n\n${LONG}\n\n${Array.from({ length: 8 }, (_, n) => `row ${n}`).join("\n")}` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("row 7");
  const words = ["Numbered", "A long line", "row 0", "row 7"];
  const places = async () => Object.fromEntries(await Promise.all(words.map(async (w) => [w, await placeOf(page, w)] as const)));
  const off = await places();
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);

  await page.goto("/plugins");
  await page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Line numbers", exact: true }).check();
  await page.goBack();
  await expect(page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^12$/ })).toBeVisible();
  const on = await places();
  const gutter = await box(page, ".cm-lineNumbers");
  const shift = on["Numbered"]!.x - off["Numbered"]!.x;
  expect(Math.abs(shift - gutter.width), `the text moved right by ${shift}px, the numbers' width is ${gutter.width}px`).toBeLessThanOrEqual(1);
  for (const word of words) expect(Math.abs(on[word]!.x - off[word]!.x - shift), `"${word}" moved as the title did`).toBeLessThanOrEqual(1);
  // A wrapped line has one number, level with its first row.
  const three = await page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^3$/ }).boundingBox();
  expect(Math.abs(three!.y - on["A long line"]!.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(three!.height - on["A long line"]!.height)).toBeLessThanOrEqual(2);

  // The numbers' column is one width however many lines there are, so the text never moves as a note grows.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < 95; i++) await page.keyboard.press("Enter");
  await expect(page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^107$/ })).toBeVisible();
  await page.locator(".note-scroll").evaluate((el) => (el.scrollTop = 0));
  const grown = await places();
  for (const word of words) expect(Math.abs(grown[word]!.x - on[word]!.x), `"${word}" after the note grew past 100 lines`).toBeLessThanOrEqual(0.5);
});
