import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

// Each of these lines took a pattern that tried again from every space: seconds of a stalled page,
// growing with the square of the line, for whoever read or typed in the note another person wrote.
const N = 80_000;
/** The longest a page may stall while it loads, which counts starting the app on a busy machine as well. Before, these took tens of seconds. */
const LOADED = 3000;

/** Counts, from before the page's own script, the longest the page went without running a 20 ms timer. */
async function watchStalls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { longestStall: number };
    w.longestStall = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.longestStall = Math.max(w.longestStall, now - last);
      last = now;
    }, 20);
  });
  return async () => {
    // A frame drawn after what was asked for: the page is free again.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))));
    return Math.round(await page.evaluate(() => (window as unknown as { longestStall: number }).longestStall));
  };
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

test("a share link's visitor reads a heading of many spaces without the page stalling", async ({ page, browser }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n## a${" ".repeat(2 * N)}b ##\n\nAfter.` });
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const anyone = await (await browser.newContext()).newPage();
  const longest = await watchStalls(anyone);
  await anyone.goto(`/s/${link.to.token}`);
  await expect(anyone.locator(".cm-content")).toContainText("Plan");
  expect(await longest()).toBeLessThan(LOADED);
});

test("a board whose column's heading holds many spaces is drawn, and the column coloured, without the page stalling", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Board\n\n:::kanban{}\n## a${" ".repeat(N)}b\n- write\n\n## Done {.green}\n:::\n` });
  const longest = await watchStalls(page);
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".embed-frame-block").getByText("write")).toBeVisible();
  expect(await longest()).toBeLessThan(LOADED);

  await page.evaluate(() => ((window as unknown as { longestStall: number }).longestStall = 0));
  await editor(page).getByRole("button", { name: /^Colour of a .*: no colour$/ }).click();
  await page.getByRole("dialog", { name: /^Colour of a/ }).getByRole("radio", { name: "Blue" }).click();
  await expect.poll(async () => ((await perform(page, { type: "note.read", id: note.id })) as { text: string }).text, { timeout: 30_000 }).toContain("b {.blue}\n- write");
  expect(await longest()).toBeLessThan(1500);
});

test("a cell is typed in beside a cell of many spaces without the page stalling", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // Fewer: the table is written again with every cell as wide as that one.
  const note = await perform(page, { type: "note.create", text: `# Stock\n\n| Name | Qty |\n| - | - |\n| a${" ".repeat(N / 2)}b | 12 |\n\nAfter.` });
  const longest = await watchStalls(page);
  await page.goto(`/note/${note.id}`);
  const qty = editor(page).locator('[data-focus="1,1"]');
  await expect(qty).toHaveText("12");
  // Only the typing is timed.
  await longest();
  await page.evaluate(() => ((window as unknown as { longestStall: number }).longestStall = 0));
  await qty.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("144");
  await page.keyboard.press("Tab");
  await expect.poll(async () => ((await perform(page, { type: "note.read", id: note.id })) as { text: string }).text, { timeout: 30_000 }).toContain("| 144 |");
  expect(await longest()).toBeLessThan(1500);
});
