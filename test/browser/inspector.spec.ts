import { expect, type Locator, type Page } from "@playwright/test";
import { editOf, folderRow, openAllNotes, ownPlugin, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";
import { settingsDialog } from "./settings-helpers.ts";

const panel = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const bar = (page: Page) => page.getByRole("navigation", { name: "Inspector bar" });
const main = (page: Page) => page.getByRole("main", { name: "Editor" });
const icon = (page: Page, name: string) => bar(page).getByRole("button", { name });
/** What the panel shows, under its header. */
const body = (page: Page) => panel(page).locator(".inspector-body");
const pin = (page: Page) => panel(page).getByRole("button", { name: "Pin beside the page" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const boxOf = async (part: Locator) => {
  const { x, y, width, height } = (await part.boundingBox())!;
  return [x, y, width, height].map(Math.round) as [number, number, number, number];
};
/** The bar as it is drawn: its box, and each icon's name and box. */
const drawn = async (page: Page) => ({
  box: await boxOf(bar(page)),
  icons: await bar(page)
    .getByRole("button")
    .evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), ...Object.values(el.getBoundingClientRect().toJSON() as Record<string, number>).map(Math.round)])),
});

async function withNote(page: Page, text = "# Draft\n\nWords.") {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Draft");
  return note;
}

/** Shows a panel from its icon and pins it beside the page. */
async function pinned(page: Page, name: string) {
  await icon(page, name).click();
  await expect(panel(page).getByRole("heading", { name })).toBeVisible();
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute("aria-pressed", "true");
}

const write = async (page: Page, document: Record<string, unknown>) =>
  perform(page, { type: "settings.write", text: JSON.stringify(document), baseRevision: (await perform(page, { type: "settings.read" })).revision });

test("a member's first visit has no panel open and none pinned, and the inspector's command opens Info over the page", async ({ page }) => {
  await withNote(page);
  expect((await drawn(page)).icons.map(([name]) => name)).toEqual(["History", "Backlinks", "Info", "Sample calendar"]);
  await expect(panel(page)).toHaveCount(0);
  for (const name of ["History", "Backlinks", "Info", "Sample calendar"]) await expect(icon(page, name)).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(panel(page)).toHaveCount(0);

  await runCommand(page, "Toggle inspector");
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-layout", "temporary");
  await expect(pin(page)).toHaveAttribute("aria-pressed", "false");
});

test("a member from before panels could be pinned begins with none open and none pinned, the tab they had as the panel last used, whatever an earlier build kept", async ({ page }) => {
  await withNote(page);
  await page.evaluate(() => {
    const person = Object.keys(localStorage).find((key) => key.startsWith("ink.inspectorPanel."))!.slice("ink.inspectorPanel.".length);
    for (const key of Object.keys(localStorage)) if (key.startsWith("ink.inspector")) localStorage.removeItem(key);
    localStorage.setItem("ink.inspector", "true");
    localStorage.setItem(`ink.inspectorTab.${person}`, JSON.stringify("backlinks"));
    localStorage.setItem(`ink.inspector.${person}`, JSON.stringify({ panel: "info", open: true, pinned: true }));
  });
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(bar(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await runCommand(page, "Toggle inspector");
  await expect(panel(page).getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-layout", "temporary");
});

test("a panel opened from the bar lies over the page, which is as wide with it as without, and a pinned panel is beside the page, which gives it its width", async ({ page }) => {
  await withNote(page);
  await expect(panel(page)).toHaveCount(0);
  const closed = { main: await boxOf(main(page)), bar: await drawn(page) };
  expect(closed.bar.box[2]).toBe(44);
  expect(closed.main[0] + closed.main[2]).toBe(closed.bar.box[0]);

  // Over the page: the page is exactly as wide, and the note's words are where they were.
  const words = await boxOf(editor(page).getByText("Words."));
  for (const name of ["History", "Backlinks", "Info", "Sample calendar"]) {
    await icon(page, name).click();
    await expect(panel(page).getByRole("heading", { name })).toBeVisible();
    await expect(icon(page, name)).toHaveAttribute("aria-expanded", "true");
    expect(await boxOf(main(page))).toEqual(closed.main);
    expect(await boxOf(editor(page).getByText("Words."))).toEqual(words);
    expect(await drawn(page)).toEqual(closed.bar);
    expect(await boxOf(panel(page))).toEqual([closed.bar.box[0] - 256, 0, 256, closed.bar.box[3]]);
  }
  // The icon that is open, again, closes it.
  await icon(page, "Sample calendar").click();
  await expect(panel(page)).toHaveCount(0);
  expect(await boxOf(main(page))).toEqual(closed.main);
  expect(await drawn(page)).toEqual(closed.bar);

  // Pinned, the page is narrower by the panel's width, the panel is between it and the bar, and the bar has not moved.
  await pinned(page, "History");
  expect(await boxOf(main(page))).toEqual([closed.main[0], closed.main[1], closed.main[2] - 256, closed.main[3]]);
  expect(await boxOf(panel(page))).toEqual([closed.bar.box[0] - 256, 0, 256, closed.bar.box[3]]);
  expect(await drawn(page)).toEqual(closed.bar);
});

test("the bar has the same icons in the same places whatever is in front and however its panel is shown, and a panel with nothing for what is in front says so", async ({ page }) => {
  const note = await withNote(page);
  await expect(panel(page)).toHaveCount(0);
  const first = await drawn(page);
  expect(first.icons.map(([name]) => name)).toEqual(["History", "Backlinks", "Info", "Sample calendar"]);

  const kinds: [string, () => Promise<unknown>, Record<string, RegExp>][] = [
    ["a note", () => page.goto(`/note/${note.id}`), { History: /Open in History/, Backlinks: /No notes link here yet/, Info: /Folder.*Unsorted/, "Sample calendar": /Standup/ }],
    ["a folder's list", () => folderRow(page, "Unsorted").click(), { History: /Open in History/, Backlinks: /^Nothing to show for this view$/, Info: /FolderUnsortedNotes1 note/, "Sample calendar": /^Nothing to show for this view$/ }],
    ["History", () => page.goto("/history"), { History: /^Nothing to show for this view$/, Backlinks: /^Nothing to show for this view$/, Info: /^Nothing to show for this view$/, "Sample calendar": /^Nothing to show for this view$/ }],
    ["an address nothing is at", () => page.goto("/nowhere"), { History: /^Nothing to show for this view$/, Backlinks: /^Nothing to show for this view$/, Info: /^Nothing to show for this view$/, "Sample calendar": /^Nothing to show for this view$/ }],
  ];
  for (const [kind, go, says] of kinds) {
    await go();
    await expect(bar(page).getByRole("button"), kind).toHaveCount(4);
    expect(await drawn(page), `${kind}, closed`).toEqual(first);
    for (const [name, text] of Object.entries(says)) {
      await icon(page, name).click();
      // Sample calendar runs shut off, so what it says for a note is in its frame.
      const framed = name === "Sample calendar" && kind === "a note";
      await expect(framed ? ownPlugin(page, name).locator("body") : body(page), `${name} for ${kind}`).toHaveText(text);
      expect(await drawn(page), `${kind}, ${name} over the page`).toEqual(first);
      await pin(page).click();
      await expect(pin(page)).toHaveAttribute("aria-pressed", "true");
      expect(await drawn(page), `${kind}, ${name} pinned`).toEqual(first);
      await pin(page).click();
      await icon(page, name).click();
      await expect(panel(page)).toHaveCount(0);
    }
  }

  // Settings is not a view in front: it opens over the window, and the bar and the panel stay as they were under it, on the note.
  await page.goto(`/note/${note.id}`);
  await pinned(page, "Info");
  await expect(body(page)).toHaveText(/Folder.*Unsorted/);
  const pinnedBar = await drawn(page);
  await page.goto("/settings");
  await expect(settingsDialog(page)).toBeVisible();
  await expect(body(page)).toHaveText(/Folder.*Unsorted/);
  await expect(pin(page)).toHaveAttribute("aria-pressed", "true");
  expect(await drawn(page), "the bar under Settings").toEqual(pinnedBar);
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/note/(.*-)?${note.id}$`));
  await expect(body(page)).toHaveText(/Folder.*Unsorted/);
  expect(await drawn(page), "the bar once Settings is closed").toEqual(pinnedBar);
});

test("a panel over the page goes on a press elsewhere and on Escape, with the cursor back where it was, and a pinned panel stays through both", async ({ page }) => {
  await withNote(page);
  await write(page, { "keybindings.inspector.history": ["f8"] });
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(panel(page)).toHaveCount(0);

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("F8");
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await expect.poll(() => panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(" One");
  await expect(editor(page)).toContainText("Words. One");

  // The key that opened it closes it, and the cursor is in the note again.
  await page.keyboard.press("F8");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("F8");
  await expect(panel(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(" Two");
  await expect(editor(page)).toContainText("Words. One Two");

  // A press on the page closes it, and lands where it was made.
  await icon(page, "Info").click();
  await expect(panel(page)).toBeVisible();
  await editor(page).getByText("Draft").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();

  // So does a press in the sidebar, which opens what was pressed.
  await icon(page, "Info").click();
  await folderRow(page, "Unsorted").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Unsorted" })).toHaveAttribute("aria-selected", "true");

  // Another icon changes the panel and does not close it.
  await icon(page, "Info").click();
  await icon(page, "History").click();
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();

  // Pinned, it stays through a press elsewhere and through Escape.
  await pin(page).click();
  await page.getByRole("tab", { name: "Draft" }).click();
  await editor(page).click();
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await page.keyboard.press("Escape");
  await icon(page, "History").focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("F8");
  await expect(panel(page)).toHaveCount(0);
});

test("a note that arrives after the member opened a panel over the page leaves the panel open with the cursor in it", async ({ page }) => {
  await withNote(page);
  let asked!: () => void;
  const reading = new Promise<void>((resolve) => (asked = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (route.request().postDataJSON()?.type !== "note.read") return route.fallback();
    asked();
    await held;
    await route.fallback();
  });
  await openAllNotes(page);
  await editOf(page, "Draft").click();
  await reading;

  await icon(page, "Info").click();
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();
  await expect.poll(() => panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  release();
  await expect(editor(page)).toContainText("Words.");
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();
  await expect.poll(() => panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute("aria-pressed", "true");
});

test("each panel has a command, which takes a key of the member's choosing, and Escape that a list in the panel has a use for is the list's", async ({ page }) => {
  await withNote(page);
  await perform(page, { type: "note.create", text: "# Other\n\nMore words." });
  await write(page, { "keybindings.inspector.info": ["f7"], "keybindings.inspector.backlinks": ["ctrl+k b"] });
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(panel(page)).toHaveCount(0);

  await runCommand(page, "Toggle History panel");
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await page.keyboard.press("F7");
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.press("b");
  await expect(panel(page).getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await page.keyboard.press("F7");
  await page.keyboard.press("F7");
  await expect(panel(page)).toHaveCount(0);
  await runCommand(page, "Toggle inspector");
  await expect(panel(page).getByRole("heading", { name: "Info" }), "Toggle inspector shows the panel last used").toBeVisible();

  // With two changes ticked, Escape goes back to the one the list's cursor is on; pressed again it has no use there, and closes the panel.
  await folderRow(page, "Unsorted").click();
  await icon(page, "History").click();
  await panel(page).getByRole("radio", { name: "By time" }).click();
  const changes = panel(page).getByRole("listbox", { name: "Changes" });
  await expect(changes.getByRole("option")).toHaveCount(2);
  await changes.getByRole("option").first().click();
  await changes.getByRole("option").nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(changes.getByRole("option", { selected: true })).toHaveCount(2);
  await changes.focus();
  await page.keyboard.press("Escape");
  await expect(changes.getByRole("option", { selected: true })).toHaveCount(1);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("a panel's command run from the palette takes the cursor and goes on Escape, and run again from the palette over the panel it closes it", async ({ page }) => {
  await withNote(page);
  await expect(panel(page)).toHaveCount(0);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");

  await runCommand(page, "Toggle History panel");
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await expect.poll(() => panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();

  // The palette opened over the panel leaves it there, and the same command closes it, with the cursor back in the note.
  await runCommand(page, "Toggle History panel");
  await expect(panel(page)).toBeVisible();
  await runCommand(page, "Toggle History panel");
  await expect(panel(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(" Three");
  await expect(editor(page)).toContainText("Words. Three");

  // Escape on the palette closes the palette, and the panel stays.
  await runCommand(page, "Toggle Info panel");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Commands" })).toHaveCount(0);
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();
});

test("with Vim on, ctrl+w h from a panel over the page goes to the note under it, and the panel goes", async ({ page }) => {
  await withNote(page);
  await write(page, { "vim.enabled": true, "keybindings.inspector.history": ["f8"] });
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(panel(page)).toHaveCount(0);
  await editor(page).click();
  await page.keyboard.press("F8");
  await expect.poll(() => panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Control+w");
  await page.keyboard.press("h");
  await expect(editor(page)).toBeFocused();
  await expect(panel(page)).toHaveCount(0);
});

test("the panel that was pinned is there after a reload, one that lay over the page is not, and the next to open is as the last was", async ({ page }) => {
  await withNote(page);
  await pinned(page, "Backlinks");
  await page.reload();
  await expect(panel(page).getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await expect(pin(page)).toHaveAttribute("aria-pressed", "true");

  // Closed while pinned, it opens pinned.
  await icon(page, "Backlinks").click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(panel(page)).toHaveCount(0);
  await runCommand(page, "Toggle inspector");
  await expect(panel(page).getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await expect(pin(page)).toHaveAttribute("aria-pressed", "true");

  // Over the page it is gone after a reload, and opens over the page.
  await pin(page).click();
  await icon(page, "History").click();
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await page.reload();
  await expect(editor(page)).toContainText("Draft");
  await expect(bar(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await runCommand(page, "Toggle inspector");
  await expect(panel(page).getByRole("heading", { name: "History" })).toBeVisible();
  await expect(pin(page)).toHaveAttribute("aria-pressed", "false");
  await expect(panel(page)).toHaveAttribute("data-layout", "temporary");
});

test("focus shows neither the bar nor a panel, and leaving it puts a pinned panel back and leaves one that lay over the page closed", async ({ page }) => {
  await withNote(page);
  await pinned(page, "Info");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(bar(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(panel(page).getByRole("heading", { name: "Info" })).toBeVisible();

  await pin(page).click();
  await expect(panel(page)).toHaveAttribute("data-layout", "temporary");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(bar(page)).toBeHidden();
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+.");
  await expect(bar(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test("a page says what it is showing, and History and Info are about that while the page is in front", async ({ page }) => {
  await page.addInitScript(() => {
    type App = { notes: { id: string; title: string }[] | null; inspect(showing: unknown): void };
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          host.views.register("page", {
            id: "fixture-list",
            path: "/fixture-list",
            label: "Fixture list",
            component: ({ app }: { app: App }) => {
              const listed = (app.notes ?? []).filter((n) => n.title !== "Left out");
              queueMicrotask(() => app.inspect(app.notes ? { kind: "notes", label: "Fixture's notes", noteIds: [...listed.map((n) => n.id), "no-such-note"] } : null));
              return `Listing ${listed.length}`;
            },
          });
          host.views.register("page", { id: "fixture-silent", path: "/fixture-silent", label: "Fixture silent", component: () => "Saying nothing" });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const alpha = await perform(page, { type: "note.create", text: "# Alpha\n\nOne." });
  await perform(page, { type: "note.create", text: "# Beta\n\nTwo." });
  await perform(page, { type: "note.create", text: "# Left out\n\nThree." });

  await page.goto("/fixture-list");
  await expect(main(page)).toContainText("Listing 2");
  await pinned(page, "Info");
  await expect(panel(page).getByRole("definition")).toHaveText(["Fixture's notes", "2 notes", "just now by Ada Lovelace"]);
  await expect(panel(page).getByRole("term")).toHaveText(["Showing", "Notes", "Last changed"]);
  await icon(page, "History").click();
  await expect(panel(page).getByRole("tree", { name: "Notes that changed" }).locator('[aria-level="1"]')).toHaveText([/Beta/, /Alpha/]);
  await icon(page, "Backlinks").click();
  await expect(body(page)).toHaveText("Nothing to show for this view");

  // A page that says nothing is nothing to be about, and the panel and the bar are still there.
  await page.goto("/fixture-silent");
  await expect(main(page)).toContainText("Saying nothing");
  await expect(body(page)).toHaveText("Nothing to show for this view");
  await icon(page, "History").click();
  await expect(body(page)).toHaveText("Nothing to show for this view");

  // History's own page: about nothing until a change is ticked, then about that change's note, and about each note ticked.
  await page.goto("/history");
  await expect(body(page)).toHaveText("Nothing to show for this view");
  await icon(page, "Info").click();
  await expect(body(page)).toHaveText("Nothing to show for this view");
  const all = main(page).getByRole("listbox", { name: "Changes" });
  await all.getByRole("option", { name: /Alpha/ }).click();
  await expect(panel(page).getByRole("textbox", { name: "Note URL" })).toHaveValue(new RegExp(`${alpha.id}$`));
  await all.getByRole("option", { name: /Beta/ }).click({ modifiers: ["ControlOrMeta"] });
  await expect(panel(page).getByRole("definition")).toHaveText(["Ticked in History", "2 notes", "just now by Ada Lovelace"]);

  // Ticks taken off, it is about nothing again.
  await all.getByRole("option", { name: /Alpha/ }).click({ modifiers: ["ControlOrMeta"] });
  await expect(panel(page).getByRole("textbox", { name: "Note URL" })).toHaveValue(/beta-[a-z0-9]{12}$/);
  await all.getByRole("option", { name: /Beta/ }).click({ modifiers: ["ControlOrMeta"] });
  await expect(all.getByRole("option", { selected: true })).toHaveCount(0);
  await expect(body(page)).toHaveText("Nothing to show for this view");
});
