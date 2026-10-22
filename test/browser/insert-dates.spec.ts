import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const options = (page: Page) => page.getByRole("listbox").getByRole("option");
const preview = (page: Page) => page.locator(".cm-completionInfo");
const dates = (page: Page) => editor(page).locator(".md-chip-date");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
/** The list's groups as the member sees them: each heading, and how many items are under it. */
const groups = (page: Page) =>
  page.getByRole("listbox").evaluate((box) => {
    const found: [string, number][] = [];
    for (const row of box.querySelectorAll("completion-section, [role=option]")) {
      if (row.localName === "completion-section") found.push([row.textContent ?? "", 0]);
      else if (found.length) found.at(-1)![1]++;
    }
    return found;
  });

/** The day it is in the browser, which is the member's today, and the days from it, as a note writes them. */
async function daysHere(page: Page) {
  const today = await page.evaluate(() => {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  });
  const day = (ahead: number) => new Date(today + ahead * 86_400_000).toISOString().slice(0, 10);
  const nextMonday = 7 - ((new Date(today).getUTCDay() + 6) % 7);
  return { today: day(0), tomorrow: day(1), nextFriday: day(nextMonday + 4) };
}

/** How a chip reads a day, worked out here from the date alone. */
const reads = (day: string, time = "") => {
  const words = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", ...(day.slice(0, 4) !== String(new Date().getFullYear()) && { year: "numeric" }) });
  return time ? `${words}, ${time}` : words;
};

async function inNote(page: Page, body = "") {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n${body}` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return { note, ...(await daysHere(page)) };
}

test("@ alone offers Today and Tomorrow under Dates, after the people and before the notes, uploads and events, and narrows as I type", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  await perform(page, { type: "note.create", text: "# Budget\n\nNumbers." });
  await page.evaluate(async () => {
    const id = (await (await fetch("/api/me")).json()).workspaces[0].id;
    const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "minutes.txt" })) }, body: "We met." });
    if (!res.ok) throw new Error(await res.text());
  });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  const { today, tomorrow } = await daysHere(page);

  const read = ["contact.list", "upload.list", "event.list"].map((type) => page.waitForResponse((response) => response.request().postDataJSON()?.type === type));
  await page.keyboard.type("Started @");
  await Promise.all(read);
  await expect.poll(() => groups(page)).toEqual([
    ["People", 3],
    ["Dates", 2],
    ["Notes", 1],
    ["Uploads", 1],
    ["Events", 2],
  ]);
  await expect(options(page).nth(3)).toHaveText(/^Today\w+day, \w+ \d{1,2}, \d{4}$/);
  await expect(options(page).nth(4)).toHaveText(/^Tomorrow\w+day, \w+ \d{1,2}, \d{4}$/);
  await expect(options(page).filter({ hasText: "Pick a date…" })).toHaveCount(0);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");

  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(preview(page).locator("dd").nth(1)).toHaveText("Tomorrow");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted ${tomorrow}`);

  await page.keyboard.type(" and @budg");
  await expect(options(page)).toHaveText(["BudgetUnsorted", "Create note “budg”New note in Unsorted", "Create folder “budg”New folder at the top", "Create tag #budgNew tag"]);
  await page.keyboard.press("Escape");
  await page.keyboard.type(" @tod");
  await expect(options(page)).toHaveText([/^Today/, "Pick a date…Any day, from a calendar", "Create note “tod”New note in Unsorted", "Create folder “tod”New folder at the top", "Create tag #todNew tag"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted ${tomorrow} and @budg ${today}`);
});

test("@tod offers Today, under Dates with the full date and how far it is, and writes today's date, drawn as it reads", async ({ page }) => {
  const { note, today } = await inNote(page);
  await page.keyboard.type("Started @tod");
  await expect(options(page)).toHaveText([/^Today\w+day, \w+ \d{1,2}, \d{4}$/, "Pick a date…Any day, from a calendar", "Create note “tod”New note in Unsorted", "Create folder “tod”New folder at the top", "Create tag #todNew tag"]);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(preview(page).locator("dt")).toHaveText(["Weekday", "From today"]);
  await expect(preview(page).locator("dd").nth(1)).toHaveText("Today");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted ${today}`);
  await expect(dates(page)).toHaveText([reads(today)]);

  // The cursor inside it shows it as written, and out of it again draws it.
  await page.keyboard.press("ArrowLeft");
  await expect(dates(page)).toHaveCount(0);
  await expect(editor(page)).toContainText(`Started ${today}`);
  await page.keyboard.press("End");
  await page.keyboard.type(" then.");
  await expect(dates(page)).toHaveText([reads(today)]);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted ${today} then.`);
});

test("@tomorrow 3pm writes the day and the time, and @next fri the Friday of next week", async ({ page }) => {
  const { note, tomorrow, nextFriday } = await inNote(page);
  await page.keyboard.type("Call @tomorrow 3pm");
  await expect(options(page).first()).toHaveText(/^Tomorrow, 3:00 PM\w+day, \w+ \d{1,2}, \d{4} at 3:00 PM$/);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and review @next fri");
  await expect(options(page).first()).toHaveText(/^Next Friday/);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall ${tomorrow} 15:00 and review ${nextFriday}`);
  await expect(dates(page)).toHaveText([reads(tomorrow, "3:00 PM"), reads(nextFriday)]);
});

test("Pick a date… opens a date field at the cursor and writes the day picked there, or nothing when it is closed", async ({ page }) => {
  const { note, today } = await inNote(page);
  await page.keyboard.type("Due @pick");
  await expect(options(page)).toHaveText(["Pick a date…Any day, from a calendar", "Create note “pick”New note in Unsorted", "Create folder “pick”New folder at the top", "Create tag #pickNew tag"]);
  await page.keyboard.press("Enter");
  const field = page.getByRole("dialog", { name: "Pick a date" }).getByLabel("Date");
  await expect(field).toBeFocused();
  await field.fill("2027-03-04");
  await expect(page.getByRole("dialog", { name: "Pick a date" })).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nDue 2027-03-04");
  await expect(dates(page)).toHaveText(["Thu, Mar 4, 2027"]);
  await page.keyboard.type(" or @date");
  await expect(options(page)).toHaveText(["Pick a date…Any day, from a calendar", "Create note “date”New note in Unsorted", "Create folder “date”New folder at the top", "Create tag #dateNew tag"]);
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nDue 2027-03-04 or @date");

  // It starts empty, so today is a pick too, and a time typed before it is kept.
  await page.keyboard.type(" or @tomorrow 3pm");
  const pick = options(page).filter({ hasText: "Pick a date…" });
  await expect(pick).toHaveText("Pick a date…Any day at 3:00 PM, from a calendar");
  await pick.click();
  await expect(field).toHaveValue("");
  await field.fill(today);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nDue 2027-03-04 or @date or ${today} 15:00`);
});

test("a date is drawn where it stands on its own, not in a todo's due date, a heading, code, an embed or a link, and a click opens that day's daily note", async ({ page }) => {
  const { today } = await inNote(page);
  await page.keyboard.type(`# ${today}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`- [ ] Pay rent due:2026-11-01 before 2026-11-01`);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Not `2026-11-02`, [this](2026-11-03) or ::event{abcdefghijkl Lunch 2026-11-04}.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(`See [the report 2026-09-30](https://example.com) from ${today}.`);
  await expect(dates(page)).toHaveText([reads("2026-11-01"), reads(today)]);
  await expect(editor(page).locator(".md-chip-due")).toHaveCount(1);
  await expect(editor(page)).toContainText(`# ${today}`);

  await dates(page).last().click();
  await expect.poll(async () => (await perform(page, { type: "daily.find", on: today })).note?.id ?? null).not.toBeNull();
  const daily = (await perform(page, { type: "daily.find", on: today })).note!;
  await expect(page).toHaveURL(new RegExp(`${daily.id}$`));
  await expect(editor(page).locator(".cm-line").first()).toContainText(`# ${today}`);
  await expect(dates(page)).toHaveCount(0);
});
