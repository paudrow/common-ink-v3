import { expect, type Page } from "@playwright/test";
import { noteIdIn, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

// Noon on 2 November where the member is, in Kiritimati, fourteen hours ahead of UTC, where it is still 1 November.
test.use({ timezoneId: "Pacific/Kiritimati" });
const NOW = new Date("2026-11-01T22:00:00Z");
const TODAY = "2026-11-02";

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const notices = (page: Page) => page.getByRole("group", { name: "Notice" });
const steps = (page: Page) => editor(page).locator(".daily-steps-buttons");

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible();
}

/** The member's daily note for `day`, made as an agent or another window would make it. */
const made = async (page: Page, day: string) => (await perform(page, { type: "daily.open", on: day })).id;
const found = async (page: Page, day: string) => (await perform(page, { type: "daily.find", on: day })).note?.id ?? null;

async function showing(page: Page, id: string, day: string) {
  await expect(page).toHaveURL(new RegExp(`${id}$`));
  await expect(editor(page)).toContainText(day);
}

test("Yesterday's note opens yesterday's in the member's time zone, and says so when there is none, making nothing", async ({ page }) => {
  await start(page);

  await runCommand(page, "Yesterday's note");
  await expect(notices(page).last()).toContainText("No note for 2026-11-01");
  expect(await found(page, "2026-11-01")).toBeNull();

  const yesterday = await made(page, "2026-11-01");
  await runCommand(page, "Yesterday's note");
  await showing(page, yesterday, "2026-11-01");
});

test("Tomorrow's note makes tomorrow's in the member's time zone, headed by its date, and opens the same one again after", async ({ page }) => {
  await start(page);
  expect(await found(page, "2026-11-03")).toBeNull();

  await runCommand(page, "Tomorrow's note");
  await expect.poll(() => found(page, "2026-11-03")).not.toBeNull();
  const tomorrow = (await found(page, "2026-11-03"))!;
  await showing(page, tomorrow, "2026-11-03");
  expect((await perform(page, { type: "note.read", id: tomorrow })).text).toBe("# 2026-11-03\n\n");

  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Dashboard", exact: true })).toBeVisible();
  await runCommand(page, "Tomorrow's note");
  await showing(page, tomorrow, "2026-11-03");
  expect(await found(page, "2026-11-03")).toBe(tomorrow);
});

test("Previous day walks back from the daily note in front across the start of the month, Next day walks forward, and a day with no note is said and not made", async ({ page }) => {
  await start(page);
  const ids: Record<string, string> = {};
  for (const day of ["2026-10-30", "2026-10-31", "2026-11-01", TODAY]) ids[day] = await made(page, day);

  await page.goto(`/today`);
  await showing(page, ids[TODAY]!, TODAY);
  for (const day of ["2026-11-01", "2026-10-31", "2026-10-30"]) {
    await runCommand(page, "Previous day");
    await showing(page, ids[day]!, day);
  }
  await runCommand(page, "Previous day");
  await expect(notices(page).last()).toContainText("No note for 2026-10-29");
  await showing(page, ids["2026-10-30"]!, "2026-10-30");
  expect(await found(page, "2026-10-29")).toBeNull();

  await runCommand(page, "Next day");
  await showing(page, ids["2026-10-31"]!, "2026-10-31");
  await runCommand(page, "Next day");
  await showing(page, ids["2026-11-01"]!, "2026-11-01");
});

test("Next day from today's note makes tomorrow's, and from tomorrow's says there is none for the day after", async ({ page }) => {
  await start(page);
  await page.goto(`/today`);
  await expect(editor(page)).toContainText(TODAY);

  await runCommand(page, "Next day");
  await expect.poll(() => found(page, "2026-11-03")).not.toBeNull();
  await showing(page, (await found(page, "2026-11-03"))!, "2026-11-03");

  await runCommand(page, "Next day");
  await expect(notices(page).last()).toContainText("No note for 2026-11-04");
  expect(await found(page, "2026-11-04")).toBeNull();
});

test("off a daily note, Previous day and Next day count from today", async ({ page }) => {
  await start(page);
  const yesterday = await made(page, "2026-11-01");
  const plain = await perform(page, { type: "note.create", text: "# 2026-10-20\n\nNot a daily note." });
  await page.goto(`/note/${plain.id}`);
  await expect(editor(page)).toContainText("Not a daily note.");
  await expect(steps(page)).toHaveCount(0);

  await runCommand(page, "Previous day");
  await showing(page, yesterday, "2026-11-01");
});

test("‹ and › by a daily note's date show on hover, go to the day before and after, and move nothing in the note's text", async ({ page }) => {
  await start(page);
  const yesterday = await made(page, "2026-11-01");
  await page.goto(`/today`);
  await expect(editor(page)).toContainText(TODAY);
  const today = noteIdIn(page);
  await expect(steps(page)).toHaveCount(1);
  await expect(steps(page)).toHaveCSS("opacity", "0");

  const layout = () =>
    editor(page).evaluate((content) => {
      const range = document.createRange();
      range.selectNodeContents(content.querySelector(".cm-line")!);
      const text = [...range.getClientRects()].map((r) => [r.left, r.top, r.width, r.height]);
      const lines = [...content.querySelectorAll(".cm-line")].map((line) => {
        const r = line.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      });
      return { text, lines };
    });
  const before = await layout();
  await page.mouse.move(0, 0);
  await editor(page).locator(".cm-line").first().hover();
  await expect(steps(page)).toHaveCSS("opacity", "1");
  expect(await layout(), "the controls appearing move nothing").toEqual(before);

  const plain = await perform(page, { type: "note.create", text: `# ${TODAY}\n\n` });
  await page.goto(`/note/${plain.id}`);
  await expect(editor(page)).toContainText(TODAY);
  await expect(steps(page)).toHaveCount(0);
  const without = await layout();
  expect(without.lines.map(([, , w, h]) => [w, h]), "the date's line is as tall and wide as with no controls at all").toEqual(before.lines.map(([, , w, h]) => [w, h]));

  await page.goto(`/note/${today}`);
  await editor(page).locator(".cm-line").first().hover();
  await steps(page).getByRole("button", { name: "Previous day" }).click();
  await showing(page, yesterday, "2026-11-01");
  await editor(page).locator(".cm-line").first().hover();
  await steps(page).getByRole("button", { name: "Next day" }).click();
  await showing(page, today, TODAY);
});
