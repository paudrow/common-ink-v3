import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const column = (page: Page, name: string) => editor(page).getByRole("region", { name, exact: true });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
/** A board's lines as written, shown above it while the cursor is in them. */
const sourceLines = (page: Page) => page.locator(".cm-line.embed-source-line");

const DRAFT = "- [ ] !! Draft the post due:2030-01-15 #writing";

async function open(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const linked = await perform(page, { type: "note.create", text: "# Reading list\n" });
  const board = `## To do\n${DRAFT}\n- Read [[${linked.id}]] with [[person:Sam Okafor]]\n\n## Done\n`;
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n/kanban()\n\`\`\`markdown\n${board}\`\`\`\n` });
  await page.goto(`/note/${note.id}`);
  const cards = column(page, "To do").getByRole("listitem");
  await expect(cards).toHaveCount(2);
  return { note, linked, cards };
}

test("a card is drawn as the note draws its line: a todo's box, a link by its note's title, a mention, and a priority, a due date and a tag as chips, with no list mark", async ({ page }) => {
  const { linked, cards } = await open(page);
  const draft = cards.nth(0);
  await expect(draft.getByRole("checkbox", { name: "Not done" })).not.toBeChecked();
  await expect(draft.getByRole("button", { name: "Priority: Medium" })).toBeVisible();
  await expect(draft.getByRole("button", { name: "Due date: Jan 15, 2030" })).toBeVisible();
  await expect(draft.getByRole("button", { name: "#writing", exact: true })).toBeVisible();
  await expect(draft).toHaveText(/^\[ \]\s+!!\s*Draft the post\s*Jan 15, 2030\s*#writing$/, { useInnerText: true });
  const reading = cards.nth(1);
  await expect(reading.getByRole("link", { name: "Reading list" })).toBeVisible();
  await expect(reading.getByRole("link", { name: "@Sam Okafor" })).toBeVisible();
  await expect(reading).toHaveText(/^Read Reading list with\s+@Sam Okafor$/, { useInnerText: true });

  // A link is its note's title as it is now.
  await perform(page, { type: "note.write", id: linked.id, baseRevision: 1, text: "# Books to read\n" });
  await expect(reading.getByRole("link", { name: "Books to read" })).toBeVisible({ timeout: 20_000 });
});

test("a card's box ticks the todo and a chip's menu changes it, each writing the card's line in the board's markdown as the note's own would", async ({ page }) => {
  const { note, cards } = await open(page);
  const draft = cards.nth(0);
  await draft.getByRole("checkbox", { name: "Not done" }).click();
  await expect.poll(() => read(page, note.id)).toContain("- [x] !! Draft the post due:2030-01-15 #writing\n");
  await expect(column(page, "To do").getByRole("listitem").nth(0).getByRole("checkbox", { name: "Done" })).toBeChecked();
  // The board is still drawn, and the cursor didn't go into its lines.
  await expect(sourceLines(page)).toHaveCount(0);

  await column(page, "To do").getByRole("listitem").nth(0).getByRole("button", { name: "Priority: Medium" }).click();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect.poll(() => read(page, note.id)).toContain("- [x] !!! Draft the post due:2030-01-15 #writing\n");
  await expect(column(page, "To do").getByRole("listitem").nth(0).getByRole("button", { name: "Priority: High" })).toBeVisible();
});

test("a press on a card's words puts the cursor at the end of its line in the board's markdown, and the card's lines take no keys", async ({ page }) => {
  const { note, cards } = await open(page);
  await cards.nth(0).getByText("Draft the post").click();
  await expect(sourceLines(page).filter({ hasText: "Draft the post" })).toBeVisible();
  await page.keyboard.type(" soon");
  await expect.poll(() => read(page, note.id)).toContain(`${DRAFT} soon\n`);
  // Tab goes past the cards' lines: they are pressed, and changed in the note.
  await expect(page.locator(".kanban-card-text .cm-content").first()).toHaveAttribute("tabindex", "-1");
});
