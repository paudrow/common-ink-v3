import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, pinPanel, signInAsNewPerson } from "./helpers.ts";
import { settingsDialog } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const MAC = process.platform === "darwin";
const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const statusLine = (page: Page, group = 0) => page.locator(".cm-vim-panel").nth(group);
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};

async function signIn(page: Page, settings: Record<string, unknown> = { "vim.enabled": true }) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
}

/** Goes to an address and waits for vim's keys, which come with vim's editing a moment after the page. */
async function open(page: Page, path: string, vim = true) {
  await page.goto(path);
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
}

/** Whether the row has focus in it, is marked as the selected one, and is where it can be seen. */
async function expectSelected(row: Locator, what: string) {
  await expect.poll(() => row.evaluate((el) => el.contains(document.activeElement)), `${what} has focus`).toBe(true);
  await expect(row, `${what} is on screen`).toBeInViewport({ ratio: 0.9 });
  await expect(page(row).locator("[data-vim-at]"), "one row is marked").toHaveCount(1);
  const mark = await row.evaluate((el) => ({ at: "vimAt" in el.dataset, style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, color: getComputedStyle(el).outlineColor, page: getComputedStyle(document.body).backgroundColor }));
  expect(mark, `${what} is marked`).toMatchObject({ at: true, style: "solid", width: "2px" });
  expect(mark.color, `${what}'s mark stands out from the page`).not.toBe(mark.page);
}
const page = (locator: Locator) => locator.page();

const rows = (list: Locator, row = ":scope > *") => list.locator(row);

test("the folder tree moves with j, k, gg and G, opens with l and Enter, and h collapses a folder and then goes to its parent", async ({ page }) => {
  await signIn(page);
  const work = await perform(page, { type: "folder.create", name: "Work" });
  const plans = await perform(page, { type: "folder.create", name: "Plans", parentId: work.id });
  await perform(page, { type: "folder.create", name: "Zebra" });
  await perform(page, { type: "note.create", text: "# In plans", folderId: plans.id });
  await open(page, "/folder/all");
  const tree = page.getByRole("tree");
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
  await expect(item("Zebra")).toBeVisible();

  // From the middle of the window, Ctrl-w h goes to the sidebar, onto the folder in front.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await keys(page, "Control+w", "h");
  await expectSelected(item("All notes"), "All notes");
  await page.keyboard.press("Shift+G");
  await expectSelected(item("Zebra"), "the last folder");
  await keys(page, "g", "g");
  await expectSelected(item("All notes"), "the first row");
  await page.keyboard.press("k");
  await expectSelected(item("All notes"), "the first row still");

  const down = async (to: string) => {
    for (let i = 0; i < 8 && !(await item(to).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("j");
    await expectSelected(item(to), to);
  };
  await down("Work");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
  await expect(item("Work")).toHaveAttribute("aria-expanded", "true");
  await expectSelected(item("Work"), "Work, after opening it");
  await page.keyboard.press("j");
  await expectSelected(item("Plans"), "Plans");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/folder/.*${plans.id}`));
  await expectSelected(item("Plans"), "Plans, after opening it");

  // h on a row with nothing to collapse goes to its parent, and h there collapses it.
  await page.keyboard.press("h");
  await expectSelected(item("Work"), "Work, the parent");
  await page.keyboard.press("h");
  await expect(item("Work")).toHaveAttribute("aria-expanded", "false");
  await expect(item("Plans")).toHaveCount(0);
  await expectSelected(item("Work"), "Work, collapsed");
});

/** Makes a note of each text, in order, in one visit to the page: a note at a time through `perform` is two requests each, which a slow deployment turns into the whole of a test's time. */
async function createNotes(page: Page, texts: string[]) {
  await page.evaluate(async (texts) => {
    const me = (await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] };
    for (const text of texts) {
      const res = await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "note.create", text }),
      });
      if (!res.ok) throw new Error(`note.create answered ${res.status}`);
    }
  }, texts);
}

test("a folder's notes move with j, k, gg, G and half pages; / goes to the search box and Escape back; Enter opens the note with its text in normal mode", async ({ page }) => {
  await signIn(page);
  const titles = Array.from({ length: 30 }, (_, n) => `Note ${String(n).padStart(2, "0")}`);
  await createNotes(page, titles.map((title) => `# ${title}\n\nplum`));
  await open(page, "/folder/all");
  const cards = page.locator(".cards > li");
  await expect(cards).toHaveCount(30);
  const at = () => page.evaluate(() => [...document.querySelectorAll(".cards > li")].findIndex((li) => li.contains(document.activeElement)));

  await page.keyboard.press("j");
  await expectSelected(cards.nth(0), "the first note");
  await page.keyboard.press("j");
  await expectSelected(cards.nth(1), "the second note");
  await page.keyboard.press("k");
  await expectSelected(cards.nth(0), "the first note again");
  await page.keyboard.press("Control+d");
  const half = await at();
  expect(half, "half a page is more than a row and less than the list").toBeGreaterThan(1);
  expect(half).toBeLessThan(29);
  await expectSelected(cards.nth(half), "the note half a page down");
  await page.keyboard.press("Control+d");
  await expect.poll(() => at()).toBe(Math.min(29, half * 2));
  await page.keyboard.press("Control+u");
  await expect.poll(() => at()).toBe(Math.min(29, half * 2) - half);
  await page.keyboard.press("Shift+G");
  await expectSelected(cards.nth(29), "the last note");
  await keys(page, "g", "g");
  await expectSelected(cards.nth(0), "the first note, after gg");

  // / is the list's search box. Letters are typed there, and move nothing.
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search notes" });
  await expect(search).toBeFocused();
  await page.keyboard.type("jGk plum");
  await expect(search).toHaveValue("jGk plum");
  await search.fill("plum");
  await expect(cards).toHaveCount(30);
  await page.keyboard.press("Escape");
  await expectSelected(cards.nth(0), "the row the list was left on");
  await expect(search).toHaveValue("plum");
  await keys(page, "/", "Control+j");
  await expectSelected(cards.nth(0), "the first note, from the search box with Ctrl-j");

  await keys(page, "j", "j");
  const title = await cards.nth(2).locator(".card-title").innerText();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\//);
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toContainText(title);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
});

interface Listed {
  name: string;
  path: string;
  list: (page: Page) => Locator;
  row?: string;
  /** What Enter on the second row comes to. */
  opened?: (page: Page) => Promise<void>;
}

const LISTS: Listed[] = [
  {
    name: "the Todos page",
    path: "/todos",
    list: (page) => page.getByRole("list", { name: "Todos" }),
    opened: async (page) => {
      await expect(page).toHaveURL(/\/note\//);
      await expect(editor(page)).toBeFocused();
      await expect(statusLine(page)).toHaveText("--NORMAL--");
    },
  },
  {
    name: "the Plugins list",
    path: "/plugins",
    list: (page) => page.getByRole("list", { name: "Plugins", exact: true }),
    opened: async (page) => {
      await expect(page).toHaveURL(/\/plugins\/[a-z-]+$/);
      await expect(page.getByRole("list", { name: "Plugins", exact: true })).toHaveCount(0);
    },
  },
  {
    name: "the keyboard shortcuts in Settings",
    path: "/settings/keyboard",
    list: (page) => page.locator(".settings-pane"),
    row: "[data-row]",
    opened: (page) => expect(page.getByRole("dialog", { name: /^Record a key for / })).toBeVisible(),
  },
];

for (const listed of LISTS) {
  test(`${listed.name} move with j, k, gg and G, and Enter opens the selected row`, async ({ page }) => {
    await signIn(page);
    for (let n = 0; n < 6; n++) {
      await perform(page, { type: "note.create", text: `# Plum ${n}\n\n- [ ] pick plum ${n}\n` });
    }
    await open(page, listed.path);
    const all = rows(listed.list(page), listed.row);
    await expect(all.nth(5)).toBeAttached();
    const count = await all.count();

    // A page that opens with the cursor in its search box is left for its list with Escape, and otherwise j goes into the list.
    await page.keyboard.press((await page.evaluate(() => document.activeElement instanceof HTMLInputElement)) ? "Escape" : "j");
    await expectSelected(all.nth(0), "the first row");
    await page.keyboard.press("j");
    await expectSelected(all.nth(1), "the second row");
    await page.keyboard.press("Shift+G");
    await expectSelected(all.nth(count - 1), "the last row");
    await page.keyboard.press("k");
    await expectSelected(all.nth(count - 2), "the row before the last");
    await keys(page, "g", "g", "j");
    await expectSelected(all.nth(1), "the second row, after gg and j");
    if (!listed.opened) return;
    await page.keyboard.press("Enter");
    await listed.opened(page);
  });
}

test("History's list of changes keeps its own keys with vim mode on: j goes to the list, and there j, k, x and Enter are History's, and gg, G and the half pages reach it as its own", async ({ page }) => {
  await signIn(page);
  for (let n = 0; n < 4; n++) await perform(page, { type: "note.create", text: `# Plum ${n}` });
  await open(page, "/history");
  const list = page.getByRole("listbox", { name: "Changes" });
  const changes = list.getByRole("option");
  await expect(changes).toHaveCount(4);
  const cursor = () => list.evaluate((el) => [...el.querySelectorAll('[role="option"]')].findIndex((o) => o.id === el.getAttribute("aria-activedescendant")));
  const shown = page.locator(".hist-main .hist-file");

  // No change is selected as the page opens. j from the page goes to the list, not onto a row of it.
  await expect(page.locator(".hist-hint")).toBeVisible();
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
  await page.keyboard.press("j");
  await expect(list).toBeFocused();
  await expect(page.locator("[data-vim-at]"), "no row is marked as vim's").toHaveCount(0);
  await expect.poll(cursor).toBe(-1);
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);

  // From here the keys are History's: j goes to the first change, j and k move its cursor and show that change, and x ticks one more.
  await page.keyboard.press("j");
  await expect.poll(cursor).toBe(0);
  await expect(changes.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(shown).toContainText("Plum 3");
  await page.keyboard.press("j");
  await expect.poll(cursor).toBe(1);
  await expect(changes.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(changes.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(shown).toHaveCount(1);
  await expect(shown).toContainText("Plum 2");
  await keys(page, "j", "k", "k");
  await expect.poll(cursor).toBe(0);
  await expect(shown).toContainText("Plum 3");
  await keys(page, "j", "j", "x");
  await expect.poll(cursor).toBe(2);
  await expect(changes.nth(2)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("x");
  await expect(changes.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(list).toBeFocused();
  // G, gg and the half pages are History's too: vim sends them to the list as End, Home, Page Down and Page Up.
  await page.keyboard.press("Shift+G");
  await expect.poll(cursor).toBe(3);
  await expect(changes.nth(3)).toHaveAttribute("aria-selected", "true");
  await keys(page, "g", "g");
  await expect.poll(cursor).toBe(0);
  await expect(shown).toContainText("Plum 3");
  await page.keyboard.press("Control+d");
  await expect.poll(cursor).toBe(3);
  await page.keyboard.press("Control+u");
  await expect.poll(cursor).toBe(0);
  await expect(list).toBeFocused();
  await expect(page.locator("[data-vim-at]"), "no row is marked as vim's").toHaveCount(0);
  // A g that begins nothing here takes no key from the list: the j after it is the list's.
  await keys(page, "g", "j");
  await expect.poll(cursor).toBe(1);
  await keys(page, "j", "g");
  await expect.poll(cursor).toBe(2);

  // Enter is History's too: it opens the change's note, which vim has in normal mode.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\//);
  await expect(editor(page)).toContainText("Plum 1");
});

test("in Settings, Enter on a setting goes to its field and Escape comes back to the row; / is the search box; and vim's keys are among the keyboard shortcuts while vim mode is on", async ({ page }) => {
  await signIn(page);
  await open(page, "/settings/appearance");
  const panel = settingsDialog(page);
  const all = panel.locator("[data-row]");
  await expect(all.first()).toBeVisible();
  await page.keyboard.press("j");
  await expectSelected(all.nth(0), "Theme");
  await page.keyboard.press("Enter");
  const theme = all.nth(0).getByRole("combobox");
  await expect(theme).toBeFocused();
  // In the field j is the field's: it chooses nothing in the list.
  await page.keyboard.press("Escape");
  await expect(all.nth(0)).toBeFocused();

  await page.keyboard.press("/");
  const search = panel.getByRole("searchbox", { name: "Search settings" });
  await expect(search).toBeFocused();
  await page.keyboard.type("vim:");
  const shortcuts = panel.getByRole("table", { name: "Keyboard shortcuts" });
  const shown = (title: string) => shortcuts.getByRole("row", { name: title }).locator("kbd");
  await expect(shown("Vim: next row of a list")).toHaveText([/^J/]);
  await expect(shown("Vim: first row of a list")).toHaveText([/^G G/]);
  await expect(shown("Vim: last row of a list")).toHaveText([MAC ? /^⇧G/ : /^Shift\+G/]);
  await expect(shown("Vim: half a page down a list")).toHaveText([MAC ? /^⌃D/ : /^Ctrl\+D/]);
  await expect(shown("Vim: open the selected row")).toHaveText([/^Enter/, /^L/]);
  await expect(shown("Vim: expand or collapse the selected row")).toHaveText([/^Z A/]);
  await expect(shown("Vim: go to the region on the left")).toHaveText([MAC ? /^⌃W H/ : /^Ctrl\+W H/]);
  await expect(shown("Vim: next tab")).toHaveText([/^G T/]);
  await expect(shown("Vim: next row, from a field")).toHaveText(MAC ? [/^⌃J/, /^⌃N/] : [/^Ctrl\+J/, /^Ctrl\+N/]);
  await expect(all).toHaveCount(19);
  await expect(shortcuts.locator("tbody tr")).toHaveCount(19);

  // Escape leaves the search box for the list, on its first row, and the keys go on through the shortcuts.
  await page.keyboard.press("Escape");
  await expectSelected(all.nth(0), "the first shortcut that is shown");
  await page.keyboard.press("j");
  await expectSelected(all.nth(1), "the second shortcut");
});

test("a vim key is given a sequence by pressing its keys one after another, which is warned of where it begins another's, and a single letter in the JSON", async ({ page }) => {
  await signIn(page);
  for (let n = 0; n < 4; n++) await perform(page, { type: "note.create", text: `# Plum ${n}\n\n- [ ] pick plum ${n}\n` });
  const stored = async () => JSON.parse((await perform(page, { type: "settings.read" })).text) as Record<string, unknown>;
  await open(page, "/settings/keyboard");
  const shortcuts = page.getByRole("table", { name: "Keyboard shortcuts" });
  const first = shortcuts.getByRole("row", { name: "Vim: first row of a list" });

  await first.getByRole("button", { name: "Record a key for Vim: first row of a list" }).click();
  const recorder = page.getByRole("dialog", { name: "Record a key for Vim: first row of a list" });
  await expect(recorder.getByRole("group", { name: "Press the keys" })).toBeFocused();
  // g is the first key of gt and gT, and of gg as it stands, which the recorder says before n is pressed after it.
  await page.keyboard.press("g");
  await expect(recorder.locator("kbd")).toHaveText("G");
  await expect(recorder.getByRole("alert")).toHaveText([/^G is the first key of G T, the keys for Vim: next tab\. Where both can run, G T never would\.$/, /^G is the first key of G (⇧T|Shift\+T), the keys for Vim: previous tab\./]);
  await page.keyboard.press("n");
  await expect(recorder.locator("kbd")).toHaveText("G N");
  await expect(recorder.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(recorder).toHaveCount(0);
  await expect(first.locator("kbd")).toHaveText([/^G N/]);
  await expect.poll(stored).toEqual({ "vim.enabled": true, "keybindings.vim.list.first": ["g n"] });
  await expect(page.getByRole("list", { name: "Problems" })).toHaveCount(0);

  await open(page, "/folder/all");
  const changed = page.locator(".cards > li");
  await expect(changed).toHaveCount(4);
  await keys(page, "j", "Shift+G");
  await expectSelected(changed.nth(3), "the last note");
  await keys(page, "g", "g");
  await expectSelected(changed.nth(3), "the last note still, after the keys that were the default");
  await keys(page, "g", "n");
  await expectSelected(changed.nth(0), "the first note, with the keys recorded");

  // In the JSON a vim key may be one letter, and one that begins another's sequence is flagged and still runs.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true, "keybindings.vim.list.down": ["n"], "keybindings.vim.list.last": ["g"] }), baseRevision: 2 });
  await open(page, "/folder/all");
  await expect(changed).toHaveCount(4);
  await keys(page, "n", "n");
  await expectSelected(changed.nth(1), "the second note, with n");
  await page.keyboard.press("j");
  await expectSelected(changed.nth(1), "the second note still, after j");
  await page.keyboard.press("g");
  await expectSelected(changed.nth(3), "the last note, with g alone");
  await open(page, "/settings/keyboard");
  await expect(page.getByRole("list", { name: "Problems" }).getByRole("listitem")).toHaveText([
    /^keybindings\.vim\.list\.last g is the first key of g g, the keys for Vim: first row of a list \(vim\.list\.first\), and of g t, the keys for Vim: next tab \(vim\.tab\.next\), and of g shift\+t, the keys for Vim: previous tab \(vim\.tab\.previous\)\. Where both can run, g runs Vim: last row of a list and the longer keys never run\.$/,
  ]);
});

test("with vim mode off, none of vim's keys do anything and none are listed", async ({ page }) => {
  await signIn(page, {});
  for (let n = 0; n < 3; n++) await perform(page, { type: "note.create", text: `# Plum ${n}\n\n- [ ] pick plum ${n}\n` });
  await page.goto("/folder/all");
  const all = page.locator(".cards > li");
  await expect(all).toHaveCount(3);
  await keys(page, "j", "Shift+G", "g", "g", "Control+d", "/", "Control+w", "h", "g", "t");
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await expect.poll(() => page.evaluate(() => "vimKeys" in document.documentElement.dataset)).toBe(false);
  await all.nth(0).locator(".card").focus();
  await keys(page, "j", "l");
  await expect(all.nth(0).locator(".card")).toBeFocused();
  await expect(page).toHaveURL(/\/folder\/all/);
  await expect.poll(() => all.nth(0).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");

  await page.goto("/settings/keyboard");
  await expect(page.getByRole("table", { name: "Keyboard shortcuts" }).getByRole("row", { name: /Undo/ })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search settings" }).fill("vim:");
  await expect(settingsDialog(page)).toContainText("No setting or keyboard shortcut matches.");
  await expect(settingsDialog(page).locator("[data-row]")).toHaveCount(0);
});

test("in the command palette and quick open, Ctrl-j and Ctrl-k move, Ctrl-n and Ctrl-p too where the browser leaves them, and letters are typed", async ({ page }) => {
  await signIn(page);
  for (const title of ["Plum one", "Plum two", "Plum three"]) await perform(page, { type: "note.create", text: `# ${title}` });
  await open(page, "/folder/all");
  await expect(page.locator(".cards > li")).toHaveCount(3);

  for (const [open, label, typed] of [["ControlOrMeta+Shift+P", "Commands", "open"], ["ControlOrMeta+p", "Go to note", "plum"]] as const) {
    await page.keyboard.press(open);
    const dialog = page.getByRole("dialog", { name: label });
    const field = dialog.getByRole("combobox");
    const options = dialog.getByRole("option");
    await expect(field).toBeFocused();
    await page.keyboard.type(typed);
    await expect(field).toHaveValue(typed);
    await expect(options.nth(2)).toBeVisible();
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+j");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+n");
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+k");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    // Letters are the field's, whatever they are in a list.
    await page.keyboard.type("jk");
    await expect(field).toHaveValue(`${typed}jk`);
    await field.fill(typed);
    await page.keyboard.press("Control+j");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    if (MAC) {
      await page.keyboard.press("Control+p");
      await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }

  // Off a Mac Ctrl-p is the app's own key for quick open, and it still is.
  await page.locator(".cards > li").first().locator(".card").focus();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("dialog", { name: "Go to note" })).toBeVisible();
  await page.keyboard.type("plum");
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\//);
});

test("Ctrl-w h and l move between the sidebar, the sides of a split and the inspector, and gt and gT change tabs, from a note in normal mode and never while typing", async ({ page }) => {
  await signIn(page);
  const left = await perform(page, { type: "note.create", text: "# Left\n\nleft words" });
  const right = await perform(page, { type: "note.create", text: "# Right\n\nright words" });
  const third = await perform(page, { type: "note.create", text: "# Third\n\nthird words" });
  const run = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("combobox", { name: "Commands" }).fill(command);
    await page.keyboard.press("Enter");
  };
  const goTo = async (title: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("combobox", { name: "Go to note" }).fill(title);
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText(title);
    await page.keyboard.press("Enter");
  };
  await open(page, `/note/${left.id}`);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await run("Keep tab open");
  await goTo("Third");
  await expect(editor(page)).toContainText("third words");
  await run("Keep tab open");
  await goTo("Right");
  await expect(editor(page)).toContainText("right words");
  await run("Split editor right");
  await expect(editor(page, 1)).toContainText("right words");
  const group = (n: number) => page.getByRole("region", { name: `Editor group ${n}` });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await pinPanel(page, "Info");
  await expect(inspector).toBeVisible();
  const focusIn = (region: Locator) => expect.poll(() => region.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await editor(page, 1).click();
  await keys(page, "Control+w", "h");
  await expect(editor(page, 0)).toBeFocused();
  await keys(page, "Control+w", "h");
  await focusIn(page.getByRole("complementary", { name: "Sidebar" }));
  await expect(page.getByRole("tree").getByRole("treeitem", { name: "Unsorted" })).toBeFocused();
  // Nothing is left of the sidebar, so the keys stay where they are.
  await keys(page, "Control+w", "h");
  await expect(page.getByRole("tree").getByRole("treeitem", { name: "Unsorted" })).toBeFocused();
  await keys(page, "Control+w", "l");
  await expect(editor(page, 0)).toBeFocused();
  await keys(page, "Control+w", "l");
  await expect(editor(page, 1)).toBeFocused();
  await keys(page, "Control+w", "l");
  await focusIn(inspector);
  await keys(page, "Control+w", "h");
  await expect(editor(page, 1)).toBeFocused();
  await keys(page, "Control+w", "h");
  await expect(editor(page, 0)).toBeFocused();

  // gt and gT go through the tabs of the side the keys are in, and the note in front takes them.
  const selected = () => group(1).getByRole("tab", { selected: true });
  await expect(selected()).toHaveAccessibleName("Third");
  await keys(page, "g", "t");
  await expect(selected()).toHaveAccessibleName("Left");
  await expect(editor(page, 0)).toContainText("left words");
  await expect(editor(page, 0)).toBeFocused();
  await expect(statusLine(page, 0)).toHaveText("--NORMAL--");
  await keys(page, "g", "Shift+T");
  await expect(selected()).toHaveAccessibleName("Third");
  await expect(editor(page, 0)).toBeFocused();
  await expect(group(2).getByRole("tab", { selected: true })).toHaveAccessibleName("Right");

  // Typing: every one of these keys is text.
  await expect(editor(page, 0)).toContainText("third words");
  await keys(page, "Shift+G", "o");
  await expect(statusLine(page, 0)).toHaveText("--INSERT--");
  await page.keyboard.type("gt gT jk hl /G");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: third.id })).text).toBe("# Third\n\nthird words\ngt gT jk hl /G");
  await expect(selected()).toHaveAccessibleName("Third");
  expect(right.id).not.toBe(left.id);
});

test("Ctrl-w j and k move between the sides of a split down, and in focus the keys stay in the one tab that is seen", async ({ page }) => {
  await signIn(page);
  const upper = await perform(page, { type: "note.create", text: "# Upper\n\nupper words" });
  await perform(page, { type: "note.create", text: "# Lower\n\nlower words" });
  const run = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("combobox", { name: "Commands" }).fill(command);
    await page.keyboard.press("Enter");
  };
  await open(page, `/note/${upper.id}`);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await run("Keep tab open");
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("combobox", { name: "Go to note" }).fill("Lower");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Lower");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("lower words");
  await run("Split editor down");
  await expect(editor(page, 1)).toContainText("lower words");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await pinPanel(page, "Info");
  await expect(inspector).toBeVisible();

  await editor(page, 1).click();
  await keys(page, "Control+w", "k");
  await expect(editor(page, 0)).toBeFocused();
  // Nothing is above the upper side, so the keys stay where they are.
  await keys(page, "Control+w", "k");
  await expect(editor(page, 0)).toBeFocused();
  await keys(page, "Control+w", "j");
  await expect(editor(page, 1)).toBeFocused();
  await keys(page, "Control+w", "h");
  await expect(page.getByRole("tree").getByRole("treeitem", { name: "Unsorted" })).toBeFocused();
  // Both sides are as near the sidebar and share as much of its edge: the upper one, which comes first, is the one gone to.
  await keys(page, "Control+w", "l");
  await expect(editor(page, 0)).toBeFocused();
  await keys(page, "Control+w", "j");
  await expect(editor(page, 1)).toBeFocused();

  // In focus the sidebar, the inspector and the other side keep their places out of sight, and no key goes to them.
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  const only = page.getByRole("textbox", { name: "Note text" });
  await expect(only).toHaveCount(1);
  await expect(only).toContainText("lower words");
  for (const side of ["h", "j", "k", "l"]) {
    await keys(page, "Control+w", side);
    await expect(only, `Ctrl-w ${side} in focus`).toBeFocused();
    await expect(page.locator("[data-vim-at]"), `Ctrl-w ${side} marks no row`).toHaveCount(0);
  }
  await keys(page, "Shift+G", "$", "x");
  await expect(only.locator(".cm-line").last()).toHaveText("lower word");
  // With focus on nothing, the keys still find only what is seen.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await keys(page, "Control+w", "h");
  await expect(page.locator("[data-vim-at]")).toHaveCount(0);
  await keys(page, "j");
  await expect(page.locator("[data-vim-at]")).toHaveCount(0);
  await expect(statusLine(page, 1)).toHaveText("--NORMAL--");

  // Out of focus the keys reach the other side again.
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
  await keys(page, "Control+w", "k");
  await expect(editor(page, 0)).toBeFocused();
  await keys(page, "Control+w", "l");
  await expect.poll(() => inspector.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test("gt from a note to a folder's tab puts the keys on the list's rows, and Enter there opens the next note in normal mode", async ({ page }) => {
  await signIn(page);
  for (const title of ["Plum one", "Plum two", "Plum three"]) await perform(page, { type: "note.create", text: `# ${title}\n\nwords` });
  await open(page, "/folder/all");
  const cards = page.locator(".cards > li");
  await expect(cards).toHaveCount(3);
  // A note opened from a previewed list takes the list's place, so the list is kept first.
  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "All notes" }).dblclick();
  const first = await cards.nth(0).locator(".card-title").innerText();
  await keys(page, "j", "Enter");
  await expect(editor(page)).toBeFocused();
  const selectedTab = page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { selected: true });
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(2);
  await expect(selectedTab).toHaveAccessibleName(first);

  await keys(page, "g", "t");
  await expect(selectedTab).toHaveAccessibleName("All notes");
  await expectSelected(cards.nth(0), "the row the list was left on");
  await page.keyboard.press("j");
  await expectSelected(cards.nth(1), "the next note");
  const title = await cards.nth(1).locator(".card-title").innerText();
  await page.keyboard.press("l");
  await expect(selectedTab).toHaveAccessibleName(title);
  await expect(editor(page)).toBeFocused();
  await expect(statusLine(page)).toHaveText("--NORMAL--");

  // A note left in insert mode is in normal mode when a key opens it again.
  await keys(page, "Shift+G", "o");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.getByRole("tab", { name: "All notes" }).click();
  await cards.nth(1).locator(".card").focus();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
});

test("the selected row is marked in light and in dark", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await signIn(page, { "vim.enabled": true, "core.theme": theme });
    for (let n = 0; n < 3; n++) await perform(page, { type: "note.create", text: `# Plum ${n}\n\n- [ ] pick plum ${n}\n` });
    await open(page, "/folder/all");
    const all = page.locator(".cards > li");
    await expect(all).toHaveCount(3);
    await keys(page, "j", "j");
    await expectSelected(all.nth(1), `the second note, in ${theme}`);
    const colors = await all.nth(1).evaluate((el) => ({ outline: getComputedStyle(el).outlineColor, width: getComputedStyle(el).outlineWidth, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), other: getComputedStyle(el.previousElementSibling!).outlineStyle }));
    expect(colors.width).toBe("2px");
    expect(colors.other, "only the selected row is marked").toBe("none");
    // Held with Control a key is no sign to the browser that keys are in use, so the mark is the app's own.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await keys(page, "Control+d", "Control+d");
    await expectSelected(all.nth(2), `the last note, in ${theme}`);
    expect(colors.accent).toBe(theme === "light" ? "#5b5bd6" : "#8f8ff0");
    expect(colors.outline).toBe(theme === "light" ? "rgb(91, 91, 214)" : "rgb(143, 143, 240)");
    await page.screenshot({ path: test.info().outputPath(`list-${theme}.png`) });
  }
});

test("vim mode leaves the app's own keys alone: Escape still cancels a folder's rename, and a note card's own keys still work", async ({ page }) => {
  await signIn(page);
  await perform(page, { type: "folder.create", name: "Work" });
  await perform(page, { type: "note.create", text: "# Plum\n\nwords" });
  await perform(page, { type: "note.create", text: "# Pear\n\nwords" });
  await open(page, "/folder/all");
  const work = page.getByRole("tree").getByRole("treeitem", { name: "Work", exact: true });
  await work.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = page.getByRole("tree").getByRole("textbox");
  await expect(name).toBeFocused();
  await page.keyboard.type("jkl");
  await expect(name).toHaveValue("jkl");
  await page.keyboard.press("Escape");
  await expect(work).toBeVisible();

  const cards = page.locator(".cards > li .card");
  await cards.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(cards.nth(1)).toBeFocused();
});

test("a sequence begun on a row and given up takes no key from a note: a press, a move of focus or a second's wait ends it", async ({ page }) => {
  await signIn(page);
  await perform(page, { type: "folder.create", name: "Zebra" });
  const note = await perform(page, { type: "note.create", text: "# Plum\n\nwords" });
  await open(page, `/note/${note.id}`);
  const item = (name: string) => page.getByRole("tree").getByRole("treeitem", { name, exact: true });
  await expect(editor(page)).toContainText("words");
  await expect(statusLine(page)).toHaveText("--NORMAL--");

  // g on a folder's row waits for a second g. A press in the note ends the wait, so the next key is the note's.
  await item("All notes").focus();
  await page.keyboard.press("g");
  await editor(page).click();
  await page.keyboard.press("Shift+A");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.keyboard.press("Escape");

  // So does focus going there with no press.
  await item("All notes").focus();
  await page.keyboard.press("g");
  await editor(page).focus();
  await page.keyboard.press("Shift+A");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.keyboard.press("Escape");

  // And so does time: a g long after a g is a first g again, and the one after it goes to the first row.
  await item("Zebra").focus();
  await page.keyboard.press("g");
  await page.waitForTimeout(1800);
  await page.keyboard.press("g");
  await expect(item("Zebra")).toBeFocused();
  await page.keyboard.press("g");
  await expectSelected(item("All notes"), "the first row");
});

test("a letter typed in a note right after a sequence was given up elsewhere arrives in its text", async ({ page }) => {
  await signIn(page, { "keybindings.notes.all": ["g a"] });
  const note = await perform(page, { type: "note.create", text: "# Plum\n\nwords" });
  await open(page, `/note/${note.id}`, false);
  await expect(editor(page)).toContainText("words");
  await page.getByRole("tree").getByRole("treeitem", { name: "All notes", exact: true }).focus();
  await page.keyboard.press("g");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("xa");
  await expect(editor(page).locator(".cm-line").last()).toHaveText("wordsxa");
  await expect(page).toHaveURL(new RegExp(`${note.id}$`));
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Plum\n\nwordsxa");
});

test("za expands and collapses the selected row: a note's card in a folder's list, and a folder in the tree", async ({ page }) => {
  await signIn(page);
  const work = await perform(page, { type: "folder.create", name: "Work" });
  await perform(page, { type: "folder.create", name: "Plans", parentId: work.id });
  await perform(page, { type: "note.create", text: "# Plum\n\nwords of the plum" });
  await open(page, "/folder/all");
  const cards = page.locator(".cards > li");
  await expect(cards).toHaveCount(1);
  const chevron = cards.getByRole("button", { name: /^(Expand|Collapse) Plum$/ });
  await page.keyboard.press("j");
  await expectSelected(cards.nth(0), "the card");
  await keys(page, "z", "a");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(cards.nth(0).locator(".cm-content")).toContainText("words of the plum");
  await expectSelected(cards.nth(0), "the card, expanded");
  await keys(page, "z", "a");
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/folder\/all$/);

  const item = (name: string) => page.getByRole("tree").getByRole("treeitem", { name, exact: true });
  await item("Work").focus();
  await expect(item("Work")).toHaveAttribute("aria-expanded", "false");
  await keys(page, "z", "a");
  await expect(item("Work")).toHaveAttribute("aria-expanded", "true");
  await expect(item("Plans")).toBeVisible();
  await keys(page, "z", "a");
  await expect(item("Work")).toHaveAttribute("aria-expanded", "false");
});

test("inside what an embed draws in a note, vim's list, search and tab keys do nothing: focus there is the embed's, and so are the keys", async ({ page }) => {
  await signIn(page);
  await perform(page, { type: "note.create", text: "# Plum\n\nwords" });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\nabove\n:::kanban{}\n## To do\n- write\n- review\n\n## Doing\n- build\n:::\nbelow\n" });
  await open(page, "/folder/all");
  await page.locator(".cards > li").first().waitFor();
  // A note opened from a previewed list takes the list's place, so the list is kept first.
  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "All notes" }).dblclick();
  await page.goto(`/note/${note.id}`);
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(2);
  // A board's column is a named list of cards, which outside a note vim's keys would move through and open.
  const cards = page.locator(".cm-content .embed").getByRole("list", { name: "To do cards" }).getByRole("listitem");
  await expect(cards).toHaveText(["write", "review"]);
  // The pointer puts focus on one of the board's own buttons, which is in the same column as the list.
  const colour = page.locator(".cm-content .embed").getByRole("button", { name: "Colour of To do: no colour" });
  await colour.focus();
  for (const press of [["Shift+G"], ["g", "g"], ["Control+d"], ["/"], ["g", "t"], ["j"], ["k"]]) {
    await keys(page, ...press);
    await expect(colour, `${press.join(" ")} leaves focus where it was`).toBeFocused();
    await expect(page.locator("[data-vim-at]"), `${press.join(" ")} selects no row`).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${note.id}$`));
  }
});
