import { expect, test, type Page } from "@playwright/test";
import { listedNote, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const stored = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text) as Record<string, unknown>;
const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const editors = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lines = (page: Page) => page.locator(".cm-line");
/** The line vim keeps under the editor: the mode, and the keys of a command not yet finished. */
const statusLine = (page: Page, group = 0) => page.locator(".cm-vim-panel").nth(group);
/** Opens a note from the list of every note, as a preview with the cursor in it. */
async function openNote(page: Page, title: string) {
  await openAllNotes(page);
  await listedNote(page, title).click();
}
const tabs = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group).getByRole("tab");
const italic = (page: Page) => tabs(page).evaluateAll((els) => els.map((el) => getComputedStyle(el).fontStyle === "italic"));
const hows = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => c.reverts?.how ?? "edit");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await page.keyboard.press("Enter");
};

/** Signs in with vim mode on, and a note for each text. */
async function withVim(page: Page, ...texts: string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const notes = [];
  for (const noteText of texts) notes.push(await perform(page, { type: "note.create", text: noteText }));
  return notes;
}

/** Opens a note with the cursor in it, in normal mode at the top. */
async function edit(page: Page, noteId: string) {
  await page.goto(`/note/${noteId}`);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await editor(page).click();
  await keys(page, "g", "g");
}

test("vim mode is off until it is turned on in settings, and turning it on or off reaches every open editor at once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const alpha = await perform(page, { type: "note.create", text: "# Alpha" });
  const beta = await perform(page, { type: "note.create", text: "# Beta" });
  await page.goto("/settings");
  const vim = page.getByRole("tabpanel").getByRole("region", { name: "Vim mode", exact: true });
  await expect(vim.getByRole("checkbox", { name: "On" }).first()).not.toBeChecked();
  await expect(vim).toContainText("Vim mode is off until you turn it on here.");

  await page.goto(`/note/${alpha.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("x");
  await expect(lines(page)).toHaveText(["# Alphax"]);
  await expect(statusLine(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("Beta");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Beta");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await page.keyboard.press("Control+o");
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/note\/beta-/);
  await run(page, "Split editor right");
  await expect(editors(page)).toHaveCount(2);

  await run(page, "Go to Settings");
  await vim.getByRole("checkbox", { name: "On" }).first().check();
  await expect.poll(() => stored(page)).toEqual({ "vim.enabled": true });
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Settings JSON" })).toContainText('"vim.enabled": true');
  await expect(statusLine(page)).toHaveCount(0);

  await page.goBack();
  await expect(editors(page)).toHaveCount(2);
  await expect(statusLine(page, 0)).toHaveText("--NORMAL--");
  await expect(statusLine(page, 1)).toHaveText("--NORMAL--");
  await editor(page, 0).click();
  await keys(page, "g", "g", "Shift+A", "!", "Escape", "0", "w", "x");
  await expect(editor(page, 0).locator(".cm-line")).toHaveText(["# lphax!"]);
  await editor(page, 1).click();
  await keys(page, "g", "g", "Shift+A", "!", "Escape");
  await expect(editor(page, 1).locator(".cm-line")).toHaveText(["# Beta!"]);

  await run(page, "Disable plugin: Vim mode");
  await expect(statusLine(page)).toHaveCount(0);
  await expect.poll(() => stored(page)).toEqual({});
  await editor(page, 0).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("jk");
  await expect(editor(page, 0).locator(".cm-line")).toHaveText(["# lphax!jk"]);
  await expect.poll(() => text(page, beta.id)).toBe("# Beta!");
});

test("motions move the cursor by character, word, line, and document, with counts", async ({ page }) => {
  const [note] = await withVim(page, "# Moves\nalpha beta gamma\ndelta epsilon zeta\neta theta iota");
  await edit(page, note!.id);

  await keys(page, "j", "w", "x");
  await expect(lines(page).nth(1)).toHaveText("alpha eta gamma");
  await keys(page, "$", "x", "0", "x");
  await expect(lines(page).nth(1)).toHaveText("lpha eta gamm");
  await keys(page, "j", "l", "l", "x");
  await expect(lines(page).nth(2)).toHaveText("deta epsilon zeta");
  await keys(page, "e", "x", "b", "x");
  await expect(lines(page).nth(2)).toHaveText("et epsilon zeta");
  await keys(page, "Shift+G", "x", "k", "h", "2", "w", "x");
  await keys(page, "g", "g", "3", "x");

  await expect(lines(page)).toHaveText(["oves", "lpha eta gamm", "et epsilon eta", "ta theta iota"]);
  await expect.poll(() => text(page, note!.id)).toBe("oves\nlpha eta gamm\net epsilon eta\nta theta iota");
});

test("insert commands open typing where they say, and operators delete, change, yank, put, and repeat", async ({ page }) => {
  const [note] = await withVim(page, "# Edit\none two three\nfour five six\nseven eight nine");
  await edit(page, note!.id);

  await keys(page, "j", "i");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.keyboard.type("A-");
  await keys(page, "Escape", "a", "B", "Escape", "Shift+A", "!", "Escape", "Shift+I", ">", "Escape");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await expect(lines(page).nth(1)).toHaveText(">A-Bone two three!");
  await page.keyboard.press("o");
  await page.keyboard.type("below");
  await keys(page, "Escape", "Shift+O");
  await page.keyboard.type("above");
  await page.keyboard.press("Escape");
  await expect(lines(page)).toHaveText(["# Edit", ">A-Bone two three!", "above", "below", "four five six", "seven eight nine"]);

  await keys(page, "Shift+G", "d", "w", "c", "w");
  await page.keyboard.type("EIGHT");
  await keys(page, "Escape", "w", "x", ".");
  await expect(lines(page).last()).toHaveText("EIGHT ne");
  await keys(page, "g", "g", "d", "d", "y", "y", "Shift+G", "p", "k", "y", "y", "g", "g", "Shift+P");

  const expected = ["EIGHT ne", ">A-Bone two three!", "above", "below", "four five six", "EIGHT ne", ">A-Bone two three!"];
  await expect(lines(page)).toHaveText(expected);
  await expect.poll(() => text(page, note!.id)).toBe(expected.join("\n"));
});

test("visual mode selects by character and by line, and a search moves to each match", async ({ page }) => {
  const [note] = await withVim(page, "# Pick\nred green blue\ncyan magenta yellow\nblack white gray");
  await edit(page, note!.id);

  await keys(page, "j", "v");
  await expect(statusLine(page)).toHaveText("--VISUAL--");
  await keys(page, "e", "d");
  await expect(lines(page).nth(1)).toHaveText("green blue");
  await keys(page, "j", "Shift+V");
  await expect(statusLine(page)).toHaveText("--VISUAL LINE--");
  await keys(page, "y", "Shift+G", "p");
  await expect(lines(page)).toHaveText(["# Pick", "green blue", "cyan magenta yellow", "black white gray", "cyan magenta yellow"]);

  await keys(page, "g", "g", "/");
  await page.keyboard.type("magenta");
  await keys(page, "Enter", "n", "x");
  await expect(lines(page).nth(4)).toHaveText("cyan agenta yellow");
  await keys(page, "k", "Shift+V", "d");

  await expect(lines(page)).toHaveText(["# Pick", "green blue", "cyan magenta yellow", "cyan agenta yellow"]);
  expect(await page.evaluate(() => document.querySelectorAll(".cm-line")[1]!.textContent)).toBe(" green blue");
});

test("u and ctrl+r are the app's undo and redo: local for typing not yet saved, and a recorded change for typing that was", async ({ page }) => {
  const [note] = await withVim(page, "# Undo\nbase");
  await edit(page, note!.id);
  const sent: string[] = [];
  page.on("request", (request) => /"note\.(write|undo|redo)"/.test(request.postData() ?? "") && sent.push(/"type":"([a-z.]+)"/.exec(request.postData()!)![1]!));

  await keys(page, "Shift+G", "Shift+A");
  await page.keyboard.type(" typed");
  await keys(page, "Escape", "u");
  await expect(lines(page)).toHaveText(["# Undo", "base"]);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(sent).toEqual([]);

  await page.keyboard.press("Shift+A");
  await page.keyboard.type(" kept");
  await page.keyboard.press("Escape");
  await expect.poll(() => hows(page, note!.id)).toEqual(["edit", "edit"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.keyboard.press("u");
  await expect(lines(page)).toHaveText(["# Undo", "base"]);
  await expect.poll(() => hows(page, note!.id)).toEqual(["edit", "edit", "undo"]);

  await page.keyboard.press("Control+r");
  await expect(lines(page)).toHaveText(["# Undo", "base kept"]);
  await expect.poll(() => hows(page, note!.id)).toEqual(["edit", "edit", "undo", "redo"]);
  expect(sent).toEqual(["note.write", "note.undo", "note.redo"]);
  await expect.poll(() => text(page, note!.id)).toBe("# Undo\nbase kept");

  await keys(page, "x", "u");
  await expect(lines(page)).toHaveText(["# Undo", "base kept"]);
  await keys(page, "x");
  await expect(lines(page)).toHaveText(["# Undo", "basekept"]);
});

test(":w saves what is typed now, ⌘S does too, and :q closes the tab", async ({ page }) => {
  const [note] = await withVim(page, "# Save\nbody");
  await edit(page, note!.id);

  await keys(page, "Shift+G", "Shift+A");
  await page.keyboard.type(" one");
  const quick = page.waitForRequest((request) => request.postData()?.includes('"note.write"') ?? false, { timeout: 700 });
  await page.keyboard.press("ControlOrMeta+s");
  await quick;
  await expect.poll(() => text(page, note!.id)).toBe("# Save\nbody one");

  await page.keyboard.type(" two");
  await keys(page, "Escape", ":");
  await page.keyboard.type("w");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note!.id)).toBe("# Save\nbody one two");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await expect(editor(page)).toBeFocused();

  await page.keyboard.press(":");
  await page.keyboard.type("q");
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test("ctrl+o and ctrl+i go back and forward through the notes visited, into a closed tab and back from a page", async ({ page }) => {
  await withVim(page, "# Alpha", "# Beta", "# Gamma");
  await page.goto("/");
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    await openNote(page, title);
    await expect(page).toHaveURL(new RegExp(`/note/${title.toLowerCase()}-`));
  }

  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await expect(editor(page)).toBeFocused();
  await keys(page, "Shift+A", "!", "Escape");
  await expect(lines(page)).toHaveText(["# Beta!"]);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/alpha-/);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/alpha-/);
  await page.keyboard.press("Meta+o");
  await page.keyboard.press("Meta+i");
  await expect(page).toHaveURL(/\/note\/alpha-/);

  await page.keyboard.press("Control+i");
  await expect(page).toHaveURL(/\/note\/beta/);
  await page.keyboard.press("Control+i");
  await expect(page).toHaveURL(/\/note\/gamma-/);
  await page.keyboard.press("Control+i");
  await expect(page).toHaveURL(/\/note\/gamma-/);

  await run(page, "Close all tabs");
  await expect(tabs(page)).toHaveCount(0);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/gamma-/);
  await expect(tabs(page)).toHaveText(["Gamma"]);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/beta/);

  await run(page, "Go to History");
  await expect(page).toHaveURL(/\/history$/);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/beta/);
  await openNote(page, "Alpha");
  await expect(page).toHaveURL(/\/note\/alpha-/);
  await page.keyboard.press("Control+i");
  await expect(page).toHaveURL(/\/note\/alpha-/);
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/beta/);
});

test("in insert mode ctrl+o runs one normal command and ctrl+i types a tab, and neither leaves the note", async ({ page }) => {
  await withVim(page, "# Alpha", "# Beta");
  await page.goto("/");
  await openNote(page, "Alpha");
  await openNote(page, "Beta");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await editor(page).click();

  await keys(page, "g", "g", "Shift+A", "Control+o");
  await expect(statusLine(page)).toHaveText("--NORMAL(C-O)--");
  await page.keyboard.press("0");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.keyboard.type("Z");
  await page.keyboard.press("Control+i");
  await page.keyboard.type("Y");
  await expect(page).toHaveURL(/\/note\/beta-/);
  expect(await page.evaluate(() => document.querySelector(".cm-line")!.textContent)).toBe("Z\tY# Beta");

  await keys(page, "Escape", "Control+o");
  await expect(page).toHaveURL(/\/note\/alpha-/);
});

test("moving through a note in a preview tab leaves it a preview, and an edit keeps the tab", async ({ page }) => {
  await withVim(page, "# Alpha\nsecond line\nthird line");
  await page.goto("/");
  await openNote(page, "Alpha");
  await editor(page).click();

  await keys(page, "g", "g", "j", "w", "$", "Shift+G", "v", "k", "Escape", "/");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  expect(await italic(page)).toEqual([false, true]);

  await page.keyboard.press("x");
  await expect(lines(page).nth(1)).toHaveText("econd line");
  await expect.poll(() => italic(page)).toEqual([false, false]);
});

test("the cursor moves across an embed, which is shown as written while the cursor is on it and drawn again after", async ({ page }) => {
  const [note] = await withVim(page, "# Laps\nTime ::stopwatch{} here\nend");
  await edit(page, note!.id);
  const watch = page.getByRole("button", { name: /^Stopwatch/ });

  await page.keyboard.press("j");
  await expect(watch).toBeVisible();
  await expect(page.locator(".cm-fat-cursor")).toHaveText("T");
  await page.keyboard.press("w");
  await expect(watch).toHaveCount(0);
  await expect(lines(page).nth(1)).toHaveText("Time ::stopwatch{} here");
  await expect(page.locator(".cm-fat-cursor")).toHaveText(":");
  await page.keyboard.press("$");
  await expect(watch).toBeVisible();
  await expect(page.locator(".cm-fat-cursor")).toHaveText("e");
  await keys(page, "j", "k", "0");
  await expect(watch).toBeVisible();

  await keys(page, "d", "d");
  await expect(lines(page)).toHaveText(["# Laps", "end"]);
  await page.keyboard.press("u");
  await expect(lines(page)).toHaveCount(3);
  await expect(watch).toBeVisible();
  await keys(page, "g", "g", "j", "w", "x");
  await expect(lines(page).nth(1)).toHaveText("Time :stopwatch{} here");
  await expect.poll(() => text(page, note!.id)).toBe("# Laps\nTime :stopwatch{} here\nend");
});

test("Escape closes what is open before it leaves insert mode, and the app's keys still run from normal mode", async ({ page }) => {
  const [note] = await withVim(page, "# Keys\nsecond");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true, "keybindings.view.toggleInspector": ["mod+shift+u"] }), baseRevision: 1 });
  await edit(page, note!.id);

  await page.keyboard.press("j");
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("dialog", { name: "Go to note" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await editor(page).focus();
  await page.keyboard.press("x");
  await expect(lines(page)).toHaveText(["# Keys", "econd"]);

  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await page.keyboard.press("i");
  await page.keyboard.type("S");
  await page.keyboard.press("ControlOrMeta+Shift+U");
  const popover = page.getByRole("dialog");
  await expect(popover).toBeVisible();
  await expect(editor(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await page.keyboard.type("s");
  await page.keyboard.press("Escape");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await page.keyboard.press("x");
  await expect(lines(page)).toHaveText(["# Keys", "Second"]);
});

test("ctrl+r in insert mode is not redo: it sends nothing and puts nothing back", async ({ page }) => {
  const [note] = await withVim(page, "# Redo\nbase");
  await edit(page, note!.id);
  const sent: string[] = [];
  page.on("request", (request) => /"note\.(undo|redo)"/.test(request.postData() ?? "") && sent.push(/"type":"([a-z.]+)"/.exec(request.postData()!)![1]!));

  await keys(page, "Shift+G", "Shift+A");
  await page.keyboard.type(" local");
  await keys(page, "Escape", "u");
  await expect(lines(page)).toHaveText(["# Redo", "base"]);
  await keys(page, "i", "Control+r");
  await expect(statusLine(page)).toHaveText("--INSERT--");
  await expect(lines(page)).toHaveText(["# Redo", "base"]);
  await keys(page, "Escape", "v", "Control+r", "Escape");
  await expect(lines(page)).toHaveText(["# Redo", "base"]);

  await page.keyboard.press("Shift+A");
  await page.keyboard.type(" saved");
  await page.keyboard.press("Escape");
  await expect.poll(() => hows(page, note!.id)).toEqual(["edit", "edit"]);
  await page.keyboard.press("u");
  await expect.poll(() => hows(page, note!.id)).toEqual(["edit", "edit", "undo"]);
  await expect(lines(page)).toHaveText(["# Redo", "base"]);
  await keys(page, "i", "Control+r");
  await page.keyboard.type("x");
  await expect(lines(page)).toHaveText(["# Redo", "basex"]);
  await page.waitForTimeout(300);
  expect(sent).toEqual(["note.undo"]);
});

test("ctrl+o and ctrl+i are left to a field that has focus, vim's own prompt included", async ({ page }) => {
  await withVim(page, "# Alpha", "# Beta");
  await page.goto("/");
  await openNote(page, "Alpha");
  await openNote(page, "Beta");
  await expect(page).toHaveURL(/\/note\/beta-/);
  await expect(statusLine(page)).toHaveText("--NORMAL--");

  await openAllNotes(page);
  await page.getByRole("searchbox", { name: "Search notes" }).click();
  await page.keyboard.press("Control+o");
  await page.keyboard.type("a");
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveValue("a");
  await expect(page).toHaveURL(/\/folder\/all$/);
  await tabs(page).filter({ hasText: "Beta" }).click();
  await expect(page).toHaveURL(/\/note\/beta-/);

  await editor(page).click();
  await page.keyboard.press(":");
  await expect(page.locator(".cm-vim-panel input")).toBeFocused();
  await page.keyboard.press("Control+o");
  await page.keyboard.press("Control+i");
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/note\/beta-/);
  await page.keyboard.press("Escape");

  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/alpha-/);
});

test("when vim's editing can't be loaded the Plugins page says so, notes are edited plainly, and its keys aren't bound", async ({ page }) => {
  await page.route(/\/editing[-.][^/]*$/, (route) => route.abort());
  await withVim(page, "# Alpha", "# Beta");
  await page.goto("/");
  await openNote(page, "Alpha");
  await openNote(page, "Beta");
  await expect(page).toHaveURL(/\/note\/beta-/);

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("jk");
  await expect(lines(page)).toHaveText(["# Betajk"]);
  await expect(statusLine(page)).toHaveCount(0);
  await openAllNotes(page);
  await noteCard(page, "Beta").focus();
  await page.keyboard.press("Control+o");
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/folder\/all$/);

  await run(page, "Go to Plugins");
  const vim = page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Vim mode" });
  await expect(vim.getByRole("checkbox")).toBeChecked();
  await expect(vim.getByRole("alert")).toHaveText("Failed: Vim's editing couldn't be loaded, so notes are edited without it. Reload the page to try again.");
  await run(page, "Go to Settings");
  await expect(page.getByText("keybindings.note.save")).toBeVisible();
  await expect(page.getByText("keybindings.vim.back")).toHaveCount(0);
});
