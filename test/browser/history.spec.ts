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
/** A change by what its row names it, such as "Change 3 by Claude" or "Change 3 to Plan by Claude". */
const change = (scope: Page | Locator, name: string) => scope.getByRole("listitem", { name, exact: true });
const toggle = (row: Locator) => row.locator(".change-toggle");
const added = (scope: Locator) => scope.getByRole("insertion").locator(".diff-text");
const removed = (scope: Locator) => scope.getByRole("deletion").locator(".diff-text");
const changedNotes = (mode: Locator) => mode.getByRole("list", { name: "Notes that changed" }).locator("> li");
const changedNote = (mode: Locator, title: string) => mode.getByRole("list", { name: "Notes that changed" }).locator(`> li[aria-label="${title}"]`);
const noteToggle = (mode: Locator, title: string) => changedNote(mode, title).locator(".changed-note-toggle");
/** Each note History mode lists, as its title, the lines its changes added and removed, how many changes, and who made them. */
const summary = (mode: Locator) => () =>
  changedNotes(mode).evaluateAll((rows) =>
    rows.map((row) => [row.querySelector(".changed-note-title")!.textContent, row.querySelector(".change-stat")!.textContent, row.querySelector(".changed-note-meta")!.textContent!.split(" · ").slice(0, 2).join(" · ")]),
  );
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

test("the inspector's History tab opens on what the note's changes come to and each change closed, and a change opens to its diff", async ({ page }) => {
  const { id } = await sharedNote(page);

  const panel = await openHistoryTab(page, id);

  await expect.poll(names(panel)).toEqual(["Change 4 by Ada Lovelace", "Change 3 by Claude", "Change 2 by Ada Lovelace", "Change 1 by Ada Lovelace"]);
  await expect(panel.getByLabel("All changes to this note")).toContainText("+7 −0");
  await expect(panel.getByLabel("All changes to this note")).toContainText("4 changes · Ada Lovelace, Claude (agent)");
  await expect(panel.locator(".diff")).toHaveCount(0);
  await expect(toggle(changes(panel).first())).toHaveAttribute("aria-expanded", "false");
  const byClaude = change(panel, "Change 3 by Claude");
  await expect(byClaude).toContainText("Claudeagent");
  await expect(byClaude).toContainText("+2 −0");

  await toggle(byClaude).click();
  await expect(added(byClaude)).toHaveText(["", "Claude's step"]);
  await expect(byClaude.getByRole("deletion")).toHaveCount(0);
  await expect(panel.locator(".diff")).toHaveCount(1);
  await toggle(byClaude).click();
  await expect(panel.locator(".diff")).toHaveCount(0);
  await toggle(changes(panel).first()).click();
  await expect(added(changes(panel).first())).toHaveText(["", "Ada's last word"]);

  const unseenChecks: string[] = [];
  page.on("request", (request) => request.postData()?.includes('"diffs":false,"limit":100') && unseenChecks.push(request.url()));
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nTyped just now");
  await expect(changes(panel).first()).toHaveAccessibleName("Change 5 by Ada Lovelace");
  expect(unseenChecks).toEqual([]);
  await expect(panel.getByLabel("All changes to this note")).toContainText("+9 −0");
  await expect(panel.getByLabel("All changes to this note")).toContainText("5 changes");
  await toggle(changes(panel).first()).click();
  await expect(added(changes(panel).first())).toHaveText(["", "Typed just now"]);
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

test("History mode opens on the notes that changed, each closed with its lines added and removed, and filters them by author, by notes, and by date", async ({ page }) => {
  const { claude } = await sharedNote(page);
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await perform(page, { type: "note.create", text: "# Recipes" });

  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  const mode = historyMode(page);
  const shown = summary(mode);
  const all = [
    ["Recipes", "+1 −0", "1 change · Ada Lovelace"],
    ["Trip", "+3 −0", "2 changes · Claude (agent), Ada Lovelace"],
    ["Plan", "+7 −0", "4 changes · Ada Lovelace, Claude (agent)"],
  ];
  await expect.poll(shown).toEqual(all);
  await expect(mode.getByRole("button", { expanded: true })).toHaveCount(0);
  await expect(changes(mode)).toHaveCount(0);
  await expect(mode.locator(".diff")).toHaveCount(0);

  await noteToggle(mode, "Trip").click();
  await expect.poll(names(mode)).toEqual(["Change 2 to Trip by Claude", "Change 1 to Trip by Ada Lovelace"]);
  await expect(mode.locator(".diff")).toHaveCount(0);
  await toggle(change(mode, "Change 2 to Trip by Claude")).click();
  await expect(added(change(mode, "Change 2 to Trip by Claude"))).toHaveText(["", "Pack light."]);
  await noteToggle(mode, "Plan").click();
  await expect(changes(mode)).toHaveCount(6);

  const authors = mode.getByRole("group", { name: "Authors" });
  await authors.getByRole("button", { name: "Claude (agent)" }).click();
  await expect.poll(shown).toEqual([["Trip", "+2 −0", "1 change · Claude (agent)"], ["Plan", "+2 −0", "1 change · Claude (agent)"]]);
  await expect.poll(names(mode)).toEqual(["Change 2 to Trip by Claude", "Change 3 to Plan by Claude"]);
  await authors.getByRole("button", { name: "Ada Lovelace" }).click();
  await expect.poll(shown).toEqual(all);
  await authors.getByRole("button", { name: "Claude (agent)" }).click();
  await expect.poll(shown).toEqual([["Recipes", "+1 −0", "1 change · Ada Lovelace"], ["Trip", "+1 −0", "1 change · Ada Lovelace"], ["Plan", "+5 −0", "3 changes · Ada Lovelace"]]);
  await expect.poll(names(mode)).toEqual(["Change 1 to Trip by Ada Lovelace", "Change 4 to Plan by Ada Lovelace", "Change 2 to Plan by Ada Lovelace", "Change 1 to Plan by Ada Lovelace"]);
  await mode.getByRole("button", { name: "Clear filters" }).click();
  await noteToggle(mode, "Trip").click();
  await noteToggle(mode, "Plan").click();
  await expect(changes(mode)).toHaveCount(0);

  await mode.getByRole("button", { name: "All notes" }).click();
  const scope = mode.getByRole("group", { name: "Notes to show" });
  await scope.getByRole("checkbox", { name: "Trip" }).check();
  await expect.poll(shown).toEqual(all.filter(([title]) => title === "Trip"));
  await scope.getByRole("searchbox", { name: "Find a note" }).fill("rec");
  await expect(scope.getByRole("checkbox")).toHaveCount(1);
  await scope.getByRole("checkbox", { name: "Recipes" }).check();
  await expect(mode.getByRole("button", { name: "2 notes" })).toBeVisible();
  await expect.poll(shown).toEqual(all.filter(([title]) => title !== "Plan"));
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
  await changedNote(mode, "Recipes").getByRole("button", { name: "Open note" }).click();
  await expect(page).toHaveURL(/\/note\/recipes-[a-z0-9]{12}$/);
});

test("History mode lists a page of notes at a time, and a note a page of its changes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const first = await perform(page, { type: "note.create", text: "# Note 00" });
  for (let i = 1; i <= 31; i++) await perform(page, { type: "note.create", text: `# Note ${String(i).padStart(2, "0")}` });
  let text = "# Note 00";
  for (let revision = 1; revision <= 32; revision++) await perform(page, { type: "note.write", id: first.id, baseRevision: revision, text: (text += `\n${revision}`) });

  await page.goto("/history");
  const mode = historyMode(page);
  await expect(changedNotes(mode)).toHaveCount(30);
  await expect(changedNotes(mode).first()).toContainText("+33 −0");
  await expect(changedNotes(mode).first()).toContainText("33 changes");
  await mode.getByRole("button", { name: "Show more notes" }).click();
  await expect(changedNotes(mode)).toHaveCount(32);
  await expect(mode.getByRole("button", { name: "Show more notes" })).toHaveCount(0);

  await noteToggle(mode, "Note 00").click();
  await expect(changes(mode)).toHaveCount(30);
  await mode.getByRole("button", { name: "Show older changes" }).click();
  await expect(changes(mode)).toHaveCount(33);
  await expect(mode.getByRole("button", { name: "Show older changes" })).toHaveCount(0);
});

test("a revision can be labeled, and the note reverted to it as a new change", async ({ page }) => {
  const { id } = await sharedNote(page);
  const panel = await openHistoryTab(page, id);
  const second = change(panel, "Change 2 by Ada Lovelace");
  const latest = changes(panel).first();

  await toggle(second).click();
  await second.getByRole("button", { name: "Label" }).click();
  await panel.getByRole("textbox", { name: "Label for revision 2" }).fill("Before Claude");
  await page.keyboard.press("Enter");
  await expect(second.locator(".label-chip")).toHaveText("Before Claude");
  await expect(second.getByRole("button", { name: "Rename label" })).toBeVisible();
  await toggle(latest).click();
  await expect(latest.getByRole("button", { name: "Label" })).toBeVisible();
  await expect(latest.getByRole("button", { name: "Revert note to here" })).toHaveCount(0);

  await second.getByRole("button", { name: "Revert note to here" }).click();

  await expect(editorLines(page)).toHaveText(["# Plan", "", "Ada's step"]);
  await expect(changes(panel)).toHaveCount(5);
  const revert = change(panel, "Change 5 by Ada Lovelace");
  await expect(revert).toContainText("Reverts the note to revision 2");
  await expect(revert).toContainText("+0 −4");
  await toggle(revert).click();
  await expect(removed(revert)).toHaveText(["", "Claude's step", "", "Ada's last word"]);
  for (const name of ["Change 4 by Ada Lovelace", "Change 3 by Claude"]) {
    await expect(change(panel, name)).toContainText("Reverted by change 5");
    await expect(change(panel, name).locator(".change-author")).toHaveCSS("text-decoration-line", "none");
    await expect(change(panel, name).getByRole("button", { name: /^Revert change/ })).toHaveCount(0);
  }
  await change(panel, "Change 3 by Claude").getByRole("button", { name: "Change 5", exact: true }).click();
  await expect(toggle(revert)).toBeFocused();
  expect(await text(page, id)).toBe("# Plan\n\nAda's step");
  expect((await perform(page, { type: "note.read", id, revision: 4 })).text).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");

  await page.reload();
  await inspector(page).getByRole("tab", { name: "History" }).click();
  await expect(change(inspector(page), "Change 2 by Ada Lovelace").locator(".label-chip")).toHaveText("Before Claude");
});

test("a change is reverted as a new change, and reverting that revert has it again, as deep as it goes", async ({ page }) => {
  const { id } = await sharedNote(page);
  await page.goto("/history");
  const mode = historyMode(page);
  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" }).click();
  await noteToggle(mode, "Plan").click();
  await expect.poll(names(mode)).toEqual(["Change 3 to Plan by Claude"]);
  const third = change(mode, "Change 3 to Plan by Claude");
  await expect(mode.getByRole("checkbox")).toHaveCount(0);
  for (const gone of ["Revert selected", "Put back selected", "Clear"]) await expect(mode.getByRole("button", { name: gone, exact: true })).toHaveCount(0);

  await third.getByRole("button", { name: "Revert change 3 to Plan" }).click();

  await expect(third).toContainText("Reverted by change 5");
  await expect(third.getByRole("button", { name: /^Revert change/ })).toHaveCount(0);
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
  await mode.getByRole("button", { name: "Clear filters" }).click();
  await expect.poll(summary(mode)).toEqual([["Plan", "+7 −2", "5 changes · Ada Lovelace, Claude (agent)"]]);
  const fifth = change(mode, "Change 5 to Plan by Ada Lovelace");
  await expect(fifth).toContainText("Reverts change 3");
  await expect(fifth).toContainText("+0 −2");

  await fifth.getByRole("button", { name: "Revert change 5 to Plan" }).click();

  const sixth = change(mode, "Change 6 to Plan by Ada Lovelace");
  await expect(sixth).toContainText("Reverts change 5");
  await expect(sixth).toContainText("+2 −0");
  await expect(fifth).toContainText("Reverted by change 6");
  await expect(third).not.toContainText("Reverted by");
  await expect(third.getByRole("button", { name: "Revert change 3 to Plan" })).toBeVisible();
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");

  await sixth.getByRole("button", { name: "Revert change 6 to Plan" }).click();

  const seventh = change(mode, "Change 7 to Plan by Ada Lovelace");
  await expect(seventh).toContainText("Reverts change 6");
  await expect(seventh).toContainText("+0 −2");
  await expect(third).toContainText("Reverted by change 5");
  await expect(mode).not.toContainText(/put back|taken back|Put back|Taken back/);
  expect(await text(page, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
  expect((await perform(page, { type: "note.history", id })).map((c) => c.reverts?.revisions ?? null)).toEqual([null, null, null, null, [3], [5], [6]]);
});

for (const [where, width] of [["History mode, wide", 1440], ["History mode, narrow", 700], ["the inspector's History tab", 1100]] as const) {
  test(`a diff's markers stay level with the first row of their lines while it scrolls, and long lines wrap beside them: ${where}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await signInAsNewPerson(page, "Ada Lovelace");
    const long = (n: number) => `Line ${n}: ${"a long line that has to wrap whatever the width of the diff it is shown in ".repeat(4)}end`;
    const before = Array.from({ length: 12 }, (_, i) => (i % 2 ? `short ${i}` : long(i)));
    const after = before.map((line, i) => (i % 3 === 0 ? `${line} changed` : line)).concat(long(99), "", "last");
    const note = await perform(page, { type: "note.create", text: `# Long\n\n${before.join("\n")}` });
    await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: `# Long\n\n${after.join("\n")}` });

    let scope: Locator;
    if (where.startsWith("History mode")) {
      await page.goto("/history");
      scope = historyMode(page);
      await noteToggle(scope, "Long").click();
      await toggle(change(scope, "Change 2 to Long by Ada Lovelace")).click();
    } else {
      scope = await openHistoryTab(page, note.id);
      await toggle(change(scope, "Change 2 by Ada Lovelace")).click();
    }
    const diff = scope.locator(".diff");
    await expect(diff.getByRole("insertion")).toHaveCount(7);
    await expect(diff.getByRole("deletion")).toHaveCount(4);

    /** Each marked line: where its marker and the first row of its text are, and how many rows the text takes. */
    const measure = () =>
      diff.locator("ins, del").evaluateAll((lines) =>
        lines.map((line) => {
          const range = document.createRange();
          const box = (el: Element) => (range.selectNodeContents(el), [...range.getClientRects()]);
          const [mark] = box(line.querySelector(".diff-mark")!);
          const rows = box(line.querySelector(".diff-text")!);
          return { said: line.querySelector(".diff-mark")!.textContent, markTop: mark!.top, markRight: mark!.right, firstRowTop: rows[0]!.top, textLeft: Math.min(...rows.map((r) => r.left)), rows: new Set(rows.map((r) => Math.round(r.top))).size };
        }),
      );
    const level = (lines: Awaited<ReturnType<typeof measure>>) => lines.filter((l) => Math.abs(l.markTop - l.firstRowTop) > 1 || l.textLeft < l.markRight);

    const still = await measure();
    expect(still.map((l) => l.said).join("")).toBe("−+−+−+−++++");
    expect(still.filter((l) => l.rows > 1).length).toBeGreaterThanOrEqual(5);
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
  expect(await text(page, id)).toBe("# one two");
  expect(await text(page, other.id)).toBe("# Other");
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
  expect((await perform(page, { type: "note.history", id: note.id })).map((c) => c.reverts?.how ?? "edit")).toEqual(["edit"]);

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
  expect((await hows(page, note.id)).at(-1)).toBe("undo");
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
  expect(await hows(page, id)).toEqual(["edit", "edit"]);

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
  expect(await text(page, id)).toBe("# one two");
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
