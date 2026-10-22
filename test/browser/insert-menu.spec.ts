import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const list = (page: Page) => page.getByRole("listbox");
// A list still waiting on what was just typed takes no keys: these are its items once it has caught up.
const options = (page: Page) => page.locator(".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)").getByRole("option");
const headings = (page: Page) => list(page).locator("completion-section");
const preview = (page: Page) => page.locator(".cm-completionInfo");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
/** Time for the list to catch up with the last key, as `widgets.spec.ts` waits. */
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

async function open(page: Page, body: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: body });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(body.split("\n")[0]!);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

const EMBEDS = [/^Timer/, /^Stopwatch/, /^Kanban board/, /^Form/, /^HTML/, /^Drawing/, /^Upload an image/, /^Upload a video/, /^Upload a recording/, /^Upload a file/, /^Record your voice/, /^Insert an upload/];

test("/ says what each item makes in words, with a picture of it, under Blocks and Embeds, and never shows syntax", async ({ page }) => {
  await open(page, "# Insert\n\n");

  await page.keyboard.type("/");
  await expect(headings(page)).toHaveText(["Blocks", "Embeds"]);
  await expect(options(page).nth(0)).toHaveText("Heading 1A large title for a part of the note");
  await expect(options(page).filter({ hasText: /^Table/ })).toHaveText("TableRows and columns, typed into cell by cell");
  await expect(options(page).filter({ hasText: /^Timer/ })).toHaveText("TimerA countdown that runs the same for everyone reading the note");
  await expect(options(page).filter({ hasText: /^Upload/ })).toHaveText([
    "Upload an imageA picture from your computer, shown in the note",
    "Upload a videoA video from your computer, played in the note",
    "Upload a recordingSound from your computer, played in the note",
    "Upload a fileAny file from your computer, shown as what it is",
  ]);
  const shown = await options(page).allTextContents();
  expect(shown.filter((option) => /::|\{|\||```|^#/.test(option))).toEqual([]);
  await expect(list(page).locator(".cm-completionDetail")).toHaveCount(0);
  await expect(preview(page).locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml,/);

  await page.keyboard.type("kan");
  await expect(headings(page)).toHaveCount(0);
  await expect(options(page)).toHaveText(["Kanban boardColumns of cards to drag from one to another"]);
  await expect(preview(page).locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml,/);
});

test("/tab writes a table, and a heading, a task and a code block each leave the cursor where their words go", async ({ page }) => {
  const note = await open(page, "# Insert\n\n");

  await page.keyboard.type("/tab");
  await expect(options(page)).toHaveText([/^Table/]);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe("# Insert\n\n| Column | Column |\n| ------ | ------ |\n|        |        |\n");

  await page.keyboard.type("/h2", { delay: 20 });
  await settled(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Plan\n/code", { delay: 20 });
  await settled(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("let a;");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n/task", { delay: 20 });
  await settled(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("milk");
  await expect.poll(() => text(page, note.id)).toBe("# Insert\n\n| Column | Column |\n| ------ | ------ |\n|        |        |\n## Plan\n```\nlet a;\n```\n- [ ] milk");
});

test(":: lists the embeds alone, filters them by what follows, and writes what / writes in place of what was typed", async ({ page }) => {
  const note = await open(page, "# Plan\n\n");

  await page.keyboard.type("::");
  await expect(options(page)).toHaveText(EMBEDS);
  await expect(headings(page)).toHaveCount(0);
  await page.keyboard.type("con");
  await settled(page);
  await expect(list(page)).toHaveCount(0);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  for (const [typed, shows] of [["vid", /^Upload a video/], ["file", /^Upload a file/]] as const) {
    await page.keyboard.type(typed);
    await expect(options(page)).toHaveText([shows]);
    for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("kan");
  await expect(options(page)).toHaveText([/^Kanban board/]);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("region")).toHaveCount(3);
  await page.keyboard.type("after ::ti");
  await expect(options(page)).toHaveText([/^Timer/]);
  await settled(page);
  await page.keyboard.press("Tab");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\n:::kanban{}\n## To do\n\n## Doing\n\n## Done\n:::\nafter ::timer{5m}");
});

test("an embed typed by hand past :: is left as typed, and neither a written one nor a block's closing ::: opens the list", async ({ page }) => {
  const note = await open(page, "# Hand\n\n");

  await page.keyboard.type("::image{abcdefabcdef} and ::timer{5m}", { delay: 20 });
  await settled(page);
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  // An event or a contact is in no menu, as `@` finds them, and is still written by hand.
  await page.keyboard.type("::eve", { delay: 20 });
  await settled(page);
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.type("nt{", { delay: 20 });
  await settled(page);
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.type("}\n:::html{}\n<b>hi</b>\n:::", { delay: 20 });
  await settled(page);
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.type("x ::: y");
  await expect.poll(() => text(page, note.id)).toBe("# Hand\n\n::image{abcdefabcdef} and ::timer{5m}\n::event{}\n:::html{}\n<b>hi</b>\n:::\nx ::: y");
  await expect(editor(page).locator(".embed-unread", { hasText: /^Event: / })).toBeVisible();
});
