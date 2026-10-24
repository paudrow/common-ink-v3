import { expect, type Page } from "@playwright/test";
import { anotherPerson, join, me, perform, signInAsNewPerson, test, visitor } from "./helpers.ts";
import { connectEmail, mail } from "./mail.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const offered = (page: Page) => page.getByRole("listbox").getByRole("option");
const HOUR = 3_600_000;

test("@ lists the member's latest threads, finds one by its words, and writes [[email:ref]], which holds nothing of the mail", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectEmail(page);
  await mail(page, { subject: "Budget for the engine", text: "Forty pounds, give or take.", date: new Date(Date.now() - 3 * HOUR).toUTCString() });
  await mail(page, { subject: "Lunch on Friday", text: "At the usual place?", date: new Date(Date.now() - 2 * HOUR).toUTCString() });
  await mail(page, { subject: "Gears from Babbage", text: "The gears arrived.", date: new Date(Date.now() - HOUR).toUTCString() });
  const note = await perform(page, { type: "note.create", text: "# Plans\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plans");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");

  await page.keyboard.type("See @");
  const threads = offered(page).filter({ hasText: " · " });
  await expect(threads.filter({ hasText: "Gears from Babbage" })).toHaveCount(1);
  await expect(threads.filter({ hasText: "Lunch on Friday" })).toHaveCount(1);
  await expect(threads.filter({ hasText: "Budget for the engine" })).toHaveCount(0);
  await page.keyboard.type("budget");
  await expect(offered(page).filter({ hasText: "Budget for the engine" })).toHaveCount(1);
  await expect(offered(page).filter({ hasText: "Gears" })).toHaveCount(0);
  await offered(page).filter({ hasText: "Budget for the engine" }).click();

  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toMatch(/^# Plans\n\nSee \[\[email:[a-z0-9]{12}\]\]/);
  expect((await perform(page, { type: "note.read", id: note.id })).text).not.toContain("Budget");
  await page.keyboard.type(" first.");
  await expect(editor(page).locator(".md-chip-email")).toHaveText("Budget for the engine");
});

test("a link to an email shows its subject, opens the thread, shows its sender on hover, and is Email to every other reader of the note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await connectEmail(page);
  await mail(page, { subject: "Salary review", text: "The figure we agreed is confidential.", from: "Boss <boss@corp.example>", forwards: [] });
  const [thread] = (await perform(page, { type: "email.list" })).threads;
  const { ref } = await perform(page, { type: "record.refer", sourceId: "email", id: thread!.id });
  const note = await perform(page, { type: "note.create", text: `# Plans\n\nRead [[email:${ref}]] and [[email:${ref}|the review]]` });
  await page.goto(`/note/${note.id}`);
  const chips = editor(page).locator(".md-chip-email");
  await expect(chips).toHaveText(["Salary review", "the review"]);
  await expect(chips.first()).toHaveAttribute("data-state", "live");

  await chips.first().hover();
  const card = page.locator(".email-card");
  await expect(card).toContainText("boss@corp.example");
  await expect(card).toContainText("The figure we agreed is confidential.");

  await chips.first().click();
  await expect(page).toHaveURL(new RegExp(`/email/${thread!.id}$`));
  await expect(page.getByRole("heading", { name: "Salary review" })).toBeVisible();

  // gd on the link opens it too.
  await page.goto(`/note/${note.id}`);
  await expect(chips.first()).toHaveAttribute("data-state", "live");
  await editor(page).click();
  for (const key of ["g", "g", "2", "j", "w", "g", "d"]) await page.keyboard.press(key);
  await expect(page).toHaveURL(new RegExp(`/email/${thread!.id}$`));

  // Another member, a guest and anyone with a share link read the note: each sees "Email", or the note's own words, and nothing of the mail.
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  await grace.goto(`/note/${note.id}`);
  const gus = await anotherPerson(page, "Gus Guest");
  await perform(page, { type: "grant.set", noteId: note.id, email: (await me(gus)).person.email, access: "view" });
  await gus.goto(`/note/${note.id}`);
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const anyone = await visitor(page);
  await anyone.goto(`/s/${link.to.token}`);
  for (const reader of [grace, gus, anyone]) {
    const theirs = editor(reader).locator(".md-chip-email");
    await expect(theirs).toHaveText(["Email", "the review"]);
    await expect(theirs.first()).not.toHaveAttribute("data-state", "live");
    await theirs.first().hover();
    await reader.waitForTimeout(600);
    await expect(reader.locator(".email-card")).toHaveCount(0);
    await theirs.first().click();
    await expect(reader).not.toHaveURL(/\/email\//);
    const seen = await reader.content();
    expect(seen).not.toContain("Salary review");
    expect(seen).not.toContain("confidential");
    expect(seen).not.toContain("boss@corp.example");
  }
});
