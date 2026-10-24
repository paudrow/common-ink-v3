import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";
import { connectEmail, mail } from "./mail.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  test.setTimeout(60_000);
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const thread = (page: Page, subject: string) => page.getByRole("list", { name: "Threads" }).getByRole("listitem").filter({ hasText: subject }).getByRole("link");
const addSender = (page: Page) => page.getByRole("toolbar", { name: "Thread" }).getByRole("button", { name: "Add sender to contacts" });

test("Add sender to contacts opens the contact editor with the sender's name and address, saves to the member's contacts, and is offered only for someone who isn't one", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectEmail(page);
  await mail(page, { subject: "Films", text: "About the radio.", from: "Hedy Lamarr <hedy@films.example>", forwards: [] });
  await mail(page, { subject: "Compiler", text: "It compiles.", from: "Grace Hopper <grace@example.com>", forwards: [] });
  await mail(page, { subject: "My own", text: "A note to self." });

  // With no contacts connected, there is nowhere to add the sender.
  await page.goto("/email");
  await thread(page, "Films").click();
  await expect(page.getByRole("button", { name: "Skip mail like this" })).toBeVisible();
  await expect(addSender(page)).toHaveCount(0);

  // Contacts connected for reading alone take no new contact either.
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/email" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Skip mail like this" })).toBeVisible();
  await expect(addSender(page)).toHaveCount(0);

  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/email", edit: true });
  await page.reload();
  await expect(addSender(page)).toBeVisible();
  await addSender(page).click();
  const form = page.getByRole("form", { name: "New contact" });
  await expect(form.getByRole("textbox", { name: "Name" })).toHaveValue("Hedy Lamarr");
  await expect(form.getByRole("textbox", { name: "Email 1" })).toHaveValue("hedy@films.example");
  await form.getByRole("textbox", { name: "Organization" }).fill("MGM");
  await page.screenshot({ path: "test-results/email-add-sender.png" });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(addSender(page)).toHaveCount(0);
  const { contacts } = await perform(page, { type: "contact.list", query: "Hedy" });
  expect(contacts.map((c) => [c.sourceId, c.name, c.emails.map((e) => e.value), c.organization])).toEqual([["sample-contacts", "Hedy Lamarr", ["hedy@films.example"], "MGM"]]);

  // Grace is a contact already, and mail of the member's own has no one else to add.
  await thread(page, "Compiler").click();
  await expect(page.getByRole("article", { name: "Compiler" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip mail like this" })).toBeVisible();
  await expect(addSender(page)).toHaveCount(0);
  await thread(page, "My own").click();
  await expect(page.getByRole("article", { name: "My own" })).toBeVisible();
  await expect(addSender(page)).toHaveCount(0);
});
