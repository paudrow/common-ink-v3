import { expect, type Locator, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { connectAgent, folderRow, perform, showPanel, signInAsNewPerson, test } from "./helpers.ts";

const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const historyMode = (page: Page) => page.getByRole("region", { name: "History" });
const modes = (page: Page) => page.getByRole("navigation", { name: "Modes" });
const rows = (scope: Page | Locator) => scope.getByRole("listbox", { name: "Changes" }).getByRole("option");
const row = (scope: Page | Locator, says: string | RegExp) => rows(scope).filter({ hasText: says });
const tick = (item: Locator) => item.locator(".hist-check");
const picked = (scope: Page | Locator) => () => scope.locator('.hist-row[aria-selected="true"] .hist-line').evaluateAll((all) => all.map((el) => el.textContent!.trim().replace(/\s+/g, " ")));
/** The other pane: what everything ticked did. */
const pane = (scope: Page | Locator) => scope.getByRole("region", { name: "What the selection did" });
const counted = (scope: Page | Locator) => () => pane(scope).locator(".hist-sum-text > *").evaluateAll((parts) => parts.map((part) => part.textContent));
const cards = (scope: Page | Locator) => () => pane(scope).locator(".hist-file-name").evaluateAll((all) => all.map((el) => el.textContent));
/** What is ticked and what to do with it, at the foot of the list while something is ticked. */
const bar = (scope: Page | Locator) => scope.getByRole("group", { name: "Selection" });
const hint = (scope: Page | Locator) => pane(scope).getByText("Tick changes to see what they did together");
/** The lines of a diff marked as a conflict, each as its caption and its lines. */
const conflicts = (scope: Page | Locator) => pane(scope).locator(".diff-conflict");
const revertDialog = (page: Page) => page.getByRole("dialog", { name: /^Revert/ });
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Where each of these is, to the pixel. */
const placed = (items: Locator) =>
  items.evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map(Math.round).join(" ");
    }),
  );

const PLAN = "# Plan\n\none, edited again\n\ntwo, edited\n\nthree\n\nfour";
/**
 * Ada's Plan: Claude edited its first line, Ada its second, and Claude the first again and added a
 * last. So reverting Claude's first edit alone meets his later one, Ada's edit meets nothing, and
 * both of Claude's together meet nothing either.
 */
async function plan(page: Page, claude: Awaited<ReturnType<typeof connectAgent>>, title = "Plan") {
  const titled = (text: string) => text.replace("Plan", title);
  const note = await perform(page, { type: "note.create", text: titled("# Plan\n\none\n\ntwo\n\nthree") });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: titled("# Plan\n\none, edited\n\ntwo\n\nthree") });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: titled("# Plan\n\none, edited\n\ntwo, edited\n\nthree") });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 3, text: titled(PLAN) });
  return note.id;
}

async function openHistory(page: Page) {
  if (!(await modes(page).getByRole("link", { name: "History" }).isVisible())) await modes(page).getByRole("button", { name: "More" }).click();
  await modes(page).getByRole("link", { name: "History" }).click();
  await expect(rows(historyMode(page)).first()).toBeVisible();
  return historyMode(page);
}

async function nothingTicked(scope: Locator) {
  await expect.poll(picked(scope)).toEqual([]);
  await expect(scope.locator('[role="checkbox"][aria-checked="true"], [role="checkbox"][aria-checked="mixed"], [aria-selected="true"]')).toHaveCount(0);
  await expect(hint(scope)).toBeVisible();
  await expect.poll(counted(scope)).toEqual(["Nothing selected"]);
  await expect(bar(scope)).toHaveCount(0);
}

test("nothing is ticked by itself: History opens with no change ticked as a page, for a note and for a folder, and a tick taken off stays off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const id = await plan(page, claude);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(async () => (await rows(mode).allInnerTexts()).length).toBe(4);
  await nothingTicked(mode);

  // A tick put on and taken off leaves nothing ticked, and coming back ticks nothing either.
  await tick(rows(mode).first()).click();
  await expect.poll(picked(mode)).toEqual(["Claude edited Plan"]);
  await expect(bar(mode)).toBeVisible();
  await tick(rows(mode).first()).click();
  await nothingTicked(mode);
  // Escape goes back from several ticked to the one the cursor is on. With nothing ticked it ticks nothing.
  await page.keyboard.press("Escape");
  await nothingTicked(mode);
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(page.getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await nothingTicked(await openHistory(page));

  // A note's History, and a folder's, in the inspector.
  await page.goto(`/note/${id}`);
  await showPanel(page, "History");
  const panel = inspector(page).locator(".inspector-body");
  await expect(rows(panel)).toHaveCount(4);
  await nothingTicked(panel);
  await folderRow(page, "All notes").click();
  await showPanel(page, "History");
  await expect(panel.getByRole("tree", { name: "Notes that changed" }).getByRole("treeitem")).toHaveCount(1);
  await nothingTicked(panel);
});

test("what is ticked is still ticked on coming back, each place History is shown keeping its own, until the app is loaded again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  await plan(page, claude);
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(async () => (await rows(mode).allInnerTexts()).length).toBe(6);

  await tick(row(mode, "Claude edited Trip")).click();
  await tick(row(mode, "You edited Plan")).click();
  const ticked = ["Claude edited Trip", "You edited Plan"];
  await expect.poll(picked(mode)).toEqual(ticked);
  await expect(bar(mode).getByRole("status")).toHaveText("2 changes selected in 2 notes");
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);

  // Away to another page and back: the same two, and what they did.
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(page.getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await openHistory(page);
  await expect.poll(picked(mode)).toEqual(ticked);
  await expect.poll(cards(mode)).toEqual(["Trip", "Plan"]);
  await expect(bar(mode).getByRole("status")).toHaveText("2 changes selected in 2 notes");

  // A note's History keeps its own ticks, and the page's are as they were beside them.
  await pane(mode).getByRole("button", { name: "Plan", exact: true }).click();
  await showPanel(page, "History");
  const panel = inspector(page).locator(".inspector-body");
  await expect(rows(panel)).toHaveCount(4);
  await expect.poll(picked(panel)).toEqual([]);
  await tick(rows(panel).nth(3)).click();
  await expect.poll(picked(panel)).toEqual(["You wrote"]);
  await openHistory(page);
  await expect.poll(picked(mode)).toEqual(ticked);
  await pane(mode).getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/note\/plan-/);
  await showPanel(page, "History");
  await expect.poll(picked(panel)).toEqual(["You wrote"]);

  // The page narrowed to the note is another place again, and widening it back shows the page's own ticks.
  await panel.getByRole("button", { name: "Open in History" }).click();
  await expect(mode.getByRole("button", { name: "Show every note" })).toBeVisible();
  await expect(rows(mode)).toHaveCount(4);
  await expect.poll(picked(mode)).toEqual([]);
  await mode.getByRole("button", { name: "Show every note" }).click();
  await expect(rows(mode)).toHaveCount(6);
  await expect.poll(picked(mode)).toEqual(ticked);
  await pane(mode).getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/note\/plan-/);

  // Loading the app again starts with nothing ticked anywhere.
  await page.reload();
  await showPanel(page, "History");
  await expect(rows(panel)).toHaveCount(4);
  await expect.poll(picked(panel)).toEqual([]);
  await page.goto("/history");
  await expect.poll(async () => (await rows(mode).allInnerTexts()).length).toBe(6);
  await expect.poll(picked(mode)).toEqual([]);
  await expect(bar(mode)).toHaveCount(0);
});

test("ticking changes shows where reverting them would not line up: the lines a later change edited are marked with whose change it was, counted, and open the revert at that conflict", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  await plan(page, claude);
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(async () => (await rows(mode).allInnerTexts()).length).toBe(4);
  const [latest, adas, first] = [rows(mode).nth(0), rows(mode).nth(1), rows(mode).nth(2)];

  // Ada's edit of the second line: nothing later touched it.
  await tick(adas).click();
  await expect.poll(counted(mode)).toEqual(["1 change", "1 note", "+1 −1"]);
  await expect(conflicts(mode)).toHaveCount(0);

  // Claude's first edit too: his later edit of the same line is a conflict, on that line of the diff and no other.
  await tick(first).click();
  await expect.poll(counted(mode)).toEqual(["2 changes", "1 note", "+2 −2", "1 conflict"]);
  await expect(conflicts(mode)).toHaveCount(1);
  await expect(conflicts(mode).locator(".diff-conflict-says")).toHaveText(/^Conflict: Claude \(agent\) changed this line later, at \d/);
  await expect(conflicts(mode).locator(".diff-line")).toHaveText(["~one, edited"]);
  await expect(pane(mode).locator(".diff-line.mod")).toHaveCount(2);

  // The mark is the dialog's conflict: the same lines, the same later change, with its choices in hand.
  const dialog = revertDialog(page);
  const conflict = dialog.getByRole("list", { name: "Conflicts" }).getByRole("listitem");
  for (const open of [() => conflicts(mode).click(), () => pane(mode).getByRole("button", { name: "1 conflict" }).click(), () => conflicts(mode).press("Enter")]) {
    await open();
    await expect(conflict).toHaveCount(1);
    await expect(conflict).toHaveAttribute("aria-current", "true");
    await expect(conflict.getByRole("term")).toHaveText(["Before", "Now, edited by Claude (agent)"]);
    await expect(conflict.getByRole("definition")).toHaveText(["one", "one, edited again"]);
    await expect(conflict.getByRole("radio", { name: "Keep the later edit" })).toBeFocused();
    await expect(conflict).toBeInViewport();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  }

  // With Claude's later change ticked as well, nothing later is left to meet: no conflict, and none is said while that is being read.
  await page.route("**/ops", async (route) => {
    if (["history.diff", "history.previewRevert"].includes(route.request().postDataJSON()?.type)) await new Promise((done) => setTimeout(done, 1500));
    await route.fallback();
  });
  await tick(latest).click();
  await expect(bar(mode).getByRole("status")).toHaveText("3 changes selected");
  await expect(conflicts(mode)).toHaveCount(0);
  await expect(pane(mode).getByRole("button", { name: /conflict/ })).toHaveCount(0);
  await expect(pane(mode).locator(".hist-files")).toHaveAttribute("aria-busy", "true");
  await expect.poll(counted(mode)).toEqual(["3 changes", "1 note", "+4 −2"]);
  await expect(conflicts(mode)).toHaveCount(0);
  await expect(pane(mode).getByRole("button", { name: /conflict/ })).toHaveCount(0);
});

test("the list's foot says what is ticked and reverts it, with a conflict settled each of the three ways, and nothing in the list or beside it moves when the bar comes and goes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const titles = ["Kept", "Back", "Typed"];
  const ids = [await plan(page, claude, titles[0]), await plan(page, claude, titles[1]), await plan(page, claude, titles[2])];
  await page.goto("/history");
  const mode = historyMode(page);
  await expect.poll(async () => (await rows(mode).allInnerTexts()).length).toBe(12);
  await page.evaluate(() => document.fonts.ready);

  // The bar is there only while something is ticked, and the rows and the other pane's line are where they were with it.
  const steady = mode.locator(".hist-row, .hist-day, .hist-all, .hist-summary");
  const before = await placed(steady);
  expect(before).toHaveLength(15);
  await expect(bar(mode)).toHaveCount(0);
  await tick(rows(mode).nth(2)).click();
  await expect(bar(mode).getByRole("status")).toHaveText("1 change selected");
  // "See" leads to the other pane where a narrow page shows one at a time, and is not there with both in view.
  await expect(bar(mode).getByRole("button")).toHaveText(["Clear", "Revert…"]);
  await expect.poll(() => placed(steady)).toEqual(before);
  // The revert is the bar's alone: the other pane keeps the totals.
  await expect(pane(mode).getByRole("button", { name: "Revert…" })).toHaveCount(0);
  await bar(mode).getByRole("button", { name: "Clear" }).click();
  await expect(bar(mode)).toHaveCount(0);
  await expect.poll(picked(mode)).toEqual([]);
  await expect.poll(() => placed(steady)).toEqual(before);

  // Each note's first edit by Claude, reverted from the bar with its conflict settled one way.
  const dialog = revertDialog(page);
  const conflict = dialog.getByRole("list", { name: "Conflicts" }).getByRole("listitem");
  const settle = [
    async () => {},
    () => conflict.getByRole("radio", { name: "Go back to how it was" }).check(),
    async () => {
      await conflict.getByRole("radio", { name: "Edit", exact: true }).check();
      await conflict.getByRole("textbox", { name: "Lines for conflict 1" }).fill("one, settled by hand");
    },
  ];
  const left = ["# Kept\n\none again\n\ntwo, edited\n\nthree\n\nfour", "# Back\n\none\n\ntwo, edited\n\nthree\n\nfour", "# Typed\n\none, settled by hand\n\ntwo, edited\n\nthree\n\nfour"];
  for (const [n, id] of ids.entries()) {
    // His first edit of a note is listed under his later one.
    await tick(row(mode, `Claude edited ${titles[n]}`).nth(1)).click();
    await expect.poll(counted(mode)).toEqual(["1 change", "1 note", "+1 −1", "1 conflict"]);
    await bar(mode).getByRole("button", { name: "Revert…" }).click();
    await expect(conflict.getByRole("definition")).toHaveText(["one", "one, edited again"]);
    await settle[n]!();
    await dialog.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => text(page, id)).toBe(left[n]);
    // What was reverted is no longer a change that stands, so the bar goes or says what is still ticked.
    await bar(mode).getByRole("button", { name: "Clear" }).click();
    await expect(bar(mode)).toHaveCount(0);
  }
});
