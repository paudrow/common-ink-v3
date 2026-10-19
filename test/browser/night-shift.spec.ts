import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { perform, runCommand, signInAsNewPerson } from "./helpers.ts";
import { category } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const root = (page: Page) => page.locator("html");
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

const NOTE = [
  "# Night notes",
  "",
  "Some body text with a [link](https://example.com), *emphasis*, **strong** and `inline code`.",
  "",
  "- a list item",
  "- [ ] a todo",
  "",
  "> a quote",
  "",
  "```ts",
  'const answer: number = 42; // the answer',
  'function hi(x: string) { return "hi " + x; }',
  "```",
  "",
  ":::kanban{}",
  "## To do {.red}",
  "- write it",
  "## Doing {.blue}",
  "- test it",
  ":::",
  "",
  "::timer{5m}",
].join("\n");

/** Signs in with Night shift on, and everything else as it comes. `settings` are written over that. */
async function start(page: Page, settings: Record<string, unknown> = {}, text = NOTE) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, ...settings }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await perform(page, { type: "note.create", text: "# Another note\n\nWith a few words." });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  await page.evaluate(() => document.fonts.ready);
  return note;
}

/** What is set inline on the root besides the app's own text size and editor settings: night shift's tokens while it is on. */
const leftOn = (page: Page) => root(page).evaluate((el) => [...el.style].filter((name) => !/^--(text-scale|editor-)/.test(name)));
const isOn = async (page: Page) => (await root(page).getAttribute("data-night-shift")) !== null;
/** What the member's settings have, as the server keeps them. */
const kept = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text || "{}") as Record<string, unknown>;

/**
 * Every color on the page, in `scope`, as the browser draws it: text, backgrounds, borders that are drawn, outlines, icons, shadows,
 * placeholders. Each is read as red, green, blue and alpha by painting it, whatever way the browser writes it. Returns the ones that aren't red:
 * with any blue, or with green beyond what `greenest` of the red allows.
 */
async function notRed(page: Page, scope: string, greenest = 0.1) {
  return page.evaluate(
    ({ scope, greenest }) => {
      const pen = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const read = (css: string): [number, number, number, number] | null => {
        pen.clearRect(0, 0, 1, 1);
        pen.fillStyle = "#010203";
        pen.fillStyle = css;
        pen.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data as unknown as [number, number, number, number];
        return a === 0 ? null : [r, g, b, a];
      };
      const bad: string[] = [];
      const check = (el: Element, prop: string, css: string) => {
        if (!css || css === "none" || css === "auto" || css === "currentcolor") return;
        // A shadow is written with its colors among its lengths.
        const colors = prop === "box-shadow" || prop === "text-shadow" ? css.match(/(?:rgba?|color)\([^)]*\)/g) ?? [] : [css];
        for (const one of colors) {
          const color = read(one);
          if (!color) continue;
          const [r, g, b, a] = color;
          // A color that is mostly clear is read back from a few bits, and its green is off by a few.
          const slack = 3 + (a < 255 ? 255 / a : 0);
          if (b > 1 || g > r * greenest + slack) bad.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}${el instanceof HTMLInputElement ? ` (${el.type} ${el.getAttribute("aria-label") ?? el.name ?? ""} in ${el.parentElement?.className})` : ""} ${prop}: ${one} -> ${color.join(",")}`);
        }
      };
      const elements = [...document.querySelectorAll(scope)].flatMap((s) => [s, ...s.querySelectorAll("*")]);
      for (const el of elements) {
        const style = getComputedStyle(el);
        const invisible = style.display === "none" || style.visibility === "hidden";
        if (invisible) continue;
        check(el, "color", style.color);
        check(el, "background-color", style.backgroundColor);
        for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
          if (style[`border${side}Style`] !== "none" && parseFloat(style[`border${side}Width`]) > 0) check(el, `border-${side}`, style[`border${side}Color`]);
        }
        if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) check(el, "outline", style.outlineColor);
        if (style.textDecorationLine !== "none") check(el, "text-decoration", style.textDecorationColor);
        check(el, "box-shadow", style.boxShadow);
        check(el, "text-shadow", style.textShadow);
        if (el instanceof SVGElement) {
          check(el, "fill", style.fill);
          check(el, "stroke", style.stroke);
        }
        check(el, "accent-color", style.accentColor);
        if ((el instanceof HTMLInputElement && !["checkbox", "radio", "range"].includes(el.type)) || el instanceof HTMLTextAreaElement) {
          check(el, "placeholder", getComputedStyle(el, "::placeholder").color);
          check(el, "caret-color", style.caretColor);
        }
        if (el instanceof HTMLInputElement && ["checkbox", "radio", "range"].includes(el.type)) bad.push(...(style.accentColor === "auto" ? [`${el.type} input has the browser's own accent color`] : []));
        check(el, "scrollbar-color", /^(?:rgba?\([^)]*\)|\S+)/.exec(style.scrollbarColor)?.[0] ?? "");
        for (const pseudo of ["::before", "::after"]) {
          const p = getComputedStyle(el, pseudo);
          if (p.content === "none" || p.content === "normal") continue;
          check(el, `${pseudo} color`, p.color);
          check(el, `${pseudo} background`, p.backgroundColor);
        }
      }
      return [...new Set(bad)].slice(0, 25);
    },
    { scope, greenest },
  );
}

test("is off until it is turned on, and then the app is as it was", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: NOTE });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Night notes");
  expect(await isOn(page)).toBe(false);
  expect(await leftOn(page)).toEqual([]);
  await expect(page.getByRole("dialog", { name: "Commands" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill("night shift");
  await expect(palette.getByRole("option", { name: /Toggle night shift/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // On the Plugins page it is there, off, with its three options.
  await page.goto("/plugins");
  const row = page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Night shift", exact: true });
  await expect(row).not.toBeChecked();
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Night shift", exact: true })).toHaveCount(1);
});

test("turns on and off by its command and by its key, with no reload, and stays as it was left through one", async ({ page }) => {
  await start(page, { "night-shift.on": false });
  expect(await isOn(page)).toBe(false);
  const before = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).backgroundColor, ink: getComputedStyle(document.documentElement).color }));
  await page.evaluate(() => ((window as unknown as { stays: string }).stays = "no reload"));

  // By its command, from the palette.
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(true);
  await expect(root(page)).toHaveCSS("background-color", "rgb(0, 0, 0)");
  expect(await page.evaluate(() => (window as unknown as { stays: string }).stays)).toBe("no reload");
  await expect.poll(async () => (await kept(page))["night-shift.on"]).toBeUndefined();

  // It was on, which is its default, so a reload finds it on.
  await page.reload();
  await expect(editor(page)).toContainText("Night notes");
  await expect.poll(() => isOn(page)).toBe(true);

  // By its key, which is Ctrl or Command with Shift and X.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+X");
  await expect.poll(() => isOn(page)).toBe(false);
  await expect(root(page)).toHaveCSS("background-color", before.bg);
  await expect.poll(async () => (await kept(page))["night-shift.on"]).toBe(false);
  await page.reload();
  await expect(editor(page)).toContainText("Night notes");
  expect(await isOn(page)).toBe(false);
  expect(await leftOn(page)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+X");
  await expect.poll(() => isOn(page)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+X");
  await expect.poll(() => isOn(page)).toBe(false);
});

test("is listed as on in Settings, with its options in use, once it is on", async ({ page }) => {
  await start(page);
  await expect.poll(() => isOn(page)).toBe(true);
  await page.goto("/settings");
  const options = await category(page, "Night shift");
  await expect(options.getByRole("combobox", { name: "Strength" })).toBeVisible();
  await expect(page.getByText(/Night shift is off, so its options change nothing/)).toHaveCount(0);
  await expect(options.locator(".setting[data-inactive]")).toHaveCount(0);
  await page.goto("/plugins");
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Night shift", exact: true })).toBeChecked();
});

test("has a default key that no other command has, and the key can be changed in Settings", async ({ page }) => {
  await start(page, { "night-shift.on": false });
  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  const chords = await sheet.locator("tr").evaluateAll((rows) => rows.map((row) => ({ title: row.querySelector("th")?.textContent ?? "", keys: [...row.querySelectorAll("kbd")].map((k) => k.textContent ?? "") })));
  const mine = chords.find((c) => c.title === "Toggle night shift");
  expect(mine?.keys).toEqual([expect.stringMatching(/^(⇧⌘X|Ctrl\+Shift\+X)$/)]);
  expect(chords.filter((c) => c.keys.some((k) => mine!.keys.includes(k))).map((c) => c.title)).toEqual(["Toggle night shift"]);
  await page.keyboard.press("Escape");

  // The member's keys replace it: the old one does nothing and the new one toggles.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "night-shift.on": false, "keybindings.nightShift.toggle": ["f9"] }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(editor(page)).toContainText("Night notes");
  await page.keyboard.press("ControlOrMeta+Shift+X");
  await settled(page);
  expect(await isOn(page)).toBe(false);
  await page.keyboard.press("F9");
  await expect.poll(() => isOn(page)).toBe(true);
  await page.keyboard.press("F9");
  await expect.poll(() => isOn(page)).toBe(false);
});

test("every page, plugin page, menu, dialog, toast and the editor is red and black, with no blue and next to no green", async ({ page }) => {
  await start(page);
  await expect.poll(() => isOn(page)).toBe(true);
  expect(await root(page).evaluate((el) => getComputedStyle(el).colorScheme)).toBe("dark");

  // Computed colors on a note: text, the page behind it, the sidebar, the editor's selection and its cursor.
  const colors = await page.evaluate(() => {
    const color = (el: Element | null, prop: "color" | "backgroundColor" | "caretColor") => (el ? getComputedStyle(el)[prop] : "missing");
    return {
      page: color(document.documentElement, "backgroundColor"),
      text: color(document.querySelector(".cm-line:not(.cm-activeLine)"), "color"),
      caret: color(document.querySelector(".editor .cm-content"), "caretColor"),
      selection: getComputedStyle(document.documentElement).getPropertyValue("--selection").trim(),
      keyword: getComputedStyle(document.documentElement).getPropertyValue("--tok-keyword").trim(),
    };
  });
  expect(colors.page).toBe("rgb(0, 0, 0)");
  for (const key of ["text", "caret"] as const) expect(colors[key], key).toMatch(/^rgb\((\d+), (\d+), 0\)$/);
  expect(Number(/rgb\((\d+)/.exec(colors.text)![1])).toBeGreaterThan(200);
  expect(colors.selection).toMatch(/^#[0-9a-f]{2}[0-9a-f]{2}00$/);

  // The syntax colors of code: every one of them is red.
  await expect(page.locator(".tok-keyword").first()).toBeVisible();
  expect(await page.locator(".tok-keyword, .tok-string, .tok-comment, .tok-number, .tok-typeName, .tok-propertyName").evaluateAll((els) => els.map((el) => getComputedStyle(el).color))).not.toHaveLength(0);

  // Selecting text in the editor, as the member does, draws a red selection.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  expect(await page.locator(".cm-content .cm-line").first().evaluate((el) => getComputedStyle(el, "::selection").backgroundColor)).toMatch(/^rgb\(41, \d, 0\)$/);
  // The editor draws a selection of its own where it has one to draw, as it does with vim on.
  for (const drawn of await page.locator(".cm-selectionBackground").all()) expect(await drawn.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(41, \d, 0\)$/);
  expect(await notRed(page, ".app")).toEqual([]);
  await page.keyboard.press("ArrowLeft");

  // A folder's list of notes.
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Notes" }).getByRole("article").first()).toBeVisible();
  await settled(page);
  expect(await notRed(page, ".app")).toEqual([]);

  // The command palette, a dialog.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await expect(palette.getByRole("option").first()).toBeVisible();
  expect(await palette.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(\d+, \d+, 0\)$/);
  expect(await notRed(page, "[role=dialog]")).toEqual([]);
  await page.keyboard.press("Escape");

  // The keyboard shortcuts, a second dialog, and a menu.
  await page.keyboard.press("Shift+Slash");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  expect(await notRed(page, "[role=dialog]")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Ada's workspace/ }).click();
  const menu = page.getByRole("menu", { name: "Workspaces" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(\d+, \d+, 0\)$/);
  expect(await notRed(page, "[role=menu]")).toEqual([]);
  await page.keyboard.press("Escape");

  // A toast: archiving the note says so in a card in the corner.
  const note = await perform(page, { type: "note.create", text: "# To archive" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("To archive");
  await runCommand(page, "Archive or unarchive note");
  const toast = page.locator(".toast-card").first();
  await expect(toast).toBeVisible();
  expect(await toast.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(\d+, \d+, 0\)$/);
  expect(await notRed(page, ".toasts")).toEqual([]);
});

test("every page of the app and of its plugins is red and black too: Settings, Plugins, and the pages plugins add", async ({ page }) => {
  test.setTimeout(240_000);
  await start(page);
  await expect.poll(() => isOn(page)).toBe(true);
  for (const path of ["/settings", "/settings/keyboard", "/settings/appearance", "/plugins", "/search", "/todos", "/dashboard", "/calendar", "/contacts", "/history", "/agents", "/trash", "/uploads"]) {
    await page.goto(path);
    await expect(page.locator(".app")).toBeVisible();
    await settled(page);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), path).toBe("rgb(0, 0, 0)");
    expect(await notRed(page, ".app"), path).toEqual([]);
  }
});

test("is deep red, red, ember or amber as the strength says, and has no blue in any of them", async ({ page }) => {
  await start(page);
  const strengths = { "deep red": 0, red: 0.1, ember: 0.32, amber: 0.6 } as const;
  let before = -1;
  for (const [strength, green] of Object.entries(strengths)) {
    await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "night-shift.strength": strength }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
    await page.reload();
    await expect(editor(page)).toContainText("Night notes");
    await expect.poll(() => root(page).getAttribute("data-night-shift")).toBe(strength);
    const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ink").trim());
    const [, r, g, b] = /^#(..)(..)(..)$/.exec(ink)!.map((h) => (h ? parseInt(h, 16) : 0)) as [number, number, number, number];
    expect(b).toBe(0);
    expect(g).toBeLessThanOrEqual(Math.round(r * green));
    expect(g).toBeGreaterThan(before);
    before = g;
    expect(await notRed(page, ".app", green + 0.01), strength).toEqual([]);
  }
});

test("off puts back the theme that was in use, light or dark, exactly, with nothing left behind", async ({ page }) => {
  await start(page, { "night-shift.on": false, "core.theme": "light" });
  /** The colors the page is drawn with, its theme setting, and what night shift would leave on the root. */
  const look = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const tokens = ["--bg", "--bg-elev", "--ink", "--muted", "--line", "--accent", "--accent-soft", "--selection", "--code-bg", "--shadow", "--select-arrow", "--danger"];
      const sample = [".app", ".cm-content", ".cm-line", ".tok-keyword", "[role=tab]", "nav[aria-label=Modes]", "nav[aria-label='Inspector bar']", "a", "button", ".embed-card", ".bar"]
        .flatMap((s) => [...document.querySelectorAll(s)].slice(0, 2))
        .map((el) => {
          const style = getComputedStyle(el);
          return [el.tagName, style.color, style.backgroundColor, style.borderTopColor, style.caretColor, style.boxShadow, style.colorScheme];
        });
      return {
        theme: root.dataset.theme ?? null,
        style: [...root.style].filter((name) => !/^--(text-scale|editor-)/.test(name)),
        attributes: [...root.attributes].map((a) => a.name).sort(),
        scheme: getComputedStyle(root).colorScheme,
        tokens: tokens.map((t) => getComputedStyle(root).getPropertyValue(t)),
        sample,
      };
    });
  for (const theme of ["light", "dark"]) {
    await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "night-shift.on": false, "core.theme": theme }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
    await page.reload();
    await expect(editor(page)).toContainText("Night notes");
    await expect(root(page)).toHaveAttribute("data-theme", theme);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted", exact: true })).toBeVisible();
    await settled(page);
    const was = await look();
    expect(was.style).toEqual([]);

    await runCommand(page, "Toggle night shift");
    await expect.poll(() => isOn(page)).toBe(true);
    const during = await look();
    // On top of the theme, not in place of it: the setting stays what it was, and the colors are not.
    expect(during.theme).toBe(theme);
    expect(during.tokens).not.toEqual(was.tokens);
    expect(during.scheme).toBe("dark");

    await runCommand(page, "Toggle night shift");
    await expect.poll(() => isOn(page)).toBe(false);
    expect(await look()).toEqual(was);
  }
});

test("moves nothing in the layout when it comes and goes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, { "night-shift.on": false });
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const boxes = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100);
      };
      const named = {
        sidebar: ".rail, nav[aria-label=Sidebar], .sidebar, .column",
        tabs: "[role=tablist]",
        content: ".cm-content",
        scroller: ".cm-scroller",
        bar: ".bar",
        inspector: "nav[aria-label='Inspector bar']",
      };
      const found = Object.fromEntries(Object.entries(named).map(([name, selector]) => [name, document.querySelector(selector) ? box(document.querySelector(selector)!) : null]));
      return {
        found,
        lines: [...document.querySelectorAll(".cm-line")].map(box),
        embeds: [...document.querySelectorAll(".embed-card, .embed-below")].map(box),
        sidebarItems: [...document.querySelectorAll("[role=treeitem], nav a, nav button")].slice(0, 30).map(box),
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, document.documentElement.clientWidth],
      };
    });
  const was = await boxes();
  expect(was.lines.length).toBeGreaterThan(8);
  expect(was.embeds.length).toBeGreaterThan(1);
  expect(Object.values(was.found).filter(Boolean).length).toBeGreaterThan(3);
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(true);
  await settled(page);
  expect(await boxes()).toEqual(was);
  // The strongest strength and the tint on too, so that nothing of what it adds takes room.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "night-shift.strength": "amber", "night-shift.tint": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect.poll(() => root(page).getAttribute("data-night-tint")).not.toBeNull();
  await expect(editor(page)).toContainText("Night notes");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  expect(await boxes()).toEqual(was);
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(false);
  expect(await boxes()).toEqual(was);

  // And on a page of controls, whose checkboxes the browser draws in grays unless night shift draws them: Settings, with the box of every row but the first, which is night shift's own switch and grows its Reset button as it goes from off to on.
  await page.goto("/settings");
  const options = await category(page, "Night shift");
  await expect(options.getByRole("checkbox").first()).toBeVisible();
  // Positions are from the top of the second row, so that what the first row gains or loses above it is not counted.
  const rows = () =>
    options.evaluate((el) => {
      const origin = el.querySelectorAll(".setting")[1]!.getBoundingClientRect().top;
      return [...el.querySelectorAll(".setting:not(:first-of-type) *:not(option)")].map((e) => {
        const r = e.getBoundingClientRect();
        return [e.tagName, r.left, r.top - origin, r.width, r.height].map((n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n));
      });
    });
  const settings = await rows();
  expect(settings.length).toBeGreaterThan(10);
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(true);
  await settled(page);
  expect(await rows()).toEqual(settings);
  await options.getByRole("checkbox", { name: "Tint pictures, videos and embeds" }).check();
  await settled(page);
  // A checked box is red too. (Changing a setting from its default adds that row's Reset button, which is why the rows are not measured again.)
  const checked = options.getByRole("checkbox", { name: "Tint pictures, videos and embeds" });
  expect(await checked.evaluate((el) => [getComputedStyle(el).borderTopColor, getComputedStyle(el).backgroundColor, getComputedStyle(el).appearance])).toEqual([expect.stringMatching(/^rgb\(\d+, \d+, 0\)$/), expect.stringMatching(/^rgb\(\d+, \d+, 0\)$/), "none"]);
});

/** A PNG of one color, `width` by `height`. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const [length, sum] = [Buffer.alloc(4), Buffer.alloc(4)];
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([r, g, b]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

function send(page: Page, name: string, bytes: Buffer): Promise<Upload> {
  return page.evaluate(
    async ({ name, base64 }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, base64: bytes.toString("base64") },
  );
}

/** The red, green and blue of the middle of a picture of the page: the box `target` is, as it is drawn. */
async function middleOf(page: Page, target: ReturnType<Page["locator"]>) {
  const shot = (await target.screenshot()).toString("base64");
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const pen = canvas.getContext("2d")!;
    pen.drawImage(img, 0, 0);
    return [...pen.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
  }, shot);
}

test("tints a picture with a filter when asked to, so that what was blue is red, and leaves it alone when not", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true }), baseRevision: 0 });
  const photo = await send(page, "blue.png", png(400, 200, [30, 90, 230]));
  const note = await perform(page, { type: "note.create", text: `# Pictures\n\n::image{${photo.id} 400x200}\n\nunder` });
  await page.goto(`/note/${note.id}`);
  const picture = page.locator('.embed-below[data-embed="image"] img');
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(400);

  // Night shift is on and the tint is not, so the picture is as it is.
  expect(await picture.evaluate((img) => getComputedStyle(img).filter)).toBe("none");
  expect(await middleOf(page, picture)).toEqual([30, 90, 230]);

  // The setting is on the plugin's own page, off to start with.
  await page.goto("/settings");
  const options = await category(page, "Night shift");
  const tint = options.getByRole("checkbox", { name: "Tint pictures, videos and embeds" });
  await expect(tint).not.toBeChecked();
  await expect(options.getByRole("combobox", { name: "Strength" })).toHaveValue("red");
  await tint.check();
  await expect.poll(() => root(page).getAttribute("data-night-tint")).not.toBeNull();
  await page.goto(`/note/${note.id}`);
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img) => getComputedStyle(img).filter)).toContain("night-shift-tint");
  // What reaches the screen is red and has no blue in it, though the picture is blue.
  const [r, g, b] = (await expect.poll(async () => (await middleOf(page, picture))[0]!).toBeGreaterThan(0), await middleOf(page, picture)) as [number, number, number];
  expect([r > 0, g <= Math.round(r * 0.1) + 2, b]).toEqual([true, true, 0]);

  // Strength carries through to the picture: amber lets green in.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "night-shift.tint": true, "night-shift.strength": "amber" }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(picture).toBeVisible();
  await expect.poll(async () => (await middleOf(page, picture))[1]!).toBeGreaterThan(20);
  const amber = await middleOf(page, picture);
  expect(amber[2]).toBe(0);

  // Off again: the picture is its own colors.
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(false);
  expect(await picture.evaluate((img) => getComputedStyle(img).filter)).toBe("none");
  expect(await middleOf(page, picture)).toEqual([30, 90, 230]);
});

test("covers a frame the app can't reach into with a tint that lets every press through to it", async ({ page }) => {
  const html = [
    ":::html{height=160}",
    '<body style="margin:0;background:#1e5ae6"><button id="go" style="display:block;width:100%;height:160px;border:0;margin:0;background:#1e5ae6;color:#fff;font:20px sans-serif" onclick="this.textContent = \'pressed\'">press</button></body>',
    ":::",
  ].join("\n");
  await start(page, { "html.run": "automatically", "night-shift.tint": true }, `# Frame\n\n${html}\n\nunder`);
  const box = page.locator('.embed-below[data-embed="html"]');
  await expect(box).toBeVisible();
  const go = box.frameLocator("iframe").frameLocator("iframe").locator("#go");
  await expect(go).toHaveCount(1);
  await settled(page);

  // The cover is over the frame, on top of the page's other layers, and lets pointers through.
  const cover = await box.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    const before = getComputedStyle(el, "::before");
    const rect = el.getBoundingClientRect();
    return {
      content: after.content,
      position: after.position,
      pointerEvents: [before.pointerEvents, after.pointerEvents],
      blend: after.mixBlendMode,
      color: after.backgroundColor,
      grayed: before.backdropFilter,
      size: [after.width, after.height].map(parseFloat).map(Math.round),
      boxSize: [el.clientWidth, el.clientHeight],
      // What a press in the middle of the frame goes to: the frame, or the guard the app keeps over it, and never the tint.
      hit: (() => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
        return `${hit.tagName}.${hit.className}`;
      })(),
    };
  });
  expect(cover).toMatchObject({ content: '""', position: "absolute", pointerEvents: ["none", "none"], blend: "multiply", color: "rgb(255, 26, 0)" });
  expect(cover.grayed).toContain("grayscale");
  expect(cover.size).toEqual(cover.boxSize);
  expect(cover.hit).toMatch(/^(IFRAME|DIV\.frame-shield)/);

  // What is behind it is blue, and what shows is red with no blue.
  const [r, , b] = await middleOf(page, box);
  expect(r).toBeGreaterThanOrEqual(0);
  expect(b).toBe(0);

  // A press goes to the frame, through the tint: its button says so. A pointer moves before it presses, which is what lets the press through the app's guard.
  const middle = (await box.boundingBox())!;
  await page.mouse.move(middle.x + middle.width / 2 - 5, middle.y + middle.height / 2 - 5);
  await page.mouse.move(middle.x + middle.width / 2, middle.y + middle.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const inside = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").locator("#go");
  await expect(inside).toHaveText("pressed");
  await expect(page.getByText("HTML was stopped")).toHaveCount(0);

  // With the tint off there is no cover, and what is behind it shows as it is.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true, "html.run": "automatically" }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(box).toBeVisible();
  await expect.poll(() => box.evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
});

test("turning the plugin off takes everything it did off the page, and none of it is left when it is on again", async ({ page }) => {
  await start(page, { "night-shift.tint": true });
  await expect.poll(() => isOn(page)).toBe(true);
  expect(await page.locator("#night-shift-tint").count()).toBe(1);
  await page.goto("/plugins");
  await page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Night shift", exact: true }).setChecked(false);
  await expect.poll(() => isOn(page)).toBe(false);
  expect(await leftOn(page)).toEqual([]);
  expect(await root(page).getAttribute("data-night-tint")).toBeNull();
  expect(await page.locator("#night-shift-tint").count()).toBe(0);
  await page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "Night shift", exact: true }).setChecked(true);
  await expect.poll(() => isOn(page)).toBe(true);
  expect(await page.locator("#night-shift-tint").count()).toBe(1);
});

test("makes no request of its own and asks for no location", async ({ page }) => {
  const asked: string[] = [];
  await page.addInitScript(() => {
    for (const name of ["getCurrentPosition", "watchPosition"] as const) (navigator.geolocation as unknown as Record<string, unknown>)[name] = () => ((window as unknown as { located: boolean }).located = true);
  });
  await start(page, { "night-shift.tint": true });
  page.on("request", (req) => asked.push(req.url()));
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(false);
  await runCommand(page, "Toggle night shift");
  await expect.poll(() => isOn(page)).toBe(true);
  // Only the app's own settings write, to the app.
  expect(asked.filter((url) => new URL(url).origin !== new URL(page.url()).origin)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { located?: boolean }).located ?? false)).toBe(false);
});
