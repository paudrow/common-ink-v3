import { expect, type Page } from "@playwright/test";
import { me, perform, signInAsNewPerson, test } from "./helpers.ts";
import { connectEmail, mail, send, vouched } from "./mail.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  test.setTimeout(60_000);
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const threads = (page: Page) => page.getByRole("list", { name: "Threads" }).getByRole("listitem");
const rules = (page: Page) => page.getByRole("region", { name: "Skip rules" });

/** A forward of a newsletter that came through a mailing list. */
let sent = 0;
async function newsletter(page: Page, subject: string): Promise<Record<string, unknown>> {
  // A minute apart each, so the latest is told apart from the one before.
  const date = new Date(Date.now() - 3_600_000 + 60_000 * sent++).toUTCString();
  return mail(page, { subject, text: "Half price this weekend.", from: "Shop <deals@news.shop.example>", forwards: ["List-Id: Shop News <news.shop.example>"], date });
}

test("skip rules are written in Settings under Email, say what they match, and remove what is kept only when asked", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectEmail(page);
  await newsletter(page, "Sale one");
  await newsletter(page, "Sale two");
  await mail(page, { subject: "Plans", text: "Shall we meet?" });

  await page.goto("/settings/email");
  await expect(rules(page)).toBeVisible();
  await rules(page).getByRole("button", { name: "Add a rule" }).click();
  const form = rules(page).getByRole("form", { name: "New rule" });
  await expect(form.getByRole("status", { name: "Matches" })).toHaveText("Fill in at least one.");
  await form.getByRole("textbox", { name: "From" }).fill("shop.example");
  await form.getByRole("textbox", { name: "Has the words" }).fill('"half price"');
  await expect(form.getByRole("status", { name: "Matches" })).toContainText("Matches 2 threads kept so far");
  await expect(form.getByRole("list", { name: "Matching threads" }).getByRole("listitem")).toHaveText([/Sale two/, /Sale one/]);
  await form.getByRole("textbox", { name: "Doesn't have" }).fill("weekend");
  await expect(form.getByRole("status", { name: "Matches" })).toHaveText("Matches no thread kept so far.");
  await form.getByRole("textbox", { name: "Doesn't have" }).fill("");
  await expect(form.getByRole("status", { name: "Matches" })).toContainText("Matches 2 threads");
  await page.screenshot({ path: "test-results/email-rules-form.png" });

  // Saving asks first about the two kept, and keeping them saves the rule alone.
  await form.getByRole("button", { name: "Save rule" }).click();
  await form.getByRole("group", { name: "Already kept" }).getByRole("button", { name: "Keep them" }).click();
  const list = rules(page).getByRole("list", { name: "Rules" });
  await expect(list.getByRole("listitem")).toHaveText([/Mail from shop\.example, with "half price"/]);
  expect((await perform(page, { type: "email.list" })).threads).toHaveLength(3);

  // New mail it matches is dropped as it arrives.
  expect(await newsletter(page, "Sale three")).toEqual({ dropped: "skipped" });

  // Editing it, and this time removing what it matches.
  await list.getByRole("button", { name: "Edit" }).click();
  const edit = rules(page).getByRole("form", { name: "Edit rule" });
  await edit.getByRole("textbox", { name: "Has the words" }).fill("");
  await edit.getByRole("textbox", { name: "Mailing list" }).fill("news.shop.example");
  await expect(edit.getByRole("status", { name: "Matches" })).toContainText("Matches 2 threads");
  await edit.getByRole("button", { name: "Save rule" }).click();
  await edit.getByRole("button", { name: "Remove the 2" }).click();
  await expect(rules(page).getByRole("status").filter({ hasText: "removed 2 messages" })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveText([/Mail from shop\.example, on the list news\.shop\.example/]);
  expect((await perform(page, { type: "email.list" })).threads.map((t) => t.subject)).toEqual(["Plans"]);

  await list.getByRole("button", { name: "Delete" }).click();
  await expect(list).toHaveCount(0);
  expect(await newsletter(page, "Sale four")).toHaveProperty("kept");
  await page.screenshot({ path: "test-results/email-rules.png" });
});

test("Skip mail like this opens Settings with a rule filled in from the thread: its list, or else its sender", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectEmail(page);
  await newsletter(page, "Sale one");
  await mail(page, { subject: "Raise", text: "No.", from: "Boss <boss@corp.example>", forwards: [], original: "raise@corp.example" });
  const email = (await me(page)).person.email;
  // A reply of the member's own, after the forward, doesn't make it mail like the member's.
  await send(page, [vouched(email.replace(/.*@/, "")), `From: Ada <${email}>`, "To: notes@in.commonink.app", "Subject: Re: Raise", `Message-ID: <${crypto.randomUUID()}@x>`, "In-Reply-To: <raise@corp.example>", "", "Hmm."]);

  await page.goto("/email");
  await threads(page).filter({ hasText: "Sale one" }).getByRole("link").click();
  await page.getByRole("button", { name: "Skip mail like this" }).click();
  await expect(page).toHaveURL(/\/settings\/email$/);
  const form = rules(page).getByRole("form", { name: "New rule" });
  await expect(form.getByRole("textbox", { name: "Mailing list" })).toHaveValue("news.shop.example");
  await expect(form.getByRole("textbox", { name: "From" })).toHaveValue("");
  await expect(form.getByRole("status", { name: "Matches" })).toContainText("Matches 1 thread");
  await form.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/email");
  await threads(page).filter({ hasText: "Raise" }).getByRole("link").click();
  await page.getByRole("button", { name: "Skip mail like this" }).click();
  await expect(rules(page).getByRole("form", { name: "New rule" }).getByRole("textbox", { name: "From" })).toHaveValue("boss@corp.example");

  // Mail of the member's own is never offered: a rule from their own address would drop all they send.
  await mail(page, { subject: "Notes to self", text: "Remember the gears." });
  await page.goto("/email");
  await threads(page).filter({ hasText: "Notes to self" }).getByRole("link").click();
  await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip mail like this" })).toHaveCount(0);
});
