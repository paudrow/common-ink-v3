import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CalendarEvent, Note } from "../../src/core/protocol.ts";
import { anotherPerson, connectAgent, join, me, newEmail, perform, signInAs, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

const dashboard = (page: Page) => page.getByRole("region", { name: "Dashboard", exact: true });
const card = (page: Page, name: string) => dashboard(page).getByRole("region", { name, exact: true });
const events = (page: Page) => card(page, "Today's events");
const todos = (page: Page) => card(page, "Due today or earlier");
const todays = (page: Page) => card(page, "Today's notes");
const pinned = (page: Page) => card(page, "Pinned");
const changes = (page: Page) => card(page, "Changes since your last visit");
const CARDS = ["Today's events", "Due today or earlier", "Today's notes", "Pinned", "Changes since your last visit"];
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const what = (within: Locator) => within.locator(".dash-what");

/** The dashboard with every section's answer in. */
async function settled(page: Page) {
  await expect(dashboard(page)).toBeVisible();
  for (const name of CARDS) await expect(card(page, name)).toHaveAttribute("aria-busy", "false");
}

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await settled(page);
}

const written = (time: number) => new Date(time).toISOString().slice(0, 10);
const shift = (day: string, by: number) => written(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS);

test("the app opens to the dashboard, which makes nothing: no daily note until the member starts one", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(dashboard(page).getByRole("heading", { level: 1 })).toHaveText("Dashboard");
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(events(page)).toContainText("No calendar is connected.");
  await expect(todos(page)).toContainText("Nothing is due.");
  await expect(pinned(page)).toContainText("Nothing is pinned.");
  await expect(changes(page)).toContainText("Nothing has changed.");
  await expect(changes(page).getByRole("button", { name: "Mark as read" })).toBeDisabled();
  expect(await perform(page, { type: "note.list", includeArchived: true })).toEqual([]);
  expect((await perform(page, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Unsorted"]);

  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  await todays(page).getByRole("button", { name: "Start today's note" }).click();
  await expect(editor(page)).toContainText(today);
  const daily = await perform(page, { type: "daily.find", on: today });
  expect(daily.note?.title).toBe(today);

  // With a tab open, `/` returns to it, and the Dashboard is at its own address.
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${daily.note!.id}$`));
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await settled(page);
  await expect(todays(page).getByRole("button", { name: "Start today's note" })).toHaveCount(0);
  await expect(todays(page).getByRole("link")).toHaveText([`${today}Your daily note`]);
  await todays(page).getByRole("link", { name: today }).click();
  await expect(page).toHaveURL(new RegExp(`${daily.note!.id}$`));
});

test("each section is its full size before its answer arrives, so nothing moves as they fill in", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  const plan = await perform(page, { type: "note.create", text: `# Plan\n\n${Array.from({ length: 12 }, (_, i) => `- [ ] Step ${i} due:${today}`).join("\n")}` });
  for (let i = 0; i < 9; i++) await perform(page, { type: "pin.set", id: (await perform(page, { type: "note.create", text: `# Note ${i}` })).id, pinned: true });
  await perform(page, { type: "pin.set", id: plan.id, pinned: true });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/" });

  let holding = true;
  const held: (() => void)[] = [];
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (holding) await new Promise<void>((release) => held.push(release));
    await route.continue();
  });
  await page.goto("/dashboard");
  await expect(dashboard(page)).toBeVisible();
  for (const name of CARDS) await expect(card(page, name)).toHaveAttribute("aria-busy", "true");
  const boxes = () => Promise.all([dashboard(page).getByRole("heading", { level: 1 }), ...CARDS.map((name) => card(page, name)), ...CARDS.map((name) => card(page, name).getByRole("heading", { level: 3 }))].map((el) => el.boundingBox()));
  const waiting = await boxes();

  holding = false;
  for (const release of held) release();
  await settled(page);
  await expect(what(todos(page))).toHaveCount(12);
  await expect(what(pinned(page))).toHaveCount(10);
  await expect(what(todays(page))).toHaveCount(11);

  expect(await boxes()).toEqual(waiting);
  expect(waiting.every((box) => box !== null && box.height > 0)).toBe(true);
});

/** A zone on each side of UTC, far enough out that at any moment the date in one of them is not the date in UTC. */
const ZONES = [
  { timezoneId: "Pacific/Kiritimati", ahead: 14 * HOUR },
  { timezoneId: "Etc/GMT+12", ahead: -12 * HOUR },
] as const;

test("at any moment, the date in one of the zones the tests below run in is not the date in UTC", () => {
  const now = Date.now();
  expect(ZONES.map(({ ahead }) => written(now + ahead)).filter((day) => day !== written(now)).length).toBeGreaterThanOrEqual(1);
});

for (const { timezoneId, ahead } of ZONES) {
  test.describe(`in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test("today is the member's day: todos due, events still ahead and notes edited are read by the date where they are", async ({ page }) => {
      await signInAsNewPerson(page, "Ada Lovelace");
      await settled(page);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(timezoneId);
      const now = Date.now();
      const today = written(now + ahead);
      test.info().annotations.push({ type: "dates", description: `${today} in ${timezoneId}, ${written(now)} in UTC` });
      const endOfToday = Date.parse(`${shift(today, 1)}T00:00:00Z`) - ahead;

      const plan = await perform(page, { type: "note.create", text: `# Plan\n\n- [ ] Pay rent due:${today}\n- [ ] File taxes due:${shift(today, -1)}\n- [ ] Book flights due:${shift(today, 1)}\n- [ ] Someday\n- [x] Already done due:${today}` });

      await perform(page, { type: "source.connect", id: "sample-calendar", back: "/" });
      // The occurrences every listing of today is made from: those of the last three dates in UTC and of this one, listed from the start
      // of the first of those dates so that none earlier in it is cut off. test/core/dashboard-week.test.ts makes this same choice at every
      // hour of a week and finds three or more each time, so this never depends on when it runs.
      const { events: listed } = await perform(page, { type: "event.list", from: Date.parse(`${written(now - 3 * DAY_MS)}T00:00:00Z`), to: now + DAY_MS, timeZone: "UTC" });
      const movable = listed.filter((e) => e.editable && e.id.slice(-10) >= written(now - 3 * DAY_MS) && e.id.slice(-10) <= written(now));
      expect(movable.length).toBeGreaterThanOrEqual(3);
      const move = (event: CalendarEvent, title: string, when: CalendarEvent["when"]) => perform(page, { type: "event.update", sourceId: event.sourceId, id: event.id, etag: event.etag, title, when });
      await move(movable[0]!, "Moved all day", { allDay: true, from: today, to: today });
      await move(movable[1]!, "Moved and over", { allDay: false, from: now - 20 * MINUTE, to: now - 10 * MINUTE });
      await move(movable[2]!, "Moved and ahead", { allDay: false, from: now + HOUR, to: now + 2 * HOUR });

      await openDashboard(page);
      await expect(what(todos(page))).toHaveText(["File taxes", "Pay rent"]);
      await expect(todos(page).locator(".todo-due")).toHaveText(["Yesterday", "Today"]);
      await expect(what(todays(page))).toContainText(["Plan"]);

      const shown = await what(events(page)).allTextContents();
      expect(shown).toContain("Moved all day");
      expect(shown).not.toContain("Moved and over");
      expect(shown.includes("Moved and ahead"), "an event an hour ahead is today's unless midnight comes first").toBe(now + HOUR < endOfToday);
      // Every other event shown is one of today's that hasn't ended, give or take the seconds this test takes.
      const { events: after } = await perform(page, { type: "event.list", from: now - 3 * DAY_MS, to: now + 2 * DAY_MS, timeZone: "UTC" });
      const mayShow = after.filter(({ when }) => (when.allDay ? when.from <= today && when.to >= today : when.from < endOfToday && when.to > now - MINUTE)).map((e) => e.title);
      expect(shown.filter((title) => !mayShow.includes(title))).toEqual([]);
      const allDay = events(page).getByRole("button", { name: /Moved all day/ });
      await expect(allDay.locator(".dash-meta")).toHaveText("All day");

      await todos(page).getByRole("button", { name: /Pay rent/ }).click();
      await expect(page).toHaveURL(new RegExp(`${plan.id}$`));
      await expect(editor(page)).toBeFocused();
      expect(await page.evaluate(() => getSelection()!.anchorNode!.parentElement!.closest(".cm-line")!.textContent)).toContain("Pay rent");

      // The same member a day later, by the clock of their browser: yesterday's note and events are no longer today's, and tomorrow's todo is.
      const later = await page.context().newPage();
      later.on("pageerror", (err) => errors.push(err.message));
      await later.clock.install({ time: now + DAY_MS });
      await openDashboard(later);
      await expect(what(todos(later))).toHaveText(["File taxes", "Pay rent", "Book flights"]);
      await expect(todos(later).locator(".todo-due")).toHaveText([/^[A-Z][a-z]{2} \d+$/, "Yesterday", "Today"]);
      await expect(todays(later)).toContainText("No notes were created or edited today.");
      await expect(what(todays(later)).filter({ hasText: "Plan" })).toHaveCount(0);
      const tomorrows = await what(events(later)).allTextContents();
      expect(tomorrows.filter((title) => title.startsWith("Moved"))).toEqual([]);
    });
  });
}

test("a member pins a note from its bar: the pin is theirs alone, follows them to another browser, and is not in the note", async ({ page }) => {
  const email = newEmail();
  await signInAs(page, email, "Ada Lovelace");
  await settled(page);
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const plan = await perform(page, { type: "note.create", text: "# Plan\n\nFirst line" });
  await perform(page, { type: "note.create", text: "# Other" });

  await page.goto(`/note/${plan.id}`);
  await expect(editor(page)).toContainText("First line");
  const pin = page.getByRole("button", { name: "Pin to dashboard" });
  await expect(pin).toBeEnabled();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  const line = page.locator(".cm-line").first();
  const before = await line.boundingBox();
  await pin.click();
  const unpin = page.getByRole("button", { name: "Unpin from dashboard" });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  expect(await line.boundingBox(), "pinning moves nothing in the note").toEqual(before);
  await expect.poll(async () => (await perform(page, { type: "pin.list" })).map((n) => n.title)).toEqual(["Plan"]);
  const read = await perform(page, { type: "note.read", id: plan.id });
  expect([read.text, read.revision]).toEqual(["# Plan\n\nFirst line", 1]);

  await openDashboard(page);
  await expect(what(pinned(page))).toHaveText(["Plan"]);

  // Grace, in the same workspace, sees the same note and no pin.
  await grace.goto(`/note/${plan.id}`);
  await expect(editor(grace)).toContainText("First line");
  await expect(grace.getByRole("button", { name: "Pin to dashboard" })).toHaveAttribute("aria-pressed", "false");
  expect(await perform(grace, { type: "pin.list" }, workspaceId)).toEqual([]);

  // Ada again, in a browser that has never been here.
  const elsewhere = await (await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await signInAs(elsewhere, email, "Ada Lovelace");
  await settled(elsewhere);
  await expect(what(pinned(elsewhere))).toHaveText(["Plan"]);

  await pinned(page).getByRole("button", { name: "Unpin Plan" }).click();
  await expect(pinned(page)).toContainText("Nothing is pinned.");
  await expect.poll(() => perform(page, { type: "pin.list" })).toEqual([]);
  await page.reload();
  await settled(page);
  await expect(pinned(page)).toContainText("Nothing is pinned.");
});

test("a pin leaves the dashboard when its note goes to Trash or out of the member's sight, and says nothing of it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const diary = await perform(page, { type: "note.create", text: "# Diary" });
  const plan = await perform(page, { type: "note.create", text: "# Plan" });
  const keep = await perform(page, { type: "note.create", text: "# Keep" });
  for (const note of [diary, plan, keep]) await perform(grace, { type: "pin.set", id: note.id, pinned: true }, workspaceId);

  // Grace reaches Ada's workspace by a note in it, since a note's address names no workspace.
  await grace.goto(`/note/${keep.id}`);
  await expect(editor(grace)).toContainText("Keep");
  await grace.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" }).click();
  await settled(grace);
  await expect(what(pinned(grace))).toHaveText(["Diary", "Plan", "Keep"]);

  // The app hears within seconds that a note went to Trash, and the pin leaves with it.
  await perform(page, { type: "note.trash", id: plan.id });
  await expect(what(pinned(grace))).toHaveText(["Diary", "Keep"]);

  // A note that left the member's sight is not listed, and nothing says it was there. The pin is kept, and is back when the note is.
  await perform(page, { type: "note.setPrivate", id: diary.id, private: true });
  await grace.reload();
  await settled(grace);
  await expect(what(pinned(grace))).toHaveText(["Keep"]);
  await expect(dashboard(grace)).not.toContainText("Diary");
  await perform(page, { type: "note.restore", id: plan.id });
  await perform(page, { type: "note.setPrivate", id: diary.id, private: false });
  await expect(what(pinned(grace))).toHaveText(["Diary", "Plan", "Keep"], { timeout: 25_000 });
});

test("an archived note keeps its pin and says so: its bar shows it pinned after a reload, and it is on the dashboard again once unarchived", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const old = await perform(page, { type: "note.create", text: "# Old plan" });
  await perform(page, { type: "note.archive", id: old.id, archived: true });

  await page.goto(`/note/${old.id}`);
  await expect(editor(page)).toContainText("Old plan");
  const pin = page.getByRole("button", { name: "Pin to dashboard" });
  await expect(pin).toHaveAccessibleDescription("Pin to dashboard. An archived note is on your dashboard once it is unarchived.");
  await pin.click();
  await expect.poll(async () => (await perform(page, { type: "pin.list", includeArchived: true })).map((n) => n.title)).toEqual(["Old plan"]);

  await page.reload();
  await expect(editor(page)).toContainText("Old plan");
  const unpin = page.getByRole("button", { name: "Unpin from dashboard" });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await expect(unpin).toHaveAccessibleDescription("Pinned. It is on your dashboard again once this note is unarchived.");

  await openDashboard(page);
  await expect(pinned(page)).toContainText("Nothing is pinned.");
  await perform(page, { type: "note.archive", id: old.id, archived: false });
  await expect(what(pinned(page))).toHaveText(["Old plan"]);
});

test("the summary lists what others and agents changed since the member marked it read, and only marking it read moves that", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const claude = await connectAgent(page, "Claude");
  const plan = await perform(page, { type: "note.create", text: "# Plan" });
  const budget = await perform(page, { type: "note.create", text: "# Budget" });
  await perform(grace, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nGrace" }, workspaceId);
  await claude.tool<Note>("write_note", { id: plan.id, baseRevision: 2, text: "# Plan\n\nGrace\n\nClaude" });
  await perform(page, { type: "note.write", id: budget.id, baseRevision: 1, text: "# Budget\n\nAda's own" });
  const hers = await perform(grace, { type: "note.create", text: "# Hers alone\n\nSecret" }, workspaceId);
  await perform(grace, { type: "note.setPrivate", id: hers.id, private: true }, workspaceId);

  const rows = (on: Page) => changes(on).getByRole("list", { name: "Changed notes" }).getByRole("link");
  await openDashboard(page);
  await expect(rows(page)).toHaveText([/^Plan2 changes by Claude \(agent\), Grace Hopper · /]);
  await expect(changes(page)).toContainText("By others in the last 7 days.");
  await expect(changes(page)).not.toContainText(/Hers alone|Budget/);

  // Looking is not reading: a reload and a second tab show the same summary.
  await page.reload();
  await settled(page);
  await expect(rows(page)).toHaveCount(1);
  const second = await page.context().newPage();
  await openDashboard(second);
  await expect(rows(second)).toHaveText([/^Plan2 changes/]);
  expect((await perform(page, { type: "visit.read" })).readUntil).toBeNull();

  await changes(page).getByRole("button", { name: "Mark as read" }).click();
  await expect(changes(page)).toContainText("Nothing has changed.");
  await expect(changes(page)).toContainText("By others since you marked changes read on ");
  expect((await perform(page, { type: "visit.read" })).readUntil).not.toBeNull();
  await second.reload();
  await settled(second);
  await expect(changes(second)).toContainText("Nothing has changed.");

  // What changes after that is there when the member comes back to the window, without a reload.
  await perform(grace, { type: "note.write", id: budget.id, baseRevision: 2, text: "# Budget\n\nAda's own\n\nGrace's" }, workspaceId);
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect(rows(page)).toHaveText([/^Budget1 change by Grace Hopper · /]);

  await rows(page).first().click();
  await expect(page).toHaveURL(new RegExp(`${budget.id}$`));
  await expect(editor(page)).toContainText("Grace's");
  // A single click opens a preview tab, as it does from the note list.
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Budget" })).toHaveAttribute("data-preview", "true");
  // Opening the note is not marking the summary read.
  await page.goBack();
  await settled(page);
  await expect(rows(page)).toHaveText([/^Budget1 change/]);
});

/** How many times each of the dashboard's operations has been asked of the server from `page` since this was called. */
function counting(page: Page) {
  const asked: Record<string, number> = { "event.list": 0, "todo.list": 0, "daily.find": 0, "pin.list": 0, "visit.read": 0, "history.list": 0 };
  page.on("request", (request) => {
    if (!request.url().endsWith("/ops")) return;
    const { type } = request.postDataJSON() as { type: string };
    if (type in asked) asked[type]!++;
  });
  return { asked, reset: () => void Object.keys(asked).forEach((type) => (asked[type] = 0)) };
}

test("the dashboard asks for each section once, nothing while idle, and almost nothing while someone else types", async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  await perform(page, { type: "note.create", text: `# Plan\n\n- [ ] Pay rent due:${today}` });
  const draft = await perform(page, { type: "note.create", text: "# Draft" });
  for (let i = 0; i < 3; i++) await perform(page, { type: "note.create", text: `# Note ${i}` });

  const { asked, reset } = counting(page);
  await openDashboard(page);
  await expect(what(todos(page))).toHaveText(["Pay rent"]);
  // Long enough for the app to have listed its notes again, twice.
  await page.waitForTimeout(11_000);
  expect(asked, "on load").toEqual({ "event.list": 1, "todo.list": 1, "daily.find": 1, "pin.list": 1, "visit.read": 1, "history.list": 1 });

  reset();
  await page.waitForTimeout(11_000);
  expect(asked, "with nothing changing").toEqual({ "event.list": 0, "todo.list": 0, "daily.find": 0, "pin.list": 0, "visit.read": 0, "history.list": 0 });

  // Grace types in a note for a quarter of a minute, a save every two seconds, and Ada types in another tab.
  let text = "# Draft\n";
  for (let revision = 1; revision <= 8; revision++) {
    text += `\nword ${revision}`;
    await perform(grace, { type: "note.write", id: draft.id, baseRevision: revision, text }, workspaceId);
    await page.waitForTimeout(2000);
  }
  expect(asked["history.list"], "the summary is read once for all of it, not once a save").toBeLessThanOrEqual(1);
  expect(asked["visit.read"]).toBeLessThanOrEqual(1);
  expect({ ...asked, "history.list": 0, "visit.read": 0 }, "a note with no todo in it changes no other section").toEqual({ "event.list": 0, "todo.list": 0, "daily.find": 0, "pin.list": 0, "visit.read": 0, "history.list": 0 });
  // And it is read: the summary has all of Grace's changes within the half minute after her last, having read at most once each half minute.
  await expect(changes(page).getByRole("list", { name: "Changed notes" }).getByRole("link")).toHaveText([/^Draft8 changes by Grace Hopper · /], { timeout: 40_000 });
  expect(asked["history.list"]).toBeLessThanOrEqual(2);

  // The member's own typing, here from another tab, reads nothing.
  reset();
  const own = await perform(page, { type: "note.create", text: "# Mine" });
  await perform(page, { type: "note.write", id: own.id, baseRevision: 1, text: "# Mine\n\nmore" });
  await page.waitForTimeout(8000);
  expect([asked["history.list"], asked["visit.read"], asked["todo.list"]]).toEqual([0, 0, 0]);
});

test("with more changes than the summary reads, its counts say they are the least there can be, and it says where the rest are", async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const notes: Note[] = [];
  for (let i = 0; i < 6; i++) notes.push(await perform(page, { type: "note.create", text: `# Note ${i}` }));
  // Twenty changes to each of six notes, a note at a time: the latest hundred leave out the first note.
  await grace.evaluate(
    async ({ ids, workspaceId }) => {
      for (const id of ids) {
        let text = "# Note";
        for (let revision = 1; revision <= 20; revision++) {
          text += `\nline ${revision}`;
          const res = await fetch(`/api/workspaces/${workspaceId}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note.write", id, baseRevision: revision, text }) });
          if (!res.ok) throw new Error(await res.text());
        }
      }
    },
    { ids: notes.map((n) => n.id), workspaceId },
  );

  await openDashboard(page);
  const metas = await changes(page).getByRole("list", { name: "Changed notes" }).locator(".dash-meta").allTextContents();
  expect(metas.map((meta) => meta.replace(/ · .*/, ""))).toEqual(Array.from({ length: 5 }, () => "20+ changes by Grace Hopper"));
  await expect(changes(page).getByRole("note")).toContainText("There are more changes than the latest 100");
  await expect(changes(page).getByRole("button", { name: "Mark all as read" })).toBeEnabled();
  await expect(changes(page).getByRole("button", { name: "Mark as read", exact: true })).toHaveCount(0);

  await changes(page).getByRole("button", { name: "See them all on the History page" }).click();
  await expect(page).toHaveURL(/\/history$/);
  const sevenDaysAgo = await page.evaluate(() => new Date(Date.now() - 7 * 86_400_000).toLocaleDateString("en-CA"));
  await expect(page.getByLabel("From")).toHaveValue(sevenDaysAgo);
});

test("a guest's dashboard shows what they were granted and nothing else of the workspace", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  const shared = await perform(page, { type: "note.create", text: `# Shared\n\n- [ ] Review the draft due:${today}` });
  const hidden = await perform(page, { type: "note.create", text: `# Hidden\n\n- [ ] Fire the caterer due:${today}` });
  const gus = await anotherPerson(page, "Gus Guest");
  await perform(page, { type: "grant.set", noteId: shared.id, email: (await me(gus)).person.email, access: "view" });
  await perform(page, { type: "note.write", id: shared.id, baseRevision: 1, text: `# Shared\n\n- [ ] Review the draft due:${today}\n\nMore` });
  await perform(page, { type: "note.write", id: hidden.id, baseRevision: 1, text: `# Hidden\n\n- [ ] Fire the caterer due:${today}\n\nMore` });

  await gus.goto(`/note/${shared.id}`);
  await expect(editor(gus)).toContainText("Review the draft");
  await gus.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" }).click();
  await settled(gus);

  await expect(what(todos(gus))).toHaveText(["Review the draft"]);
  await expect(what(todays(gus))).toHaveText(["Shared"]);
  await expect(todays(gus).getByRole("button", { name: "Start today's note" })).toHaveCount(0);
  await expect(what(changes(gus))).toHaveText(["Shared"]);
  await expect(dashboard(gus)).not.toContainText(/Hidden|caterer/);
});

test("the Dashboard is a plugin: turned off, its page, its link and the pin are gone and the app opens to the editor", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await settled(page);
  const note = await perform(page, { type: "note.create", text: "# Plan" });

  await page.goto("/plugins");
  await page.getByRole("checkbox", { name: "Dashboard", exact: true }).setChecked(false);
  await expect(page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await expect(page.getByRole("button", { name: "Pin to dashboard" })).toHaveCount(0);

  await page.goto("/plugins");
  await page.getByRole("checkbox", { name: "Dashboard", exact: true }).setChecked(true);
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Dashboard" }).click();
  await settled(page);
});
