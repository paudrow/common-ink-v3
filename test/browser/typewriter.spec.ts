import { expect, test, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson } from "./helpers.ts";

type Place = { share: number; middle: number; size: number; height: number; scrolled: "top" | "end" | "between" } | null;
declare global {
  interface Window {
    lineIn(words: string, group: number): Place;
    noted: Place[][];
    noting: number;
  }
}

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Where the line that starts with `words` is in the pane of the group-th note on screen: its middle in pixels from the pane's top and as a share of the pane's height, its own height and the pane's, and whether the pane is scrolled to an end. Null when the line isn't drawn.
  await page.addInitScript(() => {
    window.lineIn = (words, group) => {
      const pane = [...document.querySelectorAll<HTMLElement>(".note-scroll")].filter((el) => el.getBoundingClientRect().width > 0)[group];
      const found = pane && [...pane.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.startsWith(words));
      if (!pane || !found) return null;
      const rect = found.getBoundingClientRect();
      const middle = (rect.top + rect.bottom) / 2 - pane.getBoundingClientRect().top - pane.clientTop;
      const scrolled = pane.scrollTop < 1 ? "top" : pane.scrollTop + pane.clientHeight > pane.scrollHeight - 1 ? "end" : "between";
      return { middle, share: middle / pane.clientHeight, size: rect.height, height: pane.clientHeight, scrolled };
    };
  });
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};

const LINES = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the note.`);
const line = (n: number) => `Line ${n} of`;

const place = (page: Page, words: string, group = 0) => page.evaluate(([w, g]) => window.lineIn(w, g), [words, group] as const);
/** How many pixels the line that starts with `words` is from the height `at` of its pane, where 0 has its top at the pane's top and 1 its foot at the foot. */
const awayFrom = async (page: Page, words: string, at: number, group = 0) => {
  const where = await place(page, words, group);
  if (!where) return Infinity;
  const aim = Math.min(Math.max(at * where.height, where.size / 2), where.height - where.size / 2);
  return Math.abs(where.middle - aim);
};
const held = (page: Page, words: string, at = 0.5, group = 0) => expect.poll(() => awayFrom(page, words, at, group), `${words} is held at ${at * 100}% of pane ${group}`).toBeLessThanOrEqual(4);

const frames = (page: Page, count: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const tick = (left: number) => (left ? requestAnimationFrame(() => tick(left - 1)) : done());
        tick(n);
      }),
    count,
  );

/**
 * Notes where each of `lines`, as words and group, is in every frame drawn from now until the returned function is called and 15
 * frames more, and gives each line's middles in order. Each is read once the frame is drawn.
 */
async function watch(page: Page, ...lines: (readonly [string, number])[]) {
  await page.evaluate((watched) => {
    window.noted = [];
    const noting = (window.noting = (window.noting ?? 0) + 1);
    const next = () =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (window.noting !== noting) return;
          window.noted.push(watched.map(([words, group]) => window.lineIn(words, group)));
          next();
        }),
      );
    next();
  }, lines);
  await frames(page, 2);
  return async () => {
    await frames(page, 15);
    const noted = await page.evaluate(() => {
      window.noting++;
      return window.noted;
    });
    return lines.map((_, i) => noted.map((frame) => frame[i]?.middle ?? null));
  };
}
/**
 * What a line did across the frames watched: each frame reads "before" while the line is within 4 pixels of where it began, "after"
 * within 4 of where it ended, and its middle anywhere else, with repeats left out. One that went to its place in one step reads
 * before then after, and one that didn't move reads only after.
 */
const steps = (middles: (number | null)[]) => {
  const [first, last] = [middles[0], middles.at(-1)];
  const named = middles.map((m) => (m == null || first == null || last == null ? "not drawn" : Math.abs(m - last) <= 4 ? "after" : Math.abs(m - first) <= 4 ? "before" : Math.round(m)));
  return named.filter((n, i) => n !== named[i - 1]);
};

/** What the member's settings have, as the server keeps them. */
const kept = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text || "{}") as Record<string, unknown>;
/** The height kept, which is not written while it is the default. */
const height = async (page: Page) => (await kept(page))["typewriter.height"] ?? 50;

async function open(page: Page, settings: Record<string, unknown>, text = LINES.join("\n")) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (Object.keys(settings).length) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  await page.evaluate(() => document.fonts.ready);
  return note;
}
const typewriter = (more: Record<string, unknown> = {}) => ({ "typewriter.enabled": true, ...more });

/** Opens a second note of 80 lines that start with "Right" and splits the editor, and says what the lines on the left start with. */
async function split(page: Page) {
  await perform(page, { type: "note.create", text: LINES.map((l) => `Right ${l}`).join("\n") });
  await runCommand(page, "Keep tab open");
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("Right Line 1");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Right");
  await page.keyboard.press("Enter");
  await runCommand(page, "Split editor right");
  await expect(editor(page, 1)).toContainText("Right Line 1");
  return (await editor(page, 0).textContent())!.startsWith("Right") ? "Right Line" : "Line";
}

test("off by default, it moves nothing: the first line stays where it was and moving down doesn't scroll", async ({ page }) => {
  await open(page, {});
  const before = (await place(page, line(1)))!;
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(0);
  await page.locator(".cm-line").first().click();
  await keys(page, "ControlOrMeta+Home", "ArrowDown", "ArrowDown", "ArrowDown");
  expect(await place(page, line(1)), "the first line is where it was").toEqual(before);
});

test("on, the cursor's line stays in the middle as the cursor moves and the member types, and the first and last lines can be there too", async ({ page }) => {
  await open(page, typewriter());
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  await held(page, line(1));
  for (const n of [2, 3, 4, 5, 6]) {
    await keys(page, "ArrowDown");
    await held(page, line(n));
  }
  await keys(page, "End", "Enter");
  await page.keyboard.type("A new line under line 6.");
  await held(page, "A new line under");
  await keys(page, "Enter");
  await page.keyboard.type("And one more.");
  await held(page, "And one more.");
  expect(await awayFrom(page, line(6), 0.5), "the line above has moved up").toBeGreaterThan(20);
  await keys(page, "ControlOrMeta+End");
  await held(page, line(80));
  await keys(page, "ArrowUp", "ArrowUp");
  await held(page, line(78));
});

for (const at of [0, 0.5, 1])
  test(`a heading is held by its whole line at ${at * 100}%, as the first line and as the last`, async ({ page }) => {
    await open(page, typewriter({ "typewriter.height": at * 100 }), ["# A heading first", ...LINES.slice(0, 30), "# A heading last"].join("\n"));
    await editor(page).click();
    await keys(page, "ControlOrMeta+Home");
    await held(page, "# A heading first", at);
    await keys(page, "ArrowDown");
    await held(page, line(1), at);
    await keys(page, "ControlOrMeta+End");
    await held(page, "# A heading last", at);
    await keys(page, "ArrowUp");
    await held(page, line(30), at);
  });

test("its key turns it off with the cursor's line left where it is on screen, and on again brings the line to its height in one step", async ({ page }) => {
  await open(page, typewriter());
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  for (let n = 0; n < 29; n++) await keys(page, "ArrowDown");
  await held(page, line(30));

  let stop = await watch(page, [line(30), 0]);
  await keys(page, "ControlOrMeta+Shift+Y");
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(0);
  await expect.poll(async () => (await kept(page))["typewriter.on"]).toBe(false);
  expect(steps((await stop())[0]!), "the line didn't move").toEqual(["after"]);
  await held(page, line(30));

  stop = await watch(page, [line(30), 0]);
  await keys(page, "ControlOrMeta+Shift+Y");
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(1);
  expect(steps((await stop())[0]!), "nor did it turning on again, already at its height").toEqual(["after"]);

  await keys(page, "ControlOrMeta+End");
  await held(page, line(80));
  stop = await watch(page, [line(80), 0]);
  await keys(page, "ControlOrMeta+Shift+Y");
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(0);
  expect(steps((await stop())[0]!), "the last line went down in one step").toEqual(["before", "after"]);
  expect((await place(page, line(80)))!.scrolled, "only as far as the editor's own room under the last line lets it").toBe("end");

  await keys(page, "ControlOrMeta+Home");
  const first = (await place(page, line(1)))!;
  expect(first.middle - first.size / 2, "with no room above, the first line is at the top").toBeLessThanOrEqual(8);
  await keys(page, "ArrowDown", "ArrowDown");
  expect(await awayFrom(page, line(3), 0.5), "the line is not held").toBeGreaterThan(40);

  stop = await watch(page, [line(3), 0]);
  await keys(page, "ControlOrMeta+Shift+Y");
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(1);
  await held(page, line(3));
  expect(steps((await stop())[0]!), "on again, the line went to its height in one step").toEqual(["before", "after"]);
});

test("turned off near the top, the cursor's line goes up only as far as the top of the note lets it", async ({ page }) => {
  await open(page, typewriter());
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home", "ArrowDown", "ArrowDown");
  await held(page, line(3));
  const stop = await watch(page, [line(3), 0]);
  await keys(page, "ControlOrMeta+Shift+Y");
  await expect(page.locator(".cm-editor.cm-typewriter")).toHaveCount(0);
  expect(steps((await stop())[0]!), "the line went up in one step").toEqual(["before", "after"]);
  expect((await place(page, line(3)))!.scrolled, "the note is scrolled to its top, the room above being gone").toBe("top");
});

test("the line is held at the height set, and keeping it where it is now sets the height to there without moving it", async ({ page }) => {
  await open(page, typewriter({ "typewriter.height": 30 }));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  await held(page, line(1), 0.3);
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) await keys(page, "ArrowDown");
  await held(page, line(12), 0.3);

  const pane = page.locator(".note-scroll");
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -150);
  await expect.poll(async () => (await place(page, line(12)))!.share, "the wheel moved the line down").toBeGreaterThan(0.45);
  const there = (await place(page, line(12)))!;
  const stop = await watch(page, [line(12), 0]);
  await runCommand(page, "Typewriter: keep the line at this height");
  await expect.poll(async () => Math.abs(((await kept(page))["typewriter.height"] as number) - there.share * 100), "the height is where the line was").toBeLessThanOrEqual(1);
  const set = (await kept(page))["typewriter.height"] as number;
  expect(steps((await stop())[0]!), "the line did not move").toEqual(["after"]);
  expect(await awayFrom(page, line(12), there.share), "the line is where it was").toBeLessThanOrEqual(4);
  await editor(page).focus();
  await keys(page, "ArrowDown");
  await held(page, line(13), set / 100);
});

test("a new text size set in Settings brings the line back to its height in the note being written in, but not once the wheel has moved it", async ({ page }) => {
  await open(page, typewriter({ "typewriter.height": 30 }));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  for (let n = 0; n < 29; n++) await keys(page, "ArrowDown");
  await held(page, line(30), 0.3);
  const before = (await place(page, line(30)))!.size;
  const size = async (percent: number) => {
    await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: /Ada/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Editor" }).click();
    const field = dialog.getByRole("spinbutton", { name: "Editor text size" });
    await field.fill(String(percent));
    await keys(page, "Enter");
    await expect.poll(async () => Math.abs((await place(page, line(30)))!.size - (before * percent) / 100), `the text is at ${percent}%`).toBeLessThan(2);
    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
  };
  await size(150);
  await held(page, line(30), 0.3);

  const box = (await page.locator(".note-scroll").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => awayFrom(page, line(30), 0.3), "the wheel moved the line down").toBeGreaterThan(100);
  await size(100);
  await frames(page, 10);
  expect(await awayFrom(page, line(30), 0.3), "the line is not brought back after the wheel").toBeGreaterThan(40);
});

test("a new text size keeps the line at its height in the note with focus, or brings it back in the next frame", async ({ page }) => {
  await open(page, typewriter({ "typewriter.height": 30 }));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  for (let n = 0; n < 29; n++) await keys(page, "ArrowDown");
  await held(page, line(30), 0.3);
  const before = (await place(page, line(30)))!.size;
  const read = await perform(page, { type: "settings.read" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ ...JSON.parse(read.text || "{}"), "core.editorTextSize": 150 }), baseRevision: read.revision });
  const stop = await watch(page, [line(30), 0]);
  // As when the member comes back to the window having set it elsewhere.
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await place(page, line(30)))!.size, "the text is bigger").toBeGreaterThan(before + 4);
  await held(page, line(30), 0.3);
  // The editor keeps the line's top in place as it grows, so its middle is off by half what it grew until the next frame.
  const middles = (await stop())[0]!;
  expect(middles.filter((m) => m === null || Math.abs(m - middles.at(-1)!) > 4).length, "the line is away from its height for a frame at most").toBeLessThanOrEqual(1);
});

/** Each line of the note as lit or dim, by the class on it, in the frame drawn next, with its opacity when that isn't yet what the class makes it. */
const dimmed = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((done) =>
        requestAnimationFrame(() =>
          done(
            [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].map((el) => {
              const dim = el.classList.contains("cm-typewriter-dim");
              const opacity = getComputedStyle(el).opacity;
              return `${dim ? "dim" : "lit"}${opacity === (dim ? "0.35" : "1") ? "" : ` at ${opacity}`} ${el.textContent}`;
            }),
          ),
        ),
      ),
  );
const PARAGRAPHS = ["First words,", "on two lines.", "", "Second paragraph", "of three", "lines.", "", "Third."];
/** Every line as `dimmed` reads it, with lines `first` to `last` lit and the rest dim. */
const litFrom = (first: number, last: number) => PARAGRAPHS.map((text, i) => `${i + 1 >= first && i + 1 <= last ? "lit" : "dim"} ${text}`);

test("dimming leaves the paragraph the cursor is in as it is and fades every other, and follows the cursor at once", async ({ page }) => {
  await open(page, typewriter({ "typewriter.dim": true }), PARAGRAPHS.join("\n"));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  await expect.poll(() => dimmed(page)).toEqual(litFrom(1, 2));
  await keys(page, "ArrowDown");
  expect(await dimmed(page), "the next frame after a key").toEqual(litFrom(1, 2));
  await keys(page, "ArrowDown");
  expect(await dimmed(page), "on the blank line, only it").toEqual(litFrom(3, 3));
  await keys(page, "ArrowDown");
  expect(await dimmed(page), "into the next paragraph").toEqual(litFrom(4, 6));
  await keys(page, "ControlOrMeta+End");
  expect(await dimmed(page)).toEqual(litFrom(8, 8));
});

test("dimming lights only the bullet the cursor is in, not the list around it", async ({ page }) => {
  const LIST = ["Shopping:", "", "- apples", "- bread", "- cheese", "", "After."];
  await open(page, typewriter({ "typewriter.dim": true }), LIST.join("\n"));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home", "ArrowDown", "ArrowDown", "ArrowDown");
  const only = (n: number) => LIST.map((text, i) => `${i + 1 === n ? "lit" : "dim"} ${text}`);
  await expect.poll(() => dimmed(page), "the second bullet").toEqual(only(4));
  await keys(page, "ArrowDown");
  expect(await dimmed(page), "the third bullet").toEqual(only(5));
});

test("dimming lights every paragraph a selection made with shift and the arrows touches", async ({ page }) => {
  await open(page, typewriter({ "typewriter.dim": true }), PARAGRAPHS.join("\n"));
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home", "ArrowDown");
  await expect.poll(() => dimmed(page)).toEqual(litFrom(1, 2));
  await keys(page, "Shift+ArrowDown");
  expect(await dimmed(page), "to the blank line").toEqual(litFrom(1, 3));
  await keys(page, "Shift+ArrowDown");
  expect(await dimmed(page), "into the second paragraph").toEqual(litFrom(1, 6));
  await keys(page, "ArrowRight");
  expect(await dimmed(page), "the selection gone, only the cursor's").toEqual(litFrom(4, 6));
});

test("with vim, dimming lights every paragraph V selects, and Escape leaves only the cursor's", async ({ page }) => {
  await open(page, typewriter({ "typewriter.dim": true, "vim.enabled": true }), PARAGRAPHS.join("\n"));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg");
  await expect.poll(() => dimmed(page)).toEqual(litFrom(1, 2));
  await page.keyboard.type("V");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--VISUAL LINE--");
  await page.keyboard.type("j");
  expect(await dimmed(page), "both lines of the first").toEqual(litFrom(1, 2));
  await page.keyboard.type("j");
  expect(await dimmed(page), "to the blank line").toEqual(litFrom(1, 3));
  await page.keyboard.type("j");
  expect(await dimmed(page), "into the second").toEqual(litFrom(1, 6));
  await keys(page, "Escape");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  expect(await dimmed(page), "only the cursor's").toEqual(litFrom(4, 6));
  await page.keyboard.type("v");
  await page.keyboard.type("k");
  expect(await dimmed(page), "v, from the second back to the blank line").toEqual(litFrom(3, 6));
});

test("with vim, j and k, G and gg keep the line held", async ({ page }) => {
  await open(page, typewriter({ "vim.enabled": true }));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg");
  await held(page, line(1));
  await page.keyboard.type("jjjj");
  await held(page, line(5));
  await page.keyboard.type("k");
  await held(page, line(4));
  await page.keyboard.type("G");
  await held(page, line(80));
  await page.keyboard.type("10k");
  await held(page, line(70));
  await page.keyboard.type("gg");
  await held(page, line(1));
});

test("with vim moving by rows, each j and k in visual line mode takes a whole line and holds it, past a wrapped line too", async ({ page }) => {
  const wrapped = "A long line that wraps onto more rows because it has so very many words in it, far more than fit in one row of a note's column however wide the window, so it wraps at least twice and then goes on a little more to be sure of it.";
  await open(page, typewriter({ "vim.enabled": true, "vim.screenLines": true }), [...LINES.slice(0, 19), wrapped, ...LINES.slice(19)].join("\n"));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg19j");
  await page.keyboard.type("V");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--VISUAL LINE--");
  for (const n of [20, 21, 22]) {
    await page.keyboard.type("j");
    await held(page, line(n));
  }
  await page.keyboard.type("k");
  await held(page, line(21));
  expect(await awayFrom(page, line(22), 0.5), "the line under has moved down").toBeGreaterThan(10);
});

test("with vim, zt keeps the line at the top from then on, zb at the foot and zz in the middle, as the height", async ({ page }) => {
  await open(page, typewriter({ "vim.enabled": true }));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg40G");
  await held(page, line(40));

  await page.keyboard.type("zt");
  await held(page, line(40), 0);
  await expect.poll(() => height(page), "zt keeps the height at the top").toBe(0);
  await page.keyboard.type("jj");
  await held(page, line(42), 0);
  await page.keyboard.type("A and more");
  await held(page, line(42), 0);
  await keys(page, "Enter");
  await page.keyboard.type("Typed under line 42.");
  await held(page, "Typed under line 42.", 0);
  await keys(page, "Escape");

  await page.keyboard.type("zb");
  await held(page, "Typed under line 42.", 1);
  await expect.poll(() => height(page), "zb keeps the height at the foot").toBe(100);
  await page.keyboard.type("kk");
  await held(page, line(41), 1);

  await page.keyboard.type("zz");
  await held(page, line(41));
  await expect.poll(() => height(page), "zz keeps the height in the middle").toBe(50);
  await page.keyboard.type("10j");
  await held(page, line(50));

  await page.keyboard.type("z");
  await keys(page, "Enter");
  await held(page, line(50), 0);
  await expect.poll(() => height(page), "z<Enter> is zt").toBe(0);
});

test("with vim, the place zt asks for is kept though another change lands before it is drawn", async ({ page }) => {
  await open(page, typewriter({ "vim.enabled": true }));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg40G");
  await held(page, line(40));
  // As a change synced from elsewhere would, a transaction lands right after vim's scroll and before the frame that draws it.
  await editor(page).evaluate((el) => {
    type View = { dispatch(...specs: { userEvent?: string }[]): void };
    const view = (el as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const dispatch = view.dispatch;
    view.dispatch = (...specs) => {
      dispatch.apply(view, specs);
      if (!specs.some((spec) => spec.userEvent?.startsWith("scroll.cursor"))) return;
      view.dispatch = dispatch;
      dispatch.call(view, {});
    };
  });
  await page.keyboard.type("zt");
  await held(page, line(40), 0);
  await expect.poll(() => height(page), "zt keeps the height at the top").toBe(0);
});

test("going back to a place in a note holds its line at the height, and leaves the height as it was", async ({ page }) => {
  await open(page, typewriter({ "vim.enabled": true }));
  await perform(page, { type: "note.create", text: "# Elsewhere\n\nA short note." });
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg30Gzt");
  await expect.poll(() => height(page)).toBe(0);
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("Elsewhere");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Elsewhere");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("A short note.");
  await runCommand(page, "Go back");
  await expect(editor(page)).toContainText(line(30));
  await held(page, line(30), 0);
  expect(await height(page), "a place scrolled to the middle is not a height asked for").toBe(0);
});

test("with vim setting no height, zt and zb leave the line held where it was and the height as it was", async ({ page }) => {
  await open(page, typewriter({ "vim.enabled": true, "typewriter.vimSetsHeight": false }));
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.type("gg40G");
  await held(page, line(40));
  await page.keyboard.type("zt");
  await frames(page, 5);
  await held(page, line(40));
  await page.keyboard.type("j");
  await held(page, line(41));
  await page.keyboard.type("zb");
  await frames(page, 5);
  await held(page, line(41));
  expect((await kept(page))["typewriter.height"]).toBeUndefined();
});

test("in a split, each side holds its own line in its own pane, and moving in one leaves the other as it was", async ({ page }) => {
  await open(page, typewriter());
  const text0 = await split(page);

  await editor(page, 0).click();
  await keys(page, "ControlOrMeta+Home", "ArrowDown", "ArrowDown", "ArrowDown");
  await held(page, `${text0} 4 of`, 0.5, 0);
  await editor(page, 1).click();
  await keys(page, "ControlOrMeta+Home");
  for (let n = 0; n < 19; n++) await keys(page, "ArrowDown");
  await held(page, "Right Line 20 of", 0.5, 1);
  expect(await awayFrom(page, `${text0} 4 of`, 0.5, 0), "the left side's line stayed").toBeLessThanOrEqual(4);
});

/** Splits the editor with vim on, holds the left side's line 31 in the middle, and gives the line that holds it. */
async function splitWithVim(page: Page) {
  await open(page, typewriter({ "vim.enabled": true }));
  // Far enough down that the left side's line can stay where it is with no room above.
  const left = [`${await split(page)} 31 of`, 0] as const;
  await editor(page, 0).click();
  await page.keyboard.type("gg30j");
  await held(page, left[0], 0.5, 0);
  await editor(page, 1).click();
  return left;
}

test("in a split with vim, zt on the last line puts it at the top in one step, and the other side doesn't move as the height changes", async ({ page }) => {
  const left = await splitWithVim(page);
  await page.keyboard.type("G");
  await held(page, "Right Line 80 of", 0.5, 1);
  const stop = await watch(page, ["Right Line 80 of", 1], left);
  await page.keyboard.type("zt");
  await expect.poll(() => height(page), "zt keeps the height at the top").toBe(0);
  const [right, other] = await stop();
  expect(steps(right!), "the last line went to the top in one step").toEqual(["before", "after"]);
  expect(steps(other!), "the other side didn't move").toEqual(["after"]);
  await held(page, "Right Line 80 of", 0, 1);
  await held(page, left[0], 0.5, 0);
});

test("in a split with vim, zb on the first line puts it at the foot in one step, and the other side doesn't move as the height changes", async ({ page }) => {
  const left = await splitWithVim(page);
  await page.keyboard.type("gg");
  await held(page, "Right Line 1 of", 0.5, 1);
  const stop = await watch(page, ["Right Line 1 of", 1], left);
  await page.keyboard.type("zb");
  await expect.poll(() => height(page), "zb keeps the height at the foot").toBe(100);
  const [right, other] = await stop();
  expect(steps(right!), "the first line went to the foot in one step").toEqual(["before", "after"]);
  expect(steps(other!), "the other side didn't move").toEqual(["after"]);
  await held(page, "Right Line 1 of", 1, 1);
  await held(page, left[0], 0.5, 0);
});

test("in focus, the pane's new size has the line brought back to its height, and again on leaving", async ({ page }) => {
  await open(page, typewriter());
  await editor(page).click();
  await keys(page, "ControlOrMeta+Home");
  for (let n = 0; n < 29; n++) await keys(page, "ArrowDown");
  await held(page, line(30));
  const before = (await place(page, line(30)))!.height;
  await runCommand(page, "Toggle focus");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect.poll(async () => (await place(page, line(30)))!.height, "the pane is taller in focus").toBeGreaterThan(before);
  await held(page, line(30));
  await runCommand(page, "Toggle focus");
  await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
  await held(page, line(30));
});
