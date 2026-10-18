import { expect, test, type Page } from "@playwright/test";
import type { Upload } from "../../src/core/protocol.ts";
import { editOf, openAllNotes, perform, runCommand, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

/** Go back's and Go forward's keys: ⌘[ and ⌘] on a Mac, Alt and the arrows elsewhere, where Ctrl+[ is vim's Escape. */
const MAC = process.platform === "darwin";
const back = (page: Page) => page.keyboard.press(MAC ? "Meta+BracketLeft" : "Alt+ArrowLeft");
const forward = (page: Page) => page.keyboard.press(MAC ? "Meta+BracketRight" : "Alt+ArrowRight");
/** Where the app is: its path and query, as a person reads them. */
const at = (page: Page) => {
  const url = new URL(page.url());
  return decodeURIComponent(url.pathname + url.search);
};
const expectAt = (page: Page, address: string | RegExp) => (typeof address === "string" ? expect.poll(() => at(page)).toBe(address) : expect.poll(() => at(page)).toMatch(address));
/** Goes to an address inside the app, as a link in it does, without loading the page again. */
const go = (page: Page, address: string) =>
  page.evaluate((address) => {
    history.pushState(null, "", address);
    dispatchEvent(new PopStateEvent("popstate"));
  }, address);
const groupOf = (page: Page, n: number) => page.getByRole("region", { name: /Editor group/ }).nth(n);
const editorIn = (page: Page, n = 0) => groupOf(page, n).getByRole("textbox", { name: "Note text" });
const frontEditor = (page: Page) => page.locator('.group[data-front] [aria-label="Note text"]');
/** The line the cursor is on in the editor of the pane in front, read from the editor itself so vim's drawn cursor counts. */
const cursorLine = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector('.group[data-front] .cm-content') as (Element & { cmTile?: { view: { state: { doc: { lineAt(at: number): { text: string } }; selection: { main: { head: number } } } } } }) | null;
    const state = content?.cmTile?.view.state;
    return state ? state.doc.lineAt(state.selection.main.head).text : null;
  });
const tabsOf = (page: Page, n = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(n).getByRole("tab");
async function openNote(page: Page, title: string) {
  await openAllNotes(page);
  await editOf(page, title).click();
}
const LONG = `# Long\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the long note.`).join("\n\n")}`;

async function withNotes(page: Page, ...texts: string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const notes = [];
  for (const text of texts) notes.push(await perform(page, { type: "note.create", text }));
  return notes;
}

function upload(page: Page, name: string, text: string): Promise<Upload> {
  return page.evaluate(
    async ({ name, text }) => {
      const id = ((await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) }, body: text });
      return res.json();
    },
    { name, text },
  );
}

test("Go back and Go forward walk notes, lists and pages, put the cursor back where it was in a note, and outlast a reload", async ({ page }) => {
  await withNotes(page, LONG, "# Beta\n\nOne\n\nTwo\n\nThree");
  await page.goto("/");
  await openNote(page, "Long");
  await expectAt(page, /^\/note\/long-/);
  await editorIn(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the long note.");

  await runCommand(page, "Go to Todos");
  await expectAt(page, "/todos");
  await openNote(page, "Beta");
  await expectAt(page, /^\/note\/beta-/);
  await editorIn(page).locator(".cm-line", { hasText: "Two" }).click();

  await back(page);
  await expectAt(page, "/folder/all");
  await back(page);
  await expectAt(page, "/todos");
  await back(page);
  await expectAt(page, /^\/note\/long-/);
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the long note.");
  await expect(frontEditor(page)).toBeFocused();
  await expect(page.locator(".group[data-front] .cm-line", { hasText: "Line 80 of" })).toBeInViewport();

  await page.reload();
  await expectAt(page, /^\/note\/long-/);
  await expect(page.getByRole("tab", { name: "Long" })).toBeVisible();
  await expect(frontEditor(page)).toBeVisible();
  await forward(page);
  await expectAt(page, "/todos");
  await forward(page);
  await forward(page);
  await expectAt(page, /^\/note\/beta-/);
  await expect.poll(() => cursorLine(page)).toBe("Two");
  await forward(page);
  await expectAt(page, /^\/note\/beta-/);

  // Going somewhere new from the middle drops what was ahead, as a browser's history does.
  await back(page);
  await back(page);
  await runCommand(page, "Go to Search");
  await forward(page);
  await expectAt(page, /^\/search/);
  await back(page);
  await expectAt(page, "/todos");
});

test("in vim, ctrl+o and ctrl+i walk vim's jumps in a note between the notes and pages, and only in normal mode", async ({ page }) => {
  await withNotes(page, LONG, "# Beta");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.goto("/");
  await openNote(page, "Beta");
  await expectAt(page, /^\/note\/beta-/);
  await openNote(page, "Long");
  await expectAt(page, /^\/note\/long-/);
  await expect(frontEditor(page)).toBeFocused();
  await expect(page.locator(".cm-vim-panel")).toBeVisible();

  await page.keyboard.press("Shift+G");
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the long note.");
  await page.keyboard.type("/Line 40 ");
  await page.keyboard.press("Enter");
  await expect.poll(() => cursorLine(page)).toBe("Line 40 of the long note.");

  await page.keyboard.press("Control+o");
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the long note.");
  await page.keyboard.press("Control+o");
  await expect.poll(() => cursorLine(page)).toBe("# Long");
  await expectAt(page, /^\/note\/long-/);
  // Long was opened from the list of every note, which is where the member was before it.
  await page.keyboard.press("Control+o");
  await expectAt(page, "/folder/all");
  await page.keyboard.press("Control+o");
  await expectAt(page, /^\/note\/beta-/);
  await expect(frontEditor(page)).toBeFocused();
  await page.keyboard.press("Control+i");
  await expectAt(page, "/folder/all");
  await page.keyboard.press("Control+i");
  await expectAt(page, /^\/note\/long-/);
  await expect.poll(() => cursorLine(page)).toBe("# Long");
  await page.keyboard.press("Control+i");
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the long note.");
  await page.keyboard.press("Control+i");
  await expect.poll(() => cursorLine(page)).toBe("Line 40 of the long note.");

  // In insert mode ctrl+o is vim's own, and goes nowhere.
  await page.keyboard.press("i");
  await page.keyboard.press("Control+o");
  await page.waitForTimeout(300);
  await expectAt(page, /^\/note\/long-/);
  await expect.poll(() => cursorLine(page)).toBe("Line 40 of the long note.");
});

test("back goes to the pane the member was in, in a split, and to a tab closed since", async ({ page }) => {
  await withNotes(page, "# Alpha\n\nfirst", "# Beta\n\nsecond");
  await page.goto("/");
  await openNote(page, "Alpha");
  await runCommand(page, "Keep tab open");
  await openNote(page, "Beta");
  await runCommand(page, "Split editor right");
  await expect(tabsOf(page, 1)).toHaveText(["Beta"]);
  await editorIn(page, 0).click();
  await expectAt(page, /^\/note\/alpha-/);
  await editorIn(page, 1).click();
  await expectAt(page, /^\/note\/beta-/);

  await back(page);
  await expectAt(page, /^\/note\/alpha-/);
  await expect(groupOf(page, 0)).toHaveAttribute("data-focused", "true");
  await expect(editorIn(page, 0)).toBeFocused();
  await back(page);
  await expectAt(page, /^\/note\/beta-/);
  await expect(groupOf(page, 1)).toHaveAttribute("data-focused", "true");

  await runCommand(page, "Close tab");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await back(page);
  await expectAt(page, /^\/note\/beta-/);
  await expect(page.getByRole("tab", { name: "Beta" })).toHaveCount(1);
});

/**
 * Every kind of page, and an address to go to it at. A page added to the app that isn't here fails
 * the test below, so whoever adds one says how to get there and the history is shown to hold it.
 * `lands` is where the app ends up, for a page that leads somewhere else. Settings is left out of
 * the history: going back from it goes to where the member was before.
 */
const PAGES: Record<string, ((made: { uploadId: string; tag: string }) => { address: string; lands?: RegExp }) | "not in the history"> = {
  Dashboard: () => ({ address: "/dashboard" }),
  Search: () => ({ address: "/search?q=plan" }),
  Todos: () => ({ address: "/todos" }),
  Today: () => ({ address: "/today", lands: /^\/note\// }),
  Calendar: () => ({ address: "/calendar?view=month&day=2026-03-10" }),
  Contacts: () => ({ address: "/contacts" }),
  Person: () => ({ address: "/person/Ada Lovelace" }),
  Uploads: ({ uploadId }) => ({ address: `/uploads/${uploadId}` }),
  File: ({ uploadId }) => ({ address: `/file/${uploadId}` }),
  Tags: ({ tag }) => ({ address: `/tags/${tag}` }),
  History: () => ({ address: "/history" }),
  Trash: () => ({ address: "/trash" }),
  Members: () => ({ address: "/members" }),
  Sharing: () => ({ address: "/sharing" }),
  Agents: () => ({ address: "/agents" }),
  Plugins: () => ({ address: "/plugins" }),
  Dice: () => ({ address: "/dice" }),
  Settings: "not in the history",
};

test("every kind of page is a stop in the history, at its own address, and back and forward walk them all", async ({ page }) => {
  test.setTimeout(120_000);
  await withNotes(page, "# Plan\n\nAbout #garden");
  const made = { uploadId: (await upload(page, "notes.md", "# Notes\n\nkept")).id, tag: "garden" };
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Dashboard" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill("Go to ");
  const pages = (await palette.locator(".palette-label").allTextContents()).flatMap((label) => /^Go to (?!note…)(.+)$/.exec(label)?.[1] ?? []);
  await page.keyboard.press("Escape");
  expect(pages.length).toBeGreaterThan(10);
  expect(pages.filter((label) => !(label in PAGES)), "every page has an address here").toEqual([]);

  const walked: { label: string; at: string | RegExp }[] = [];
  for (const label of pages) {
    const how = PAGES[label]!;
    if (how === "not in the history") continue;
    const { address, lands } = how(made);
    await go(page, address);
    await expectAt(page, lands ?? address);
    walked.push({ label, at: lands ?? address });
  }
  await go(page, "/settings");
  await expectAt(page, "/settings");

  for (const stop of walked.toReversed()) {
    await back(page);
    await expect.poll(() => at(page), `back to ${stop.label}`).toMatch(typeof stop.at === "string" ? new RegExp(`^${stop.at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : stop.at);
  }
  for (const stop of walked.slice(1)) {
    await forward(page);
    await expectAt(page, stop.at);
  }
});

test("the calendar comes back at the view and the day it was left at", async ({ page }) => {
  await withNotes(page, "# Alpha");
  // With nothing connected the page offers connecting instead of the month, so the heading the address names is not there.
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  await page.goto("/calendar?view=month&day=2026-03-10");
  await expect(page.getByRole("heading", { name: "March 2026" })).toBeVisible();
  await go(page, "/calendar?view=day&day=2026-05-04");
  await expect(page.getByRole("heading", { name: "Monday, May 4, 2026" })).toBeVisible();
  await expectAt(page, "/calendar?view=day&day=2026-05-04");
  await runCommand(page, "Go to Todos");
  await back(page);
  await expectAt(page, "/calendar?view=day&day=2026-05-04");
  await expect(page.getByRole("heading", { name: "Monday, May 4, 2026" })).toBeVisible();
});

test("a notice stands at the foot of the pane being worked in, centred under it, above vim's bar, and stacks", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Notice fixture",
        activate(host: { commands: { register(c: unknown): void }; app(): { notify(n: { message: string }): void } }) {
          let n = 0;
          host.commands.register({ id: "fixture.tell", title: "Tell me something", run: () => host.app().notify({ message: `Something happened ${++n}` }) });
        },
      },
    ];
  });
  await withNotes(page, "# Alpha", "# Beta");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/");
  await openNote(page, "Alpha");
  await runCommand(page, "Keep tab open");
  await openNote(page, "Beta");
  await runCommand(page, "Split editor right");
  await expect(tabsOf(page, 1)).toHaveText(["Beta"]);
  await editorIn(page, 1).click();

  await runCommand(page, "Tell me something");
  await runCommand(page, "Tell me something");
  const cards = page.locator(".toast-card");
  await expect(cards).toHaveCount(2);
  const right = (await groupOf(page, 1).boundingBox())!;
  const bar = (await groupOf(page, 1).locator(".cm-vim-panel").boundingBox())!;
  // Once each card has finished coming in.
  await expect(async () => {
    const [first, second] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(Math.abs(second.x + second.width / 2 - (right.x + right.width / 2))).toBeLessThan(2);
    expect(second.y + second.height).toBeLessThanOrEqual(bar.y - 8);
    expect(second.y + second.height).toBeGreaterThan(bar.y - 20);
    expect(first.y + first.height).toBeLessThan(second.y);
  }).toPass();

  // Working in the other pane, they follow it there.
  await editorIn(page, 0).click();
  const left = (await groupOf(page, 0).boundingBox())!;
  await expect.poll(async () => Math.round((await cards.nth(1).boundingBox())!.x + (await cards.nth(1).boundingBox())!.width / 2)).toBe(Math.round(left.x + left.width / 2));
});

test("quick open with nothing typed lists the tabs open with their panes, then the places visited lately; typing searches the notes", async ({ page }) => {
  await withNotes(page, "# Alpha", "# Beta", "# Gamma", "# Delta");
  await page.goto("/");
  await openNote(page, "Gamma");
  await runCommand(page, "Keep tab open");
  await runCommand(page, "Go to Todos");
  await runCommand(page, "Close tab");
  await openNote(page, "Alpha");
  await runCommand(page, "Keep tab open");
  await openNote(page, "Beta");
  await runCommand(page, "Split editor right");
  await expect(tabsOf(page, 1)).toHaveText(["Beta"]);

  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  const options = palette.getByRole("option");
  await expect(options.locator(".palette-label")).toHaveText(["Alpha", "Gamma", "Beta", "All notes", "Todos", "Dashboard", "Delta"]);
  await expect(options.locator(".palette-hint")).toHaveText(["Open in pane 1 · Unsorted", "Open in pane 1 · Unsorted", "Open in pane 2 · Unsorted", "Recent · Folder", "Recent · Page", "Recent · Page", "Unsorted"]);
  await page.keyboard.press("Enter");
  await expectAt(page, /^\/note\/alpha-/);
  await expect(groupOf(page, 0)).toHaveAttribute("data-focused", "true");

  await page.keyboard.press("ControlOrMeta+p");
  await palette.getByRole("combobox").fill("del");
  await expect(options.locator(".palette-label")).toHaveText(["Delta"]);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+p");
  await options.filter({ hasText: "Todos" }).click();
  await expectAt(page, "/todos");
});
