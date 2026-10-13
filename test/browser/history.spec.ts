import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Me, Note, OpInput } from "../../src/core/protocol.ts";
import { connectAgent, listedNote, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const UNSEEN = "Changes you haven't seen";
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const editorLines = (page: Page) => page.locator(".cm-line");
const historyMode = (page: Page) => page.getByRole("region", { name: "History" });
/** The rows of the list by time: each a change, or the saves of one sitting. */
const rows = (scope: Page | Locator) => scope.getByRole("listbox", { name: "Changes" }).getByRole("option");
const row = (scope: Page | Locator, says: string | RegExp) => rows(scope).filter({ hasText: says });
const tick = (item: Locator) => item.locator(".hist-check");
/** The notes of the list by note, and the rows under the ones that are open. */
const tree = (scope: Page | Locator) => scope.getByRole("tree", { name: "Notes that changed" });
const noteRow = (scope: Page | Locator, title: string) => tree(scope).locator('[aria-level="1"]').filter({ hasText: title });
/** Each row as it reads: its sentence, its lines added and removed, and whatever else it is marked with. */
const read = (items: Locator) => () =>
  items.evaluateAll((all) => all.map((el) => [el.querySelector(".hist-line")!.textContent!.trim().replace(/\s+/g, " "), ...[...el.querySelectorAll(".hist-meta > :not(time, .change-stat)")].map((mark) => mark.textContent)].join(" · ")));
const listed = (scope: Page | Locator) => read(rows(scope));
const picked = (scope: Page | Locator) => () => scope.locator('.hist-row[aria-selected="true"] .hist-line').evaluateAll((all) => all.map((el) => el.textContent!.trim().replace(/\s+/g, " ")));
/** The other pane: what everything picked did. */
const pane = (scope: Page | Locator) => scope.getByRole("region", { name: "What the selection did" });
/** The line that counts the selection, as its parts. */
const counted = (scope: Page | Locator) => () => pane(scope).locator(".hist-sum-text > *").evaluateAll((parts) => parts.map((part) => part.textContent));
const card = (scope: Page | Locator, title: string) => pane(scope).getByRole("region", { name: title, exact: true });
const cards = (scope: Page | Locator) => () => pane(scope).locator(".hist-file-name").evaluateAll((all) => all.map((el) => el.textContent));
/** Whole lines a diff adds and removes, and the words it marks inside a rewritten line. */
const added = (scope: Locator) => scope.locator("ins.diff-line .diff-text");
const removed = (scope: Locator) => scope.locator("del.diff-line .diff-text");
const revertDialog = (page: Page) => page.getByRole("dialog", { name: /^Revert/ });
const toast = (page: Page) => page.locator(".toast");
/** Opens the revert of everything picked and confirms it. */
async function revertPicked(page: Page, scope: Page | Locator) {
  await pane(scope).getByRole("button", { name: "Revert…" }).click();
  await revertDialog(page).getByRole("button", { name: "Revert", exact: true }).click();
  await expect(revertDialog(page)).toHaveCount(0);
}
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const reverts = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => c.reverts?.revisions ?? null);

/** Ada's note, which she wrote and edited, her agent Claude then edited, and she edited again. Her first two saves are one sitting, so one row. */
async function sharedNote(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nAda's step" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 2, text: "# Plan\n\nAda's step\n\nClaude's step" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 3, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word" });
  return { id: note.id, claude };
}
const PLAN = "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word";
const PLAN_ROWS = ["You edited · 2 saves", "Claude edited", "You wrote · 2 saves"];

/** Three notes: Plan as above, Trip that Ada wrote and Claude edited, and Recipes that Ada wrote. */
async function threeNotes(page: Page) {
  const { id, claude } = await sharedNote(page);
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  const recipes = await perform(page, { type: "note.create", text: "# Recipes" });
  return { plan: id, trip: trip.id, recipes: recipes.id, claude };
}
const THREE = ["You wrote Recipes", "Claude edited Trip", "You wrote Trip", "You edited Plan", "Claude edited Plan", "You wrote Plan · 2 saves"];

async function openHistoryTab(page: Page, id: string) {
  await page.goto(`/note/${id}`);
  await inspector(page).getByRole("tab", { name: "History" }).click();
  return inspector(page).getByRole("tabpanel");
}

test("the inspector's History tab lists the note's changes with a tick each, over what the picked ones did: the latest on arriving, and no row of buttons", async ({ page }) => {
  const { id } = await sharedNote(page);

  const panel = await openHistoryTab(page, id);

  await expect.poll(listed(panel)).toEqual(["You edited", "Claude edited", "You wrote · 2 saves"]);
  await expect(rows(panel).locator(".change-stat")).toHaveText(["+2 −0", "+2 −0", "+3 −0"]);
  await expect.poll(picked(panel)).toEqual(["You edited"]);
  await expect.poll(counted(panel)).toEqual(["1 change", "1 note", "+2 −0"]);
  await expect(added(pane(panel))).toHaveText(["", "Ada's last word"]);

  await row(panel, "Claude edited").click();
  await expect.poll(picked(panel)).toEqual(["Claude edited"]);
  await expect(added(pane(panel))).toHaveText(["", "Claude's step"]);
  await expect(pane(panel).locator("del")).toHaveCount(0);
  await expect(pane(panel).locator(".diff")).toHaveCount(1);
  // The rows hold nothing to press, and one Revert acts on what is picked.
  await expect(rows(panel).getByRole("button")).toHaveCount(0);
  await expect(rows(panel).getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Revert|Label/ })).toHaveText(["Revert…"]);

  const unseenChecks: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"diffs":false,"limit":100') && unseenChecks.push(request.url()));
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nTyped just now");
  // What she types now is the same sitting as her last save, so the row grows.
  await expect.poll(listed(panel)).toEqual(["You edited · 2 saves", "Claude edited", "You wrote · 2 saves"]);
  await expect(rows(panel).locator(".change-stat").first()).toHaveText("+4 −0");
  expect(unseenChecks).toEqual([]);
  await rows(panel).first().click();
  await expect(added(pane(panel))).toHaveText(["", "Ada's last word", "", "Typed just now"]);
});

test("focus shows no History mark: the way out is its only button, and the dot waits on the inspector's History tab", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nMine." });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.locator(".tab-row").getByRole("button").filter({ visible: true })).toHaveCount(1);
  await expect(page.locator(".tab-row").getByRole("button").filter({ visible: true })).toHaveAccessibleName("Focus");

  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: "# Draft\n\nMine.\n\nFrom Claude." });
  await expect(editorLines(page)).toHaveText(["# Draft", "", "Mine.", "", "From Claude."], { timeout: 15_000 });
  await expect(page.locator(".tab-row").getByRole("button").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await page.locator(".group-body").filter({ visible: true }).boundingBox())!.width).toBe(1280);

  await page.getByRole("button", { name: "Focus" }).click();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAccessibleDescription(UNSEEN);
});

test("a note someone else changed while the member was away shows the dot when it's opened", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto(`/note/${id}`);

  // The member has picked no tab: Info shows, which counts nothing as seen.
  const historyTab = inspector(page).getByRole("tab", { name: "History" });
  await expect(inspector(page).getByRole("tab", { selected: true })).toHaveText("Info");
  await expect(historyTab).toHaveAccessibleDescription(UNSEEN);
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  const icon = page.getByRole("navigation", { name: "Inspector bar" }).getByRole("button", { name: "History" });
  await expect(icon).toHaveAccessibleDescription(UNSEEN);
  await expect(icon.locator(".unseen-dot")).toBeVisible();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(historyTab).toHaveAccessibleDescription(UNSEEN);
  await historyTab.click();
  await expect(rows(inspector(page))).toHaveCount(3);
  await expect(historyTab).toHaveAccessibleDescription("");
});

test("History is two panes: every change by time under its day with a tick, the saves of one sitting as one row, and the first row's diff showing", async ({ page }) => {
  const { recipes } = await threeNotes(page);

  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  const mode = historyMode(page);
  await expect.poll(listed(mode)).toEqual(THREE);
  await expect(rows(mode).locator(".change-stat")).toHaveText(["+1 −0", "+2 −0", "+1 −0", "+2 −0", "+2 −0", "+3 −0"]);
  await expect(mode.locator(".hist-day")).toHaveText(["Today"]);
  await expect(mode.getByRole("radio", { checked: true })).toHaveText(["By time", "Everyone"]);
  // A person is a circle of initials and an agent a rounded square with its mark.
  await expect(row(mode, "You wrote Recipes").locator(".avatar")).toHaveText("AL");
  await expect(row(mode, "Claude edited Trip").locator(".avatar.agent svg")).toHaveCount(1);

  // The first row is picked on arriving, so the other pane is never empty.
  await expect.poll(picked(mode)).toEqual(["You wrote Recipes"]);
  await expect.poll(counted(mode)).toEqual(["1 change", "1 note", "+1 −0"]);
  await expect.poll(cards(mode)).toEqual(["Recipes"]);
  await expect(added(card(mode, "Recipes"))).toHaveText(["# Recipes"]);

  await row(mode, "Claude edited Plan").click();
  await expect.poll(picked(mode)).toEqual(["Claude edited Plan"]);
  await expect.poll(cards(mode)).toEqual(["Plan"]);
  await expect(added(card(mode, "Plan"))).toHaveText(["", "Claude's step"]);
  await expect(card(mode, "Plan").locator(".change-stat")).toHaveText("+2 −0");
  // Unchanged lines are folded to a count that opens to them.
  await expect(card(mode, "Plan").locator(".diff-line.same .diff-text")).toHaveText(["", "Ada's step"]);
  await card(mode, "Plan").getByRole("button", { name: "⋯ 1 unchanged line" }).click();
  await expect(card(mode, "Plan").locator(".diff-line.same .diff-text")).toHaveText(["# Plan", "", "Ada's step"]);

  // Nothing to press on a row, and one action for the selection.
  await expect(rows(mode).getByRole("button")).toHaveCount(0);
  await expect(pane(mode).getByRole("button")).toHaveText(["Revert…", "Plan", ""]);
  for (const gone of ["Clear", "Clear filters", "All notes", "Open note", "Label", "Revert note to here…"]) await expect(mode.getByRole("button", { name: gone, exact: true })).toHaveCount(0);
  await expect(mode.locator('input[type="date"]')).toHaveCount(0);

  await row(mode, "You wrote Recipes").click();
  await card(mode, "Recipes").getByRole("button", { name: "Recipes", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/note/recipes-${recipes}$`));
});

test("a click shows one change, ⌘-click and the tick add or skip, shift-click takes a range, and the other pane is the combined diff across notes with what was skipped between", async ({ page }) => {
  await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(listed(mode)).toEqual(THREE);

  await row(mode, "You wrote Plan").click();
  await expect.poll(counted(mode)).toEqual(["1 change", "2 saves", "1 note", "+3 −0"]);
  await row(mode, "You edited Plan").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(picked(mode)).toEqual(["You edited Plan", "You wrote Plan"]);
  // Claude's change between the two is not picked: the note's card is two diffs, the second saying what it skips.
  await expect.poll(counted(mode)).toEqual(["2 changes", "3 saves", "1 note", "+5 −0"]);
  const plan = card(mode, "Plan");
  await expect(plan.locator(".hist-run")).toHaveCount(2);
  await expect(plan.locator(".hist-skip")).toHaveText(["1 save skipped"]);
  await expect(added(plan.locator(".hist-run").first())).toHaveText(["# Plan", "", "Ada's step"]);
  await expect(added(plan.locator(".hist-run").last())).toHaveText(["", "Ada's last word"]);

  await tick(row(mode, "Claude edited Trip")).click();
  await expect.poll(picked(mode)).toEqual(["Claude edited Trip", "You edited Plan", "You wrote Plan"]);
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);
  await expect.poll(counted(mode)).toEqual(["3 changes", "4 saves", "2 notes", "+7 −0"]);
  await expect(added(card(mode, "Trip"))).toHaveText(["", "Pack light."]);

  // Taking Claude's change of Plan in makes the note's changes one run, and its card one diff of the whole.
  await tick(row(mode, "Claude edited Plan")).click();
  await expect(plan.locator(".hist-run")).toHaveCount(1);
  await expect(plan.locator(".hist-skip")).toHaveCount(0);
  await expect(added(plan)).toHaveText(["# Plan", "", "Ada's step", "", "Claude's step", "", "Ada's last word"]);
  await tick(row(mode, "Claude edited Plan")).click();
  await expect(plan.locator(".hist-run")).toHaveCount(2);

  await row(mode, "You wrote Recipes").click();
  await expect.poll(picked(mode)).toEqual(["You wrote Recipes"]);
  await row(mode, "You edited Plan").click({ modifiers: ["Shift"] });
  await expect.poll(picked(mode)).toEqual(THREE.slice(0, 4));
  await expect.poll(counted(mode)).toEqual(["4 changes", "3 notes", "+6 −0"]);
  await expect.poll(cards(mode)).toEqual(["Recipes", "Trip", "Plan"]);
  await row(mode, "Claude edited Trip").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(picked(mode)).toEqual(["You wrote Recipes", "You wrote Trip", "You edited Plan"]);
});

test("the list is worked from the keyboard: j and k and the arrows move and show, x and space tick, a takes everything, Escape goes back to one, Enter opens the note", async ({ page }) => {
  const { trip } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(picked(mode)).toEqual(["You wrote Recipes"]);
  const list = mode.getByRole("listbox", { name: "Changes" });
  await expect(list).toHaveAttribute("aria-multiselectable", "true");

  await list.focus();
  await page.keyboard.press("j");
  await expect.poll(picked(mode)).toEqual(["Claude edited Trip"]);
  await expect.poll(cards(mode)).toEqual(["Trip"]);
  await expect.poll(() => list.evaluate((el) => document.getElementById(el.getAttribute("aria-activedescendant")!)?.textContent)).toContain("Claude edited Trip");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(picked(mode)).toEqual(["You edited Plan"]);
  await page.keyboard.press("k");
  await expect.poll(picked(mode)).toEqual(["You wrote Trip"]);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(picked(mode)).toEqual(["You wrote Trip", "You edited Plan"]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(picked(mode)).toEqual(["Claude edited Trip"]);
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect.poll(picked(mode)).toEqual([]);
  await page.keyboard.press("Space");
  await expect.poll(picked(mode)).toEqual(["You wrote Trip"]);
  await page.keyboard.press("a");
  await expect.poll(picked(mode)).toEqual(THREE.map((r) => r.replace(" · 2 saves", "")));
  await page.keyboard.press("Escape");
  await expect.poll(picked(mode)).toEqual(["You wrote Trip"]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/note/trip-${trip}$`));
});

test("the list switches between By time and By note, each member's own pick kept, and a note's row with its tick stands for all its changes", async ({ page }) => {
  await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(listed(mode)).toEqual(THREE);

  await mode.getByRole("radio", { name: "By note" }).click();
  await expect(mode.getByRole("listbox")).toHaveCount(0);
  await expect.poll(read(tree(mode).locator('[aria-level="1"]'))).toEqual(["+1 −0 Recipes · 1 change · You", "+3 −0 Trip · 2 changes · Claude, You", "+7 −0 Plan · 4 changes · You, Claude"]);
  // What was picked stays picked when the list changes shape.
  await expect.poll(counted(mode)).toEqual(["1 change", "1 note", "+1 −0"]);
  await expect(noteRow(mode, "Recipes")).toHaveAttribute("aria-selected", "true");

  // A note's row shows all its changes as one diff, and opens to them.
  await noteRow(mode, "Plan").click();
  await expect(noteRow(mode, "Plan")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(read(tree(mode).locator('[aria-level="2"]'))).toEqual(PLAN_ROWS.map((r) => r.replace("You edited · 2 saves", "You edited")));
  await expect.poll(counted(mode)).toEqual(["3 changes", "4 saves", "1 note", "+7 −0"]);
  await expect(added(card(mode, "Plan"))).toHaveText(["# Plan", "", "Ada's step", "", "Claude's step", "", "Ada's last word"]);
  // Its tick adds or skips the note, and a row's tick one change of it.
  await tick(noteRow(mode, "Trip")).click();
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);
  await expect.poll(counted(mode)).toEqual(["5 changes", "6 saves", "2 notes", "+10 −0"]);
  await tick(tree(mode).locator('[aria-level="2"]').filter({ hasText: "Claude edited" })).click();
  await expect(noteRow(mode, "Plan")).toHaveAttribute("aria-selected", "false");
  await expect(noteRow(mode, "Plan").locator(".hist-check")).toHaveClass(/some/);
  await expect(card(mode, "Plan").locator(".hist-skip")).toHaveText(["1 save skipped"]);
  await noteRow(mode, "Plan").locator(".hist-caret").click();
  await expect(noteRow(mode, "Plan")).toHaveAttribute("aria-expanded", "false");
  await expect(tree(mode).locator('[aria-level="2"]')).toHaveCount(0);
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);

  await mode.getByRole("radio", { name: "By time" }).click();
  await expect.poll(picked(mode)).toEqual(["Claude edited Trip", "You wrote Trip", "You edited Plan", "You wrote Plan"]);
  await mode.getByRole("radio", { name: "By note" }).click();
  await page.reload();
  await expect(historyMode(page).getByRole("radio", { checked: true })).toHaveText(["By note", "Everyone"]);
  await expect(tree(historyMode(page)).locator('[aria-level="1"]')).toHaveCount(3);

  // Another member on the same browser starts by time.
  await signInAsNewPerson(page, "Grace Hopper");
  await page.goto("/history");
  await expect(historyMode(page).getByRole("radio", { checked: true })).toHaveText(["By time", "Everyone"]);
});

test("History lists everyone's changes, people's or agents', and a note's History tab opens it on that note alone", async ({ page }) => {
  const { plan } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(listed(mode)).toEqual(THREE);

  await mode.getByRole("radio", { name: "Agents" }).click();
  await expect.poll(listed(mode)).toEqual(["Claude edited Trip", "Claude edited Plan"]);
  await expect.poll(picked(mode)).toEqual(["Claude edited Trip"]);
  await mode.getByRole("radio", { name: "By note" }).click();
  await expect.poll(read(tree(mode).locator('[aria-level="1"]'))).toEqual(["+2 −0 Trip · 1 change · Claude", "+2 −0 Plan · 1 change · Claude"]);
  await mode.getByRole("radio", { name: "By time" }).click();
  await mode.getByRole("radio", { name: "People" }).click();
  await expect.poll(listed(mode)).toEqual(["You wrote Recipes", "You wrote Trip", "You edited Plan", "You wrote Plan · 2 saves"]);
  await mode.getByRole("radio", { name: "Everyone" }).click();
  await expect.poll(listed(mode)).toEqual(THREE);

  const panel = await openHistoryTab(page, plan);
  await expect(rows(panel)).toHaveCount(3);
  await panel.getByRole("button", { name: "Open in History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect.poll(listed(mode)).toEqual(["You edited", "Claude edited", "You wrote · 2 saves"]);
  await expect(mode.locator(".hist-scope")).toHaveText("Plan");
  await mode.getByRole("button", { name: "Show every note" }).click();
  await expect(mode.locator(".hist-scope")).toHaveCount(0);
  await expect.poll(listed(mode)).toEqual(THREE);
});

test("Select all and one Revert undo a big chunk: one new change in each note, a toast that says so, and Undo puts every note back", async ({ page }) => {
  const { plan, trip, recipes } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(listed(mode)).toEqual(THREE);
  const all = mode.getByRole("checkbox", { name: "Select all" });
  await expect(all).toHaveAttribute("aria-checked", "mixed");

  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "true");
  await expect(rows(mode).and(mode.locator('[aria-selected="true"]'))).toHaveCount(6);
  await expect.poll(counted(mode)).toEqual(["6 changes", "7 saves", "3 notes", "+11 −0"]);
  await expect.poll(cards(mode)).toEqual(["Recipes", "Trip", "Plan"]);

  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert 7 changes in 3 notes");
  await expect(dialog).toContainText("Each note gets one new change. Nothing is erased.");
  await expect(dialog.getByRole("region")).toHaveCount(3);
  await expect(removed(dialog.getByRole("region", { name: "Trip" }))).toHaveText(["# Trip", "", "Pack light."]);
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toContainText("Reverted 7 changes in 3 notes");
  await expect.poll(async () => [await text(page, plan), await text(page, trip), await text(page, recipes)]).toEqual(["", "", ""]);
  expect(await reverts(page, plan)).toEqual([null, null, null, null, [1, 2, 3, 4]]);
  // Each revert is a row of its own that says what it did, and what it reverted is marked, not struck out.
  // A note with nothing left in it has no title to go by, until Undo.
  const emptied = THREE.map((r) => `${r.replace(/ (Recipes|Trip|Plan)/, " Untitled")} · reverted`);
  await expect.poll(async () => (await listed(mode)()).slice(3)).toEqual(emptied);
  expect((await listed(mode)()).slice(0, 3).sort()).toEqual(["You reverted 1 change to Untitled", "You reverted 2 changes to Untitled", "You reverted 4 changes to Untitled"]);
  await expect(rows(mode).nth(4).locator(".hist-line b")).toHaveCSS("text-decoration-line", "none");

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Undone: 3 notes are as they were before the revert.");
  await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect.poll(async () => [await text(page, plan), await text(page, trip), await text(page, recipes)]).toEqual([PLAN, "# Trip\n\nPack light.", "# Recipes"]);
  expect(await reverts(page, plan)).toEqual([null, null, null, null, [1, 2, 3, 4], [5]]);
  await expect.poll(async () => (await listed(mode)()).slice(0, 3).sort()).toEqual(["You undid a revert of Plan", "You undid a revert of Recipes", "You undid a revert of Trip"]);
  expect((await listed(mode)()).slice(3, 6).sort()).toEqual(["You reverted 1 change to Recipes · reverted", "You reverted 2 changes to Trip · reverted", "You reverted 4 changes to Plan · reverted"]);
  await expect(mode.locator(".hist-reverted")).toHaveCount(3);
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toHaveCount(0);

  // Select all again clears when everything is picked.
  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "true");
  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "false");
  await expect.poll(counted(mode)).toEqual(["Nothing selected"]);
  await expect(pane(mode)).toContainText("Select changes to see what they did.");
  await expect(pane(mode).getByRole("button", { name: "Revert…" })).toHaveCount(0);
});

test("a note that changes under the preview is left as it is and named, the others are reverted, and the one left is reverted from its fresh preview", async ({ page }) => {
  const { plan, trip, claude } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("radio", { name: "Agents" }).click();
  await expect.poll(listed(mode)).toEqual(["Claude edited Trip", "Claude edited Plan"]);
  await mode.getByRole("checkbox", { name: "Select all" }).click();
  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert 2 changes in 2 notes");
  await expect(removed(dialog.getByRole("region", { name: "Trip" }))).toHaveText(["", "Pack light."]);
  let raced = false;
  await page.route("**/ops", async (route) => {
    if (!raced && route.request().postDataJSON()?.type === "history.revert") {
      raced = true;
      await claude.tool<Note>("write_note", { id: trip, baseRevision: 2, text: "# Trip\n\nPack light.\n\nBook trains." });
    }
    await route.fallback();
  });

  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  // Plan is reverted and said to be. Trip is still here, as it would be reverted now.
  await expect(toast(page)).toContainText("Reverted 1 change to Plan");
  await expect(dialog).toHaveAccessibleName("Revert 1 change to Trip");
  await expect(dialog.getByRole("status").first()).toHaveText("Reverted 1 note. 1 note was left as it is, shown here again.");
  await expect(dialog.getByRole("alert")).toHaveText("Trip changed after this was worked out, so it was left as it is. This is its revert as it would be now.");
  await expect(dialog.getByRole("region")).toHaveCount(1);
  await expect.poll(async () => [await text(page, plan), await text(page, trip)]).toEqual(["# Plan\n\nAda's step\n\nAda's last word", "# Trip\n\nPack light.\n\nBook trains."]);
  expect(await reverts(page, trip)).toEqual([null, null, null]);
  await expect(removed(dialog.getByRole("region", { name: "Trip" }))).toHaveText(["Pack light.", ""]);

  await dialog.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toContainText("Reverted 1 change to Trip");
  await expect.poll(() => text(page, trip)).toBe("# Trip\n\nBook trains.");
  expect(await reverts(page, trip)).toEqual([null, null, null, [2]]);
});

test("Undo after a revert puts back only the notes still as the revert left them, and names the ones edited since, whose revert stays", async ({ page }) => {
  const { plan, trip } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("radio", { name: "Agents" }).click();
  await expect.poll(listed(mode)).toEqual(["Claude edited Trip", "Claude edited Plan"]);
  await mode.getByRole("checkbox", { name: "Select all" }).click();
  await revertPicked(page, mode);
  await expect(toast(page)).toContainText("Reverted 2 changes in 2 notes");
  await perform(page, { type: "note.write", id: trip, baseRevision: 3, text: "# Trip\n\nA later thought." });

  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect(toast(page)).toHaveText(/Undone: Plan is as it was before the revert\. Trip has changed since, so its revert stays\. Pick that revert in the list to revert it\./);
  await expect.poll(async () => [await text(page, plan), await text(page, trip)]).toEqual([PLAN, "# Trip\n\nA later thought."]);
  expect(await reverts(page, trip)).toEqual([null, null, [2], null]);

  // The revert that stays is a row like any other: picking it previews what bringing the change back does now.
  await mode.getByRole("radio", { name: "Everyone" }).click();
  await row(mode, "You reverted 1 change to Trip").click();
  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  await expect(added(revertDialog(page))).toHaveText(["Pack light.", ""]);
  await revertDialog(page).getByRole("button", { name: "Revert", exact: true }).click();
  await expect.poll(() => text(page, trip)).toBe("# Trip\n\nPack light.\n\nA later thought.");
});

test("picking changes already reverted, or a revert with what it reverted, says nothing would change and leaves them be among others that do", async ({ page }) => {
  const { plan, trip } = await threeNotes(page);
  await perform(page, { type: "note.revertChanges", id: plan, revisions: [3] });
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(async () => (await listed(mode)()).slice(0, 2)).toEqual(["You reverted 1 change to Plan", "You wrote Recipes"]);
  const dialog = revertDialog(page);
  const confirm = dialog.getByRole("button", { name: "Revert", exact: true });

  // A change that is already reverted: nothing to do.
  await row(mode, "Claude edited Plan").click();
  await expect(row(mode, "Claude edited Plan").locator(".hist-reverted")).toHaveText("reverted");
  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  await expect(dialog).toContainText("1 change picked was already reverted, and is left as it is.");
  await expect(dialog).toContainText("Nothing in this note would change.");
  await expect(dialog.locator(".diff")).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The revert together with the change it reverted: as if neither was made, which is the note as it is.
  await row(mode, "You reverted 1 change to Plan").click({ modifiers: ["ControlOrMeta"] });
  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  await expect(dialog).toContainText("Nothing in this note would change: what was picked comes to no change in its text.");
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // With a change of another note that does revert, the revert is of that note, and says the first is left out.
  await row(mode, "Claude edited Trip").click({ modifiers: ["ControlOrMeta"] });
  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  await expect(dialog).toHaveAccessibleName("Revert 1 change in 1 note");
  await expect(dialog).toContainText("Nothing would change in Plan: it is left out of this revert.");
  await expect(dialog.getByRole("region")).toHaveCount(1);
  await confirm.click();
  await expect(toast(page)).toContainText("Reverted 1 change to Trip");
  await expect.poll(() => text(page, trip)).toBe("# Trip");
  expect(await reverts(page, plan)).toEqual([null, null, null, null, [3]]);
});

test("a note whose revert can't be made says why in the preview and is left out, and the others are still reverted", async ({ page }) => {
  const { plan, trip } = await threeNotes(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("radio", { name: "Agents" }).click();
  await expect.poll(listed(mode)).toEqual(["Claude edited Trip", "Claude edited Plan"]);
  await mode.getByRole("checkbox", { name: "Select all" }).click();
  // The server's answer for Plan, as it is when a revert would leave a note too long.
  await page.route("**/ops", async (route) => {
    if (route.request().postDataJSON()?.type !== "history.previewRevert") return route.fallback();
    const previews = (await (await route.fetch()).json()) as { noteTitle: string }[];
    await route.fulfill({ json: previews.map((p) => (p.noteTitle === "Plan" ? { ...p, revisions: [], diff: { hunks: [], added: 0, removed: 0, omitted: 0, lines: 0 }, refused: "With these choices the note would be over 500000 characters" } : p)) });
  });

  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert 1 change in 1 note");
  await expect(dialog.getByRole("region", { name: "Plan" }).getByRole("alert")).toHaveText("With these choices the note would be over 500000 characters. This note is left out of the revert.");
  await expect(removed(dialog.getByRole("region", { name: "Trip" }))).toHaveText(["", "Pack light."]);
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toContainText("Reverted 1 change to Trip");
  await expect.poll(async () => [await text(page, plan), await text(page, trip)]).toEqual([PLAN, "# Trip"]);
});

test("a revert is shown before it is made: the dialog has the diff of what it will do, leaving it any way changes nothing, and confirming records one change", async ({ page }) => {
  const { id } = await sharedNote(page);
  const panel = await openHistoryTab(page, id);
  await row(panel, "Claude edited").click();
  const opener = pane(panel).getByRole("button", { name: "Revert…" });

  await opener.click();

  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert 1 change to Plan");
  await expect(dialog).toContainText("This is recorded as one new change. Nothing is erased.");
  await expect(removed(dialog)).toHaveText(["Claude's step", ""]);
  await expect(dialog.locator("ins")).toHaveCount(0);
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(removed(dialog)).toHaveText(["Claude's step", ""]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe(PLAN);
  await expect.poll(() => perform(page, { type: "note.history", id })).toHaveLength(4);
  await expect(toast(page)).toHaveCount(0);

  await opener.click();
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toContainText("Reverted 1 change to Plan");
  await expect.poll(listed(panel)).toEqual(["You reverted 1 change", "You edited", "Claude edited · reverted", "You wrote · 2 saves"]);
  await expect(editorLines(page)).toHaveText(["# Plan", "", "Ada's step", "", "Ada's last word"]);
  expect(await reverts(page, id)).toEqual([null, null, null, null, [3]]);

  // Undo, with the note open in its editor: the editor takes the text back.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Undone: Plan is as it was before the revert.");
  await expect(editorLines(page)).toHaveText(["# Plan", "", "Ada's step", "", "Claude's step", "", "Ada's last word"]);
  await expect.poll(async () => (await listed(panel)()).slice(0, 2)).toEqual(["You undid a revert", "You reverted 1 change · reverted"]);
});

test("a later change to the same line is a conflict to settle in the dialog, and a later edit elsewhere is none", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\none\n\ntwo" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: "# Plan\n\none, edited\n\ntwo" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: "# Plan\n\none, edited\n\ntwo, edited" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 3, text: "# Plan\n\none, edited again\n\ntwo, edited" });
  const panel = await openHistoryTab(page, note.id);
  const dialog = revertDialog(page);
  await expect.poll(listed(panel)).toEqual(["Claude edited", "You edited", "Claude edited", "You wrote"]);

  await row(panel, "You edited").click();
  await pane(panel).getByRole("button", { name: "Revert…" }).click();
  await expect(dialog.locator(".diff-line.mod del")).toHaveText([", edited"]);
  await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Revert", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");

  await rows(panel).nth(2).click();
  await pane(panel).getByRole("button", { name: "Revert…" }).click();
  const conflict = dialog.getByRole("list", { name: "Conflicts" }).getByRole("listitem");
  await expect(conflict.getByRole("term")).toHaveText(["Before", "Now, edited by Claude (agent)"]);
  await expect(conflict.getByRole("definition")).toHaveText(["one", "one, edited again"]);
  // Nothing in the dialog leads away from it but its two buttons.
  await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Revert"]);
  await conflict.getByRole("radio", { name: "Go back to how it was" }).check();
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\none\n\ntwo, edited");
});

test("a revision is labeled and the note reverted to it from the one menu on its card", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await row(mode, "You wrote Plan").click();
  const plan = card(mode, "Plan");
  await expect(plan.getByRole("button")).toHaveCount(2);

  await plan.getByRole("button", { name: "More for Plan" }).click();
  await expect(page.getByRole("menu", { name: "More for Plan" }).getByRole("menuitem")).toHaveText(["Label this revision…", "Revert the note to this revision…"]);
  await page.getByRole("menuitem", { name: "Label this revision…" }).click();
  await plan.getByRole("textbox", { name: "Label for this revision of Plan" }).fill("Before Claude");
  await page.keyboard.press("Enter");
  await expect(row(mode, "You wrote Plan").locator(".label-chip")).toHaveText("Before Claude");
  await expect(plan.locator(".hist-run-head .label-chip")).toHaveText("Before Claude");
  expect((await perform(page, { type: "note.history", id })).map((c) => c.label)).toEqual([null, "Before Claude", null, null]);

  await plan.getByRole("button", { name: "More for Plan" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Rename this revision's label…", "Remove its label", "Revert the note to this revision…"]);
  await page.getByRole("menuitem", { name: "Revert the note to this revision…" }).click();
  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert Plan to revision 2");
  await expect(removed(dialog)).toHaveText(["", "Claude's step", "", "Ada's last word"]);
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(toast(page)).toContainText("Reverted 2 changes to Plan");
  await expect.poll(() => text(page, id)).toBe("# Plan\n\nAda's step");
  await expect.poll(async () => (await listed(mode)()).slice(0, 3)).toEqual(["You went back 2 changes in Plan", "You edited Plan · reverted", "Claude edited Plan · reverted"]);
  expect((await perform(page, { type: "note.history", id })).at(-1)!.reverts).toEqual({ how: "revert", revisions: [3, 4], to: 2 });

  // The version the note is at has nothing to go back to.
  await row(mode, "You went back 2 changes in Plan").click();
  await plan.getByRole("button", { name: "More for Plan" }).click();
  await expect(page.getByRole("menuitem", { name: "Revert the note to this revision…" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(row(historyMode(page), "You wrote Plan").locator(".label-chip")).toHaveText("Before Claude");
});

test("a viewer picks changes and reads what they did, with no way to revert or to label a revision", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.route("**/api/me", async (route) => {
    const me = (await (await route.fetch()).json()) as Me;
    await route.fulfill({ json: { ...me, workspaces: me.workspaces.map((w) => ({ ...w, role: "viewer" })) } });
  });
  const panel = await openHistoryTab(page, id);
  await expect(rows(panel)).toHaveCount(3);
  await tick(row(panel, "Claude edited")).click();
  await expect.poll(counted(panel)).toEqual(["2 changes", "1 note", "+4 −0"]);
  await expect(panel.getByRole("button", { name: /Revert|More for/ })).toHaveCount(0);
  await page.goto("/history");
  await expect(rows(historyMode(page))).toHaveCount(3);
  await expect(historyMode(page).getByRole("button", { name: /Revert|More for/ })).toHaveCount(0);
});

test("a selection of more notes than one request takes is read, previewed and reverted in parts, the list and the preview a page at a time, and undone in one press", async ({ page }) => {
  // 104 notes are made before the page is opened. Against a deployed preview each is a round trip, so the workspace is
  // asked for once, the notes are made several at a time, and the test is given the time that still takes.
  test.slow();
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id);
  const send = (ops: OpInput[]) =>
    page.evaluate(
      ({ ops, workspaceId }) =>
        Promise.all(
          ops.map(async (op) => {
            const res = await fetch(`/api/workspaces/${workspaceId}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
            const json = await res.json();
            if (!res.ok) throw new Error(json.message);
            return json;
          }),
        ),
      { ops, workspaceId },
    );
  const made: Note[] = [];
  for (let from = 0; from < 104; from += 8) made.push(...((await send(Array.from({ length: 8 }, (_, i) => ({ type: "note.create" as const, text: `# Note ${String(from + i).padStart(3, "0")}` })))) as Note[]));

  await page.goto("/history");
  const mode = historyMode(page);
  await expect(rows(mode)).toHaveCount(100);
  await expect(mode.locator(".hist-all-count")).toHaveText("100 changes so far");
  await mode.getByRole("button", { name: "Load older changes" }).click();
  await expect(rows(mode)).toHaveCount(104);
  await expect(mode.getByRole("button", { name: "Load older changes" })).toHaveCount(0);
  await expect(mode.locator(".hist-all-count")).toHaveText("104 changes");

  await mode.getByRole("radio", { name: "By note" }).click();
  const notes = tree(mode).locator('[aria-level="1"]');
  await expect(notes).toHaveCount(30);
  await mode.getByRole("button", { name: "Show more notes" }).click();
  await expect(notes).toHaveCount(60);
  await mode.getByRole("radio", { name: "By time" }).click();

  await mode.getByRole("checkbox", { name: "Select all" }).click();
  await expect.poll(counted(mode), { timeout: 20_000 }).toEqual(["104 changes", "104 notes", "+40 −0", "in the first 40"]);
  await expect(pane(mode).locator(".hist-file")).toHaveCount(40);
  await pane(mode).getByRole("button", { name: "Show 40 more of 64 notes" }).click();
  await expect(pane(mode).locator(".hist-file")).toHaveCount(80);

  await pane(mode).getByRole("button", { name: "Revert…" }).click();
  const dialog = revertDialog(page);
  await expect(dialog).toHaveAccessibleName("Revert 104 changes in 104 notes", { timeout: 20_000 });
  await expect(dialog.getByRole("region")).toHaveCount(8);
  await dialog.getByRole("button", { name: "Show 8 more of 96 notes" }).click();
  await expect(dialog.getByRole("region")).toHaveCount(16);
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(toast(page)).toContainText("Reverted 104 changes in 104 notes", { timeout: 30_000 });
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await perform(page, { type: "note.list" })).filter((n) => n.revision === 2).length, { timeout: 20_000 }).toBe(104);
  expect(await text(page, made[57]!.id)).toBe("");

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Undone: 104 notes are as they were before the revert.", { timeout: 30_000 });
  expect(await text(page, made[57]!.id)).toBe("# Note 057");
  await expect.poll(async () => (await perform(page, { type: "note.list" })).filter((n) => n.revision === 3).length).toBe(104);
});

test("History's panes are side by side with room, one over the other in a narrower pane, and one at a time in a narrow one", async ({ page }) => {
  await threeNotes(page);
  const boxes = async () => {
    const mode = historyMode(page);
    const [list, main] = [mode.locator(".hist-side"), pane(mode)];
    return { list: (await list.isVisible()) ? await list.boundingBox() : null, main: (await main.isVisible()) ? await main.boundingBox() : null };
  };

  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/history");
  await expect.poll(picked(historyMode(page))).toEqual(["You wrote Recipes"]);
  const wide = await boxes();
  expect(wide.list!.width).toBe(340);
  expect(wide.main!.x).toBe(wide.list!.x + 340);
  expect(wide.main!.y).toBe(wide.list!.y);

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await boxes()).main?.x).toBe(wide.list!.x);
  const stacked = await boxes();
  expect(stacked.main!.y).toBeGreaterThanOrEqual(stacked.list!.y + stacked.list!.height - 1);
  expect(stacked.main!.width).toBe(stacked.list!.width);
  await expect(pane(historyMode(page)).getByRole("button", { name: "Changes" })).toBeHidden();

  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(async () => (await boxes()).main).toBeNull();
  const mode = historyMode(page);
  expect((await boxes()).list!.height).toBeGreaterThan(600);
  await row(mode, "Claude edited Plan").click();
  await expect.poll(async () => (await boxes()).list).toBeNull();
  await expect(added(card(mode, "Plan"))).toHaveText(["", "Claude's step"]);
  await pane(mode).getByRole("button", { name: "Changes" }).click();
  await expect.poll(async () => (await boxes()).main).toBeNull();
  await tick(row(mode, "Claude edited Trip")).click();
  await mode.getByRole("button", { name: "See 2 changes" }).click();
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const [where, width] of [["History, wide", 1440], ["History, narrow", 700], ["the inspector's History tab", 1100]] as const) {
  test(`a diff's markers stay level with the first row of their lines while it scrolls, and long lines wrap beside them: ${where}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await signInAsNewPerson(page, "Ada Lovelace");
    const long = (n: number) => `Line ${n}: ${"a long line that has to wrap whatever the width of the diff it is shown in ".repeat(4)}end`;
    const before = Array.from({ length: 12 }, (_, i) => (i % 2 ? `short ${i}` : long(i)));
    const after = before.filter((_, i) => i % 4 !== 1).concat(long(99), "", "last", long(100), long(101));
    const note = await perform(page, { type: "note.create", text: `# Long\n\n${before.join("\n")}` });
    const claude = await connectAgent(page, "Claude");
    await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: `# Long\n\n${after.join("\n")}` });

    let scope: Locator;
    if (where.startsWith("History")) {
      await page.goto("/history");
      scope = historyMode(page);
      await row(scope, "Claude edited Long").click();
    } else {
      scope = await openHistoryTab(page, note.id);
      await row(scope, "Claude edited").click();
    }
    const diff = pane(scope).locator(".diff");
    await expect(diff.locator("ins.diff-line")).toHaveCount(5);
    await expect(diff.locator("del.diff-line")).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);

    /** Each marked line: where its marker and the first row of its text are, and how many rows the text takes. */
    const measure = () =>
      diff.locator("ins.diff-line, del.diff-line").evaluateAll((lines) =>
        lines.map((line) => {
          const range = document.createRange();
          const box = (el: Element) => (range.selectNodeContents(el), [...range.getClientRects()]);
          const [mark] = box(line.querySelector(".diff-mark")!);
          const rows = box(line.querySelector(".diff-text")!);
          const middle = (r: DOMRect) => (r.top + r.bottom) / 2;
          return { said: line.querySelector(".diff-mark")!.textContent, markTop: mark!.top, markMiddle: middle(mark!), markRight: mark!.right, firstRowMiddle: middle(rows[0]!), textLeft: Math.min(...rows.map((r) => r.left)), rows: new Set(rows.map((r) => Math.round(r.top))).size };
        }),
      );
    const level = (lines: Awaited<ReturnType<typeof measure>>) => lines.filter((l) => Math.abs(l.markMiddle - l.firstRowMiddle) > 3 || l.textLeft < l.markRight);

    const still = await measure();
    expect(still.map((l) => l.said).join("")).toBe("−−−+++++");
    expect(still.filter((l) => l.rows > 1).length).toBeGreaterThanOrEqual(3);
    expect(level(still)).toEqual([]);

    const moved = await diff.evaluate((el) => {
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const was = scroller!.scrollTop;
      scroller!.scrollTop += 150;
      return scroller!.scrollTop - was;
    });
    expect(moved).toBe(150);
    const scrolled = await measure();
    expect(level(scrolled)).toEqual([]);
    expect(scrolled.map((l, i) => Math.round(still[i]!.markTop - l.markTop))).toEqual(still.map(() => 150));
  });
}

test("undo and redo move through the note's history, across a closed tab and a reload", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const other = await perform(page, { type: "note.create", text: "# Other" });
  await page.reload();
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  for (const typed of ["# one", " two", " three"]) {
    await page.keyboard.type(typed);
    await expect(page.getByRole("status")).toHaveText("Saved");
  }
  const id = /([a-z0-9]{12})$/.exec(page.url())![1]!;

  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["# one two"]);

  await openAllNotes(page);
  await listedNote(page, "Other").click();
  await expect(editorLines(page).first()).toHaveText("# Other");
  await page.getByRole("tab", { name: "one two" }).click();
  await expect(editorLines(page)).toHaveText(["# one two"]);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["# one"]);

  await page.reload();
  await expect(editorLines(page)).toHaveText(["# one"]);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editorLines(page)).toHaveText(["# one two"]);
  await page.keyboard.press("ControlOrMeta+y");
  await expect(editorLines(page)).toHaveText(["# one two three"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["# one two"]);

  const recorded = await perform(page, { type: "note.history", id });
  expect(recorded.map((c) => c.reverts?.how ?? "edit")).toEqual(["edit", "edit", "edit", "undo", "undo", "redo", "redo", "undo"]);
  await expect.poll(() => text(page, id)).toBe("# one two");
  await expect.poll(() => text(page, other.id)).toBe("# Other");
});

test("undo takes back what was typed a moment ago without a word to the server, and leaves a text field's own undo alone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "kept" });
  await page.goto(`/note/${note.id}`);
  // Kept, so its tab is still there once a list is opened: a list from the tree takes a preview's place.
  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab").first().dblclick();
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
  await expect.poll(async () => (await perform(page, { type: "note.history", id: note.id })).map((c) => c.reverts?.how ?? "edit")).toEqual(["edit"]);

  await page.getByRole("tab", { name: "kept" }).click();
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
  await expect.poll(async () => (await hows(page, note.id)).at(-1)).toBe("undo");
});

test("undoing typing not yet saved and then pressing undo again takes back one saved change, not two", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("one");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.keyboard.type(" two");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const id = /([a-z0-9]{12})$/.exec(page.url())![1]!;

  await page.keyboard.type(" three");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["# one two"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect.poll(() => hows(page, id)).toEqual(["edit", "edit"]);

  const reads: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"note.read"') && reads.push(request.url()));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorLines(page)).toHaveText(["# one"]);
  await page.waitForTimeout(300);
  expect(reads).toEqual([]);
  await expect.poll(() => hows(page, id)).toEqual(["edit", "edit", "undo"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editorLines(page)).toHaveText(["# one two"]);
  await expect.poll(() => hows(page, id)).toEqual(["edit", "edit", "undo", "redo"]);
  await expect.poll(() => text(page, id)).toBe("# one two");
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
  await expect.poll(() => text(page, note.id)).toContain("From Claude.");
});


test("two members on one browser each have their own unseen changes", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto(`/note/${id}`);
  const historyTab = inspector(page).getByRole("tab", { name: "History" });
  await historyTab.click();
  await expect(rows(inspector(page))).toHaveCount(3);
  const mine = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ink.seen.")));
  const person = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as { person: { id: string } }).person.id);

  expect(mine).toHaveLength(1);
  expect(mine[0]!.endsWith(`.${person}`)).toBe(true);
});

test("with a folder's list in front the inspector's History tab lists that folder's notes that changed, each opening to its changes, and All notes lists the workspace's", async ({ page }) => {
  const { claude } = await sharedNote(page);
  const trips = await perform(page, { type: "folder.create", name: "Trips" });
  await perform(page, { type: "folder.create", name: "Empty" });
  const trip = await perform(page, { type: "note.create", folderId: trips.id, text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await perform(page, { type: "note.create", folderId: trips.id, text: "# Packing" });

  await page.goto(`/folder/${trips.id}`);
  await expect(inspector(page).getByRole("tab")).toHaveText(["History", "Info"]);
  // Nothing picked yet: Info, as on a note.
  await expect(inspector(page).getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  await inspector(page).getByRole("tab", { name: "History" }).click();
  const panel = inspector(page).getByRole("tabpanel");
  const shown = read(tree(panel).locator('[aria-level="1"]'));
  await expect.poll(shown).toEqual(["+1 −0 Packing · 1 change · You", "+3 −0 Trip · 2 changes · Claude, You"]);

  // The first note is open with all its changes picked, and what they did under the list.
  await expect(noteRow(panel, "Packing")).toHaveAttribute("aria-expanded", "true");
  await expect(noteRow(panel, "Trip")).toHaveAttribute("aria-expanded", "false");
  await expect(added(card(panel, "Packing"))).toHaveText(["# Packing"]);
  await noteRow(panel, "Trip").click();
  await expect.poll(read(tree(panel).locator('[aria-level="2"]'))).toEqual(["You wrote", "Claude edited", "You wrote"]);
  await expect(added(card(panel, "Trip"))).toHaveText(["# Trip", "", "Pack light."]);

  // The tab picked for a folder stays picked on the next folder, and the list is that folder's.
  await page.getByRole("treeitem", { name: "Unsorted" }).click();
  await expect(inspector(page).getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(shown).toEqual(["+7 −0 Plan · 4 changes · You, Claude"]);

  await page.getByRole("treeitem", { name: "Empty" }).click();
  await expect(panel).toHaveText("Nothing has been written in this folder yet.");

  await openAllNotes(page);
  await expect.poll(shown).toEqual(["+1 −0 Packing · 1 change · You", "+3 −0 Trip · 2 changes · Claude, You", "+7 −0 Plan · 4 changes · You, Claude"]);

  // A change made while the list is in front shows up in it.
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 2, text: "# Trip\n\nPack light.\n\nBook trains." });
  await expect.poll(async () => (await shown())[0], { timeout: 20_000 }).toEqual("+5 −0 Trip · 3 changes · Claude, You");

  // A folder's tab opens History on that folder's notes.
  await page.getByRole("treeitem", { name: "Trips" }).click();
  await expect.poll(shown).toEqual(["+5 −0 Trip · 3 changes · Claude, You", "+1 −0 Packing · 1 change · You"]);
  await panel.getByRole("button", { name: "Open in History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(historyMode(page).locator(".hist-scope")).toHaveText("Trips");
  await expect.poll(listed(historyMode(page))).toEqual(["Claude edited Trip", "You wrote Packing", "Claude edited Trip", "You wrote Trip"]);
  await card(historyMode(page), "Trip").getByRole("button", { name: "Trip", exact: true }).click();
  await expect(editorLines(page).first()).toHaveText("# Trip");
});
