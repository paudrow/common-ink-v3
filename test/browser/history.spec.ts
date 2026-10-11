import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { connectAgent, listedNote, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const UNSEEN = "Changes you haven't seen";
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const rightRail = (page: Page) => page.getByRole("navigation", { name: "Right rail" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const editorLines = (page: Page) => page.locator(".cm-line");
const changes = (scope: Page | Locator) => scope.getByRole("list", { name: "Changes" }).getByRole("listitem");
const names = (scope: Page | Locator) => () => changes(scope).evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
const historyMode = (page: Page) => page.getByRole("region", { name: "History" });
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Ada's note, which she wrote and edited, her agent Claude then edited, and she edited again. */
async function sharedNote(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nAda's step" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 2, text: "# Plan\n\nAda's step\n\nClaude's step" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 3, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word" });
  return { id: note.id, claude };
}

async function openHistoryTab(page: Page, id: string) {
  await page.goto(`/note/${id}`);
  await inspector(page).getByRole("tab", { name: "History" }).click();
  return inspector(page).getByRole("tabpanel");
}

test("the inspector's History tab shows the open note's changes, newest first, with who made each and its diff", async ({ page }) => {
  const { id } = await sharedNote(page);

  const panel = await openHistoryTab(page, id);

  await expect.poll(names(panel)).toEqual(["Change 4 by Ada Lovelace", "Change 3 by Claude", "Change 2 by Ada Lovelace", "Change 1 by Ada Lovelace"]);
  const byClaude = changes(panel).nth(1);
  await expect(byClaude).toContainText("Claudeagent");
  await expect(byClaude).toContainText("+2 −0");
  await expect(byClaude.getByRole("insertion")).toHaveText(["", "Claude's step"]);
  await expect(byClaude.getByRole("deletion")).toHaveCount(0);
  await expect(changes(panel).first().getByRole("insertion")).toHaveText(["", "Ada's last word"]);

  const unseenChecks: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"diffs":false') && unseenChecks.push(request.url()));
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nTyped just now");
  await expect(changes(panel).first()).toHaveAccessibleName("Change 5 by Ada Lovelace");
  expect(unseenChecks).toEqual([]);
  await expect(changes(panel).first().getByRole("insertion")).toHaveText(["", "Typed just now"]);
});

test("in writing mode the History rail icon shows a dot when an agent edits the note, until the member looks at History", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nMine." });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+.");
  const icon = rightRail(page).getByRole("button", { name: "History" });
  await expect(icon).toBeVisible();

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" And more of mine.");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(icon).not.toHaveAccessibleDescription(UNSEEN);
  await expect(icon.locator(".unseen-dot")).toHaveCount(0);

  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 2, text: "# Draft\n\nMine. And more of mine.\n\nFrom Claude." });

  await expect(icon).toHaveAccessibleDescription(UNSEEN, { timeout: 15_000 });
  await expect(icon.locator(".unseen-dot")).toBeVisible();
  await expect(editorLines(page)).toHaveText(["# Draft", "", "Mine. And more of mine.", "", "From Claude."]);

  await icon.click();
  const popover = page.getByRole("dialog", { name: "History" });
  await expect(changes(popover).first()).toHaveAccessibleName("Change 3 by Claude");
  await expect(icon).not.toHaveAccessibleDescription(UNSEEN);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(icon.locator(".unseen-dot")).toHaveCount(0);

  await page.reload();
  await expect(icon).toBeVisible();
  await expect(editorLines(page)).toHaveCount(5);
  await expect(icon).not.toHaveAccessibleDescription(UNSEEN);
});

test("a note someone else changed while the member was away shows the dot when it's opened", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto(`/note/${id}`);

  const historyTab = inspector(page).getByRole("tab", { name: "History" });
  await expect(historyTab).toHaveAccessibleDescription(UNSEEN);
  await historyTab.click();
  await expect(changes(inspector(page))).toHaveCount(4);
  await expect(historyTab).toHaveAccessibleDescription("");
});

test("History mode shows changes across notes and filters them by author, by notes, and by date", async ({ page }) => {
  const { claude } = await sharedNote(page);
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await perform(page, { type: "note.create", text: "# Recipes" });

  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  const mode = historyMode(page);
  const shown = names(mode);
  const all = ["Change 1 to Recipes by Ada Lovelace", "Change 2 to Trip by Claude", "Change 1 to Trip by Ada Lovelace", "Change 4 to Plan by Ada Lovelace", "Change 3 to Plan by Claude", "Change 2 to Plan by Ada Lovelace", "Change 1 to Plan by Ada Lovelace"];
  await expect.poll(shown).toEqual(all);
  await expect(changes(mode).nth(1).getByRole("insertion")).toHaveText(["", "Pack light."]);

  const authors = mode.getByRole("group", { name: "Authors" });
  await authors.getByRole("button", { name: "Claude (agent)" }).click();
  await expect.poll(shown).toEqual(["Change 2 to Trip by Claude", "Change 3 to Plan by Claude"]);
  await authors.getByRole("button", { name: "Ada Lovelace" }).click();
  await expect.poll(shown).toEqual(all);
  await authors.getByRole("button", { name: "Claude (agent)" }).click();
  await expect.poll(shown).toEqual(all.filter((name) => name.endsWith("Ada Lovelace")));
  await mode.getByRole("button", { name: "Clear filters" }).click();

  await mode.getByRole("button", { name: "All notes" }).click();
  const scope = mode.getByRole("group", { name: "Notes to show" });
  await scope.getByRole("checkbox", { name: "Trip" }).check();
  await expect.poll(shown).toEqual(all.filter((name) => name.includes("to Trip")));
  await scope.getByRole("searchbox", { name: "Find a note" }).fill("rec");
  await expect(scope.getByRole("checkbox")).toHaveCount(1);
  await scope.getByRole("checkbox", { name: "Recipes" }).check();
  await expect(mode.getByRole("button", { name: "2 notes" })).toBeVisible();
  await expect.poll(shown).toEqual(all.filter((name) => !name.includes("to Plan")));
  await scope.getByRole("button", { name: "Show all notes" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(shown).toEqual(all);

  const day = (offset: number) => page.evaluate((days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, offset);
  await mode.getByLabel("From", { exact: true }).fill(await day(1));
  await expect(mode.getByText("No changes match these filters.")).toBeVisible();
  await mode.getByLabel("From", { exact: true }).fill(await day(0));
  await expect.poll(shown).toEqual(all);
  await mode.getByLabel("To", { exact: true }).fill(await day(0));
  await expect.poll(shown).toEqual(all);
  await mode.getByLabel("From", { exact: true }).fill("");
  await mode.getByLabel("To", { exact: true }).fill(await day(-1));
  await expect(mode.getByText("No changes match these filters.")).toBeVisible();

  await mode.getByRole("button", { name: "Clear filters" }).click();
  await changes(mode).first().getByRole("button", { name: "Recipes" }).click();
  await expect(page).toHaveURL(/\/note\/recipes-[a-z0-9]{12}$/);
});

test("a revision can be labeled, and the note reverted to it as a new change", async ({ page }) => {
  const { id } = await sharedNote(page);
  const panel = await openHistoryTab(page, id);
  const second = changes(panel).filter({ hasText: "revision 2" });

  await second.getByRole("button", { name: "Label" }).click();
  await panel.getByRole("textbox", { name: "Label for revision 2" }).fill("Before Claude");
  await page.keyboard.press("Enter");
  await expect(second.locator(".label-chip")).toHaveText("Before Claude");
  await expect(second.getByRole("button", { name: "Rename label" })).toBeVisible();
  await expect(changes(panel).first().getByRole("button", { name: "Revert note to here" })).toHaveCount(0);

  await second.getByRole("button", { name: "Revert note to here" }).click();

  await expect(editorLines(page)).toHaveText(["# Plan", "", "Ada's step"]);
  await expect(changes(panel)).toHaveCount(5);
  const revert = changes(panel).first();
  await expect(revert).toHaveAccessibleName("Change 5 by Ada Lovelace");
  await expect(revert).toContainText("Reverted to revision 2");
  await expect(revert.getByRole("deletion")).toHaveText(["", "Claude's step", "", "Ada's last word"]);
  await expect(changes(panel).nth(1)).toContainText("Taken back out by change 5");
  await expect(changes(panel).nth(2)).toContainText("Taken back out by change 5");
  expect(await text(page, id)).toBe("# Plan\n\nAda's step");
  expect((await perform(page, { type: "note.read", id, revision: 4 })).text).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");

  await page.reload();
  await inspector(page).getByRole("tab", { name: "History" }).click();
  await expect(changes(inspector(page)).filter({ hasText: "revision 2" }).locator(".label-chip")).toHaveText("Before Claude");
});

test("a selection of changes is taken back out as one new change, and put back as another", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" }).click();
  await expect.poll(names(mode)).toEqual(["Change 3 to Plan by Claude"]);

  await mode.getByRole("checkbox", { name: "Select change 3 to Plan" }).check();
  const selection = mode.getByRole("group", { name: "Selected changes" });
  await expect(selection).toContainText("1 change selected");
  await expect(selection.getByRole("button", { name: "Put back selected" })).toBeDisabled();
  await selection.getByRole("button", { name: "Revert selected" }).click();

  await expect(changes(mode).first()).toContainText("Taken back out by change 5");
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
  await mode.getByRole("button", { name: "Clear filters" }).click();
  await expect(changes(mode).first()).toHaveAccessibleName("Change 5 to Plan by Ada Lovelace");
  await expect(changes(mode).first()).toContainText("Reverted change 3");

  await mode.getByRole("checkbox", { name: "Select change 3 to Plan" }).check();
  await expect(selection.getByRole("button", { name: "Revert selected" })).toBeDisabled();
  await selection.getByRole("button", { name: "Put back selected" }).click();

  await expect(changes(mode).first()).toHaveAccessibleName("Change 6 to Plan by Ada Lovelace");
  await expect(changes(mode).first()).toContainText("Reverted change 5");
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");

  await mode.getByRole("checkbox", { name: "Select change 3 to Plan" }).check();
  await selection.getByRole("button", { name: "Revert selected" }).click();
  await expect(changes(mode).first()).toHaveAccessibleName("Change 7 to Plan by Ada Lovelace");
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
});

test("several changes selected across two notes are reverted, one new change in each note", async ({ page }) => {
  const { id, claude } = await sharedNote(page);
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" }).click();
  await expect(changes(mode)).toHaveCount(2);

  for (const box of await mode.getByRole("checkbox", { name: /^Select change/ }).all()) await box.check();
  await mode.getByRole("button", { name: "Revert selected" }).click();

  await expect(changes(mode).filter({ hasText: "Taken back out" })).toHaveCount(2);
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
  expect(await text(page, trip.id)).toBe("# Trip");
});

test("undo and redo move through the note's history, across a closed tab and a reload", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const other = await perform(page, { type: "note.create", text: "# Other" });
  await page.reload();
  await openAllNotes(page);
  await page.getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  for (const typed of ["one", " two", " three"]) {
    await page.keyboard.type(typed);
    await expect(page.getByRole("status")).toHaveText("Saved");
  }
  const id = /([a-z0-9]{12})$/.exec(page.url())![1]!;

  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["one two"]);

  await openAllNotes(page);
  await listedNote(page, "Other").click();
  await expect(editorLines(page).first()).toHaveText("# Other");
  await page.getByRole("tab", { name: "Untitled" }).click();
  await expect(editorLines(page)).toHaveText(["one two"]);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["one"]);

  await page.reload();
  await expect(editorLines(page)).toHaveText(["one"]);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editorLines(page)).toHaveText(["one two"]);
  await page.keyboard.press("ControlOrMeta+y");
  await expect(editorLines(page)).toHaveText(["one two three"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["one two"]);

  const recorded = await perform(page, { type: "note.history", id });
  expect(recorded.map((c) => c.reverts?.how ?? "edit")).toEqual(["edit", "edit", "edit", "undo", "undo", "redo", "redo", "undo"]);
  expect(await text(page, id)).toBe("one two");
  expect(await text(page, other.id)).toBe("# Other");
});

test("undo takes back what was typed a moment ago without a word to the server, and leaves a text field's own undo alone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "kept" });
  await page.goto(`/note/${note.id}`);
  await openAllNotes(page);
  const beside = page.getByRole("region", { name: "Editor group 1" });
  await page.getByRole("tab", { name: "All notes" }).dragTo(beside, { targetPosition: { x: (await beside.boundingBox())!.width * 0.2, y: 200 } });
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(2);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");

  const sent: string[] = [];
  page.on("request", (request) => /"note\.(write|undo)"/.test(request.postData() ?? "") && sent.push(request.postData()!));
  await page.keyboard.type(" typed");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept"]);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(sent).toEqual([]);

  const filter = page.getByRole("searchbox", { name: "Filter notes" });
  await filter.fill("ke");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept"]);
  await page.waitForTimeout(500);
  expect((await perform(page, { type: "note.history", id: note.id })).map((c) => c.reverts?.how ?? "edit")).toEqual(["edit"]);

  await page.getByRole("tab", { name: "Untitled" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("redo");
  await page.keyboard.press("Enter");
  await expect(editorLines(page)).toHaveText(["kept typed"]);
});

const offline = (page: Page) => page.route("**/ops", (route) => route.abort());
const hows = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => c.reverts?.how ?? "edit");

test("undo takes back a paste the server never got, and typing saved before it is still undone through history", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "kept" });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" saved");
  await expect(page.getByRole("status")).toHaveText("Saved");

  await offline(page);
  await page.keyboard.insertText(" pasted while offline");
  await expect(page.getByRole("status")).toHaveText("Couldn't save. Retrying…");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept saved"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editorLines(page)).toHaveText(["kept saved pasted while offline"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept saved"]);

  await page.unroute("**/ops");
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 10_000 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept"]);
  await expect.poll(() => text(page, note.id)).toBe("kept");
  expect((await hows(page, note.id)).at(-1)).toBe("undo");
});

test("undoing typing not yet saved and then pressing undo again takes back one saved change, not two", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("one");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.keyboard.type(" two");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const id = /([a-z0-9]{12})$/.exec(page.url())![1]!;

  await page.keyboard.type(" three");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["one two"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await hows(page, id)).toEqual(["edit", "edit"]);

  const reads: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"note.read"') && reads.push(request.url()));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["one"]);
  await page.waitForTimeout(300);
  expect(reads).toEqual([]);
  await expect.poll(() => hows(page, id)).toEqual(["edit", "edit", "undo"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editorLines(page)).toHaveText(["one two"]);
  await expect.poll(() => hows(page, id)).toEqual(["edit", "edit", "undo", "redo"]);
  expect(await text(page, id)).toBe("one two");
});

test("an undo that can't reach the server says so where a failed save does", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "kept" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: "kept and more" });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();

  await offline(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("status")).toHaveText("Couldn't undo. Common Ink can't be reached.");
  await expect(editorLines(page)).toHaveText(["kept and more"]);

  await page.unroute("**/ops");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["kept"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("status")).toHaveText("There's nothing of yours to undo in this note");
});

test("an agent's edit read into the editor while the member types is never what the member's undo takes back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# T\n\nmine" });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" a");
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: "# T\n\nFrom Claude.\nmine" });
  // Typing without a pause is never sent, so the agent's edit arrives over it and lands after it in the editor.
  for (let typed = 0; (await editorLines(page).count()) < 4; typed++) {
    expect(typed).toBeLessThan(60);
    await page.keyboard.type("a");
    await page.waitForTimeout(200);
  }
  await expect(editorLines(page)).toHaveText(["# T", "", "From Claude.", /^mine a+$/]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page).nth(2)).toHaveText("From Claude.");
  await expect(editorLines(page).nth(3)).not.toHaveText(/a{5}/);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page).nth(2)).toHaveText("From Claude.");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await text(page, note.id)).toContain("From Claude.");
});

test("two members on one browser each have their own unseen changes", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto(`/note/${id}`);
  const historyTab = inspector(page).getByRole("tab", { name: "History" });
  await historyTab.click();
  await expect(changes(inspector(page))).toHaveCount(4);
  const mine = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ink.seen.")));
  const person = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as { person: { id: string } }).person.id);

  expect(mine).toHaveLength(1);
  expect(mine[0]!.endsWith(`.${person}`)).toBe(true);
});

test("Activity counts the changes the member made each day, and an agent's changes are the agent's", async ({ page }) => {
  await sharedNote(page);
  await page.goto("/history");
  const mode = historyMode(page);
  const activity = mode.getByRole("region", { name: "Activity" });
  const today = await page.evaluate(() => new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));

  await expect(activity).toContainText("3 changes by you in the last year");
  const cell = activity.getByRole("button", { name: `3 changes on ${today}` });
  await expect(cell).toHaveAttribute("data-level", "2");
  await expect(activity.getByRole("button", { name: /^0 changes on/ })).toHaveCount(await activity.getByRole("button").count() - 1);

  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" }).click();
  await expect(activity).toContainText("1 change by Claude in the last year");
  await expect(activity.getByRole("button", { name: `1 change on ${today}` })).toBeVisible();
  await mode.getByRole("button", { name: "Clear filters" }).click();

  await perform(page, { type: "note.create", text: "# One more" });
  await expect(activity).toContainText("4 changes by you in the last year", { timeout: 15_000 });
  await activity.getByRole("button", { name: `4 changes on ${today}` }).click();
  await expect(activity.getByRole("button", { name: `4 changes on ${today}` })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByLabel("From", { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(changes(mode)).toHaveCount(5);
});

test.describe("in a time zone whose date isn't UTC's right now", () => {
  // Kiritimati is 14 hours ahead of UTC and Etc/GMT+12 is 12 behind, so one of them is on another day with an hour to spare.
  test.use({ timezoneId: new Date().getUTCHours() >= 11 ? "Pacific/Kiritimati" : "Etc/GMT+12" });

  test("Activity puts a change on the member's own calendar day", async ({ page }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    await perform(page, { type: "note.create", text: "# Far east" });
    await page.goto("/history");
    const local = await page.evaluate(() => new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    const utc = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

    expect(local).not.toBe(utc);
    await expect(historyMode(page).getByRole("region", { name: "Activity" }).getByRole("button", { name: `1 change on ${local}` })).toBeVisible();
  });
});
