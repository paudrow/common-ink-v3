import { expect, test, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { anotherPerson, connectAgent, join, panelIcon, perform, runCommand, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const TEXT = "# Plan\n\nAda's step\n\nEd's step\n\nClaude's step";

/** A plan Ada started, Ed added a step to, and then Ada's agent Claude did, open in Ada's editor. */
async function plan(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const ed = await anotherPerson(page, "Ed Editor");
  const { workspaceId } = await join(ed, page, "editor");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\nAda's step" });
  await perform(ed, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nAda's step\n\nEd's step" }, workspaceId);
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 2, text: TEXT });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-content")).toContainText("Claude's step");
  return { id: note.id, ed, workspaceId };
}

/** Each bar beside the lines, top to bottom: the line it is beside and how it is drawn. */
const bars = (page: Page) => page.locator(".who-bar").evaluateAll((els) => els.map((el) => `${(el as HTMLElement).dataset.line} ${(el as HTMLElement).dataset.tone}`));
const bar = (page: Page, line: number) => page.locator(`.who-bar[data-line="${line}"]`);
const tones = async (page: Page) => (await bars(page)).map((b) => b.split(" ")[1]!.replace(/-\d$/, ""));

/** Where every line of the note and its text are on the page. */
const layout = (page: Page) =>
  page.locator(".cm-content .cm-line").evaluateAll((lines) =>
    lines.map((line) => {
      const box = line.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height, text.x, text.y, text.width, text.height].map((n) => Math.round(n * 100) / 100);
    }),
  );

test("Who wrote this marks each line with who last wrote it, members and agents apart and the member's own quiet, and nothing in the note moves", async ({ page }) => {
  await plan(page);
  const before = await layout(page);
  await expect(page.locator(".who-bar")).toHaveCount(0);

  await runCommand(page, "Who wrote this");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "agent"]);
  expect((await bars(page)).map((b) => b.split(" ")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  expect(await layout(page)).toEqual(before);

  // Each bar sits in the room left of the text, and the three kinds are three colours.
  const drawn = await page.locator(".who-bar").evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { right: box.right, colour: getComputedStyle(el, "::before").backgroundImage === "none" ? getComputedStyle(el, "::before").backgroundColor : getComputedStyle(el).getPropertyValue("--who") };
    }),
  );
  const textLeft = (await page.locator(".cm-content .cm-line").first().evaluate((line) => line.getBoundingClientRect().left + parseFloat(getComputedStyle(line).paddingLeft)));
  for (const { right } of drawn) expect(right).toBeLessThan(textLeft);
  expect(new Set([drawn[0]!.colour, drawn[3]!.colour, drawn[5]!.colour]).size).toBe(3);

  await runCommand(page, "Who wrote this");
  await expect(page.locator(".who-bar")).toHaveCount(0);
  expect(await layout(page)).toEqual(before);
});

test("a bar says who wrote its line and when, and an agent's says whose agent it is", async ({ page }) => {
  await plan(page);
  await runCommand(page, "Who wrote this");
  const tip = page.getByRole("tooltip");
  await bar(page, 5).hover();
  await expect(tip).toHaveText("Ed Editor, just now");
  await bar(page, 7).hover();
  await expect(tip).toHaveText("Claude (your agent), just now");
  await bar(page, 1).hover();
  await expect(tip).toHaveText("You, just now");
  await page.locator(".cm-content").hover();
  await expect(tip).toHaveCount(0);
});

test("pressing a bar opens its change in the note's History", async ({ page }) => {
  await plan(page);
  await runCommand(page, "Who wrote this");
  await bar(page, 5).click();
  await expect(panelIcon(page, "History")).toHaveAttribute("aria-expanded", "true");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.locator(".hist-row.selected")).toHaveCount(1);
  await expect(inspector.locator(".hist-row.selected")).toContainText("Ed Editor edited");
  await expect(inspector.locator(".diff")).toContainText("Ed's step");

  // With History showing, another bar shows its own change there.
  await bar(page, 7).click();
  await expect(inspector.locator(".hist-row.selected")).toContainText("Claude edited");
});

test("the bars follow typing at once, and take another member's change when it arrives", async ({ page }) => {
  const { id, ed, workspaceId } = await plan(page);
  await runCommand(page, "Who wrote this");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "agent"]);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" again");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "self"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ada's next step");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "self", "self"]);
  await bar(page, 8).hover();
  await expect(page.getByRole("tooltip")).toHaveText(/^You, /);

  await expect.poll(async () => (await perform(page, { type: "note.read", id })).text).toContain("Ada's next step");
  const { revision, text } = await perform(page, { type: "note.read", id });
  await perform(ed, { type: "note.write", id, baseRevision: revision, text: text.replace("# Plan", "# The plan") }, workspaceId);
  await expect(page.locator(".cm-content")).toContainText("The plan", { timeout: 15_000 });
  await expect.poll(() => tones(page), { timeout: 15_000 }).toEqual(["member", "self", "self", "member", "member", "agent", "self", "self"]);
});

test("the switch in a note's History panel turns the bars on and off, and the note keeps them on for the member after a reload", async ({ page }) => {
  const { id } = await plan(page);
  await panelIcon(page, "History").click();
  const toggle = page.getByRole("complementary", { name: "Inspector" }).getByRole("switch", { name: "Who wrote this" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".who-bar")).toHaveCount(7);

  await page.reload();
  await expect(page.locator(".who-bar")).toHaveCount(7);
  // Another note isn't marked for having been opened after this one.
  const other = await perform(page, { type: "note.create", text: "# Other\n\nA line" });
  await page.goto(`/note/${other.id}`);
  await expect(page.locator(".cm-content")).toContainText("A line");
  await expect(page.locator(".who-bar")).toHaveCount(0);

  await page.goto(`/note/${id}`);
  await expect(page.locator(".who-bar")).toHaveCount(7);
  await runCommand(page, "Who wrote this");
  await expect(page.locator(".who-bar")).toHaveCount(0);
});

test("with vim on, the bars come and go with nothing moving and follow what is typed", async ({ page }) => {
  await plan(page);
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.reload();
  await expect(page.locator(".cm-vim-panel")).toBeVisible();
  const before = await layout(page);
  await runCommand(page, "Who wrote this");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "agent"]);
  expect(await layout(page)).toEqual(before);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("o");
  await page.keyboard.type("From vim");
  await page.keyboard.press("Escape");
  await expect.poll(() => tones(page)).toEqual(["self", "self", "self", "member", "member", "agent", "agent", "self"]);
});

test("the command has no key of its own, and runs from one the member gives it", async ({ page }) => {
  await plan(page);
  await perform(page, { type: "settings.write", text: JSON.stringify({ "keybindings.history.whoWrote": ["mod+shift+u"] }), baseRevision: 0 });
  await page.reload();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.locator(".who-bar")).toHaveCount(7);
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.locator(".who-bar")).toHaveCount(0);
});

test("a table drawn in place of its lines has a bar beside it, of whoever last changed one of them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Budget\n\n| Item | Cost |\n|---|---|\n| Venue | 2,400 |\n\nAfter the table" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: note.text.replace("2,400", "2,500") });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-content")).toContainText("2,500");
  await runCommand(page, "Who wrote this");
  const table = bar(page, 3);
  await expect(table).toHaveAttribute("data-tone", /^agent-/);
  const [barBox, tableBox] = [await table.boundingBox(), await page.locator(".cm-content table").first().boundingBox()];
  expect(barBox!.height).toBeGreaterThan(tableBox!.height / 2);
  await table.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Claude (your agent), just now");
  expect(await tones(page)).toEqual(["self", "self", "agent", "self", "self"]);
});
