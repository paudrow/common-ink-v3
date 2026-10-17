import { expect, test, type Page } from "@playwright/test";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { connectAgent, perform, signInAsNewPerson } from "./helpers.ts";

const ZONE = "America/New_York";
test.use({ timezoneId: ZONE });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const calendar = (page: Page) => page.getByRole("region", { name: "Calendar", exact: true });
const grid = (page: Page) => calendar(page).getByRole("grid");
const prompt = (page: Page) => calendar(page).getByRole("region", { name: "Connect a calendar" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Calendars" });
const picker = (page: Page) => dialog(page).getByRole("combobox", { name: "Default calendar" });
const form = (page: Page) => page.getByRole("dialog", { name: "New event" });
/** This week's Tuesday where the browser is: the Calendar opens on the week, Monday first. */
function tuesday() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
  const monday = Date.parse(`${today}T00:00:00Z`) - ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(monday + 86_400_000).toISOString().slice(0, 10);
}
const settingsKept = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text) as Record<string, unknown>;

async function openWithSample(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  await page.goto("/calendar");
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
}

test("with no calendar connected, the Calendar asks first to connect one, in place of empty days, and connecting there shows the week", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/calendar");
  await expect(prompt(page)).toContainText("Connect a calendar to see your events here.");
  await expect(prompt(page).getByRole("listitem", { name: "Sample calendar" })).toContainText("Not connected.");
  await expect(grid(page), "no empty grid").toHaveCount(0);
  await expect(calendar(page).getByRole("button", { name: "Today" }), "no way through days there is nothing in").toHaveCount(0);
  await expect(calendar(page).getByRole("button", { name: "New event" })).toHaveCount(0);

  // The dialog holds the same list, so the prompt steps aside while it is open, and nothing is listed twice.
  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  await expect(page.getByRole("region", { name: "Data sources" })).toHaveCount(1);
  await expect(prompt(page)).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Close" }).click();

  await prompt(page).getByRole("button", { name: "Connect Sample calendar" }).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
  await expect(grid(page).getByRole("button", { name: /Planning$/ }).first()).toBeVisible();
  await expect(calendar(page).getByRole("button", { name: "Today" })).toBeVisible();
});

test("the default calendar is chosen in the Calendars dialog, kept with the account, preselected by New event and a click on the grid, and set from the form too", async ({ page }) => {
  test.slow();
  await openWithSample(page);
  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  await expect(picker(page)).toHaveValue("");
  await expect(picker(page).locator("option"), "only calendars that can be added to").toHaveText(["None chosen", "Work", "Personal"]);
  await expect(picker(page)).toHaveAccessibleDescription("No default calendar is set, so new events start in Work, the first calendar you can add to.");
  await picker(page).selectOption("sample-calendar personal");
  await expect(picker(page).locator("option")).toHaveText(["Work", "Personal"]);
  await expect(picker(page)).toHaveAccessibleDescription("New events go in Personal: New event, a drag on the grid, and an agent's that names no calendar.");
  await expect.poll(async () => (await settingsKept(page))["calendar.default"]).toBe("sample-calendar personal");
  await dialog(page).getByRole("button", { name: "Close" }).click();

  await page.reload();
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
  await calendar(page).getByRole("button", { name: "New event" }).click();
  await expect(form(page).getByLabel("Calendar")).toHaveValue("sample-calendar personal");
  await expect(form(page).getByLabel("Calendar")).toHaveAccessibleDescription("Your default calendar.");
  await expect(form(page).getByRole("button", { name: /the default$/ }), "the default is the default already").toHaveCount(0);
  await page.keyboard.press("Escape");

  // A click on the grid opens the form in the default too, and Work is made the default from it.
  await grid(page).locator(".cal-tg-scroll").evaluate((el) => (el.scrollTop = 12 * 48));
  const box = (await grid(page).locator(`.cal-col[data-day="${tuesday()}"]`).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + (18 * 60 + 40) * (48 / 60));
  await expect(form(page).getByLabel("Calendar")).toHaveValue("sample-calendar personal");
  await form(page).getByLabel("Calendar").selectOption("sample-calendar work");
  await expect(form(page).getByLabel("Calendar")).toHaveAccessibleDescription("");
  await form(page).getByRole("button", { name: "Make Work the default" }).click();
  await expect(form(page).getByLabel("Calendar")).toHaveAccessibleDescription("Your default calendar.");
  await expect.poll(async () => (await settingsKept(page))["calendar.default"]).toBe("sample-calendar work");
  await form(page).getByLabel("Title").fill("Focus time");
  await form(page).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Added Focus time")).toBeVisible();

  await page.goto("/settings/plugins/calendar");
  const row = page.locator(".setting").filter({ hasText: "calendar.default" });
  await expect(row.locator("output"), "Settings shows it, to Reset and not to type").toHaveText("sample-calendar work");
  await expect(row.getByRole("button", { name: "Reset Default calendar" })).toBeVisible();
});

test("a default that is hidden or can only be read is passed over for the calendar used last, or the first, and the page says which and why", async ({ page }) => {
  await openWithSample(page);
  await perform(page, { type: "settings.write", text: JSON.stringify({ "calendar.default": "sample-calendar holidays" }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
  await calendar(page).getByRole("button", { name: "New event" }).click();
  await expect(form(page).getByLabel("Calendar")).toHaveValue("sample-calendar work");
  await expect(form(page).getByLabel("Calendar")).toHaveAccessibleDescription("Your default calendar, Holidays, can only be read, so new events start in Work, the first calendar you can add to.");
  await form(page).getByLabel("Calendar").selectOption("sample-calendar personal");
  await form(page).getByLabel("Title").fill("Used last");
  await form(page).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Added Used last")).toBeVisible();

  await calendar(page).getByRole("button", { name: "New event" }).click();
  await expect(form(page).getByLabel("Calendar"), "the calendar added to last in this browser").toHaveValue("sample-calendar personal");
  await expect(form(page).getByLabel("Calendar")).toHaveAccessibleDescription("Your default calendar, Holidays, can only be read, so new events start in Personal, the calendar you added to last.");
  await page.keyboard.press("Escape");

  // Make Work the default, then hide it: the form says the default is hidden.
  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  await picker(page).selectOption("sample-calendar work");
  await dialog(page).getByRole("list", { name: "Calendars in Sample calendar" }).getByRole("checkbox", { name: "Work" }).uncheck();
  await expect(picker(page).locator("option")).toHaveText(["None chosen", "Personal"]);
  await expect(picker(page)).toHaveAccessibleDescription("Your default calendar, Work, is hidden, so new events start in Personal, the calendar you added to last.");
});

test("an agent's create_event that names no calendar adds to the member's default, and otherwise to the first they can add to and haven't hidden", async ({ page }) => {
  await openWithSample(page);
  const claude = await connectAgent(page, "Claude");
  const when = { allDay: true, from: "2026-11-02", to: "2026-11-02" };
  const first = await claude.tool<CalendarEvent>("create_event", { title: "No default", when });
  expect([first.calendarId, first.calendar]).toEqual(["work", "Work"]);

  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  await picker(page).selectOption("sample-calendar personal");
  await expect.poll(async () => (await settingsKept(page))["calendar.default"]).toBe("sample-calendar personal");
  const second = await claude.tool<CalendarEvent>("create_event", { title: "With a default", when });
  expect([second.calendarId, second.calendar]).toEqual(["personal", "Personal"]);
  const named = await claude.tool<CalendarEvent>("create_event", { title: "Named", when, sourceId: "sample-calendar", calendarId: "work" });
  expect(named.calendarId).toBe("work");
  await expect(claude.tool("create_event", { title: "Half named", when, calendarId: "work" })).rejects.toThrow("Name the calendar by both sourceId and calendarId, or by neither for the member's default calendar");
});
