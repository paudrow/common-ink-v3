import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const duplicates = (page: Page) => page.getByRole("region", { name: "Possible duplicates" });

/** Grace, with the sample contacts connected to edit, and Ada Lovelace in them twice: once under her married name, by the same email. */
async function twice(page: Page) {
  await signInAsNewPerson(page, "Grace Hopper");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts", edit: true });
  await perform(page, { type: "contact.create", sourceId: "sample-contacts", name: "Ada King", emails: [{ value: "ADA@example.com", type: "home" }], phones: [{ value: "+44 20 7946 0000", type: "home" }] });
}

test("the Contacts page lists contacts that look like one person, and a pair said not to be is gone for good", async ({ page }) => {
  await twice(page);
  await page.goto("/contacts");
  const pair = duplicates(page).getByRole("listitem", { name: "Ada King and Ada Lovelace" });
  await expect(duplicates(page).getByRole("listitem")).toHaveCount(1);
  await expect(pair).toContainText("Same email");
  await pair.getByRole("link", { name: "Ada King" }).click();
  await expect(page).toHaveURL(/\/person\/Ada%20King$/);
  await page.goBack();

  await pair.getByRole("button", { name: "Not the same person" }).click();
  await expect(duplicates(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("list", { name: "Contacts" }).getByRole("listitem")).toHaveCount(6);
  await expect(duplicates(page)).toHaveCount(0);
});

test("a contact's page says who else looks like the same person, and can be told they are not", async ({ page }) => {
  await twice(page);
  await page.goto("/person/Ada%20Lovelace");
  const same = page.getByRole("list", { name: "Looks like the same person" });
  await expect(same).toHaveText("Looks like the same person as Ada King. Same email.Merge…Not the same person");
  await same.getByRole("button", { name: "Not the same person" }).click();
  await expect(same).toHaveCount(0);
  await page.goto("/person/Ada%20King");
  await expect(page.getByRole("region", { name: "Your contact Ada King" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Looks like the same person" })).toHaveCount(0);
});

test("merging shows the contact both make before anything changes, keeps the main one with every line of both, and Restore brings the other back", async ({ page }) => {
  await twice(page);
  await page.goto("/contacts");
  const pair = duplicates(page).getByRole("listitem", { name: "Ada King and Ada Lovelace" });
  await pair.getByRole("button", { name: "Merge…" }).click();
  const merge = pair.getByRole("region", { name: "Merge Ada King and Ada Lovelace" });
  // The one that holds more is offered as the main contact.
  await expect(merge.getByRole("radio", { name: "Ada Lovelace" })).toBeChecked();
  await expect(merge.getByLabel("Merged contact").locator(".person-field")).toHaveText(["NameAda Lovelace", "Work emailada@example.com", "Mobile+1 555 0100", "Home phone+44 20 7946 0000", "WorkAnalyst, Analytical Engines", "Birthday10 December 1815"]);
  await expect(merge).toContainText("Ada King is deleted from Sample contacts");
  await merge.getByRole("radio", { name: "Ada King" }).click();
  await expect(merge.getByLabel("Merged contact").locator(".person-field").first()).toHaveText("NameAda King");
  await merge.getByRole("button", { name: "Cancel" }).click();
  await expect(merge).toHaveCount(0);
  expect((await perform(page, { type: "contact.list" })).contacts).toHaveLength(6);

  await pair.getByRole("button", { name: "Merge…" }).click();
  await merge.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Merged Ada King into Ada Lovelace." })).toBeVisible();
  await expect(duplicates(page)).toHaveCount(0);
  const cards = page.getByRole("list", { name: "Contacts" }).getByRole("listitem");
  await expect(cards).toHaveCount(5);
  await expect(cards.filter({ hasText: "Ada Lovelace" })).toContainText("+44 20 7946 0000");

  // A mention of the merged name finds the contact it was merged into.
  await page.goto("/person/Ada%20King");
  await expect(page.getByRole("region", { name: "Your contact Ada Lovelace" })).toContainText("Ada Lovelace, from your contacts. Only you see this.");

  await page.goto("/contacts");
  const recent = page.getByRole("region", { name: "Recently merged" });
  await expect(recent.getByRole("listitem")).toHaveText([/^Ada King, merged into Ada LovelaceCan be restored until /]);
  await recent.getByRole("button", { name: "Restore Ada King" }).click();
  await expect(recent).toHaveCount(0);
  await expect(cards).toHaveCount(6);
  await page.goto("/person/Ada%20King");
  await expect(page.getByRole("region", { name: "Your contact Ada King" })).toContainText("+44 20 7946 0000");
  await expect(page.getByRole("region", { name: "Your contact Ada Lovelace" })).toHaveCount(0);
});

test("a contact's page merges the other into it, and says so with a Restore", async ({ page }) => {
  await twice(page);
  await page.goto("/person/Ada%20King");
  const same = page.getByRole("list", { name: "Looks like the same person" });
  await same.getByRole("button", { name: "Merge…" }).click();
  // On a contact's page, that contact is offered as the main one.
  await expect(same.getByRole("radio", { name: "Ada King" })).toBeChecked();
  await same.getByRole("button", { name: "Merge", exact: true }).click();
  const said = page.getByRole("status").filter({ hasText: "Merged Ada Lovelace into Ada King." });
  await expect(said).toBeVisible();
  await expect(same).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your contact Ada King" }).locator(".person-field")).toHaveText(["Home emailADA@example.com", "Home phone+44 20 7946 0000", "Mobile+1 555 0100", "WorkAnalyst, Analytical Engines", "Birthday10 December 1815"]);
  await said.getByRole("button", { name: "Restore Ada Lovelace" }).click();
  await expect(said).toHaveCount(0);
  await page.goto("/person/Ada%20Lovelace");
  await expect(page.getByRole("region", { name: "Your contact Ada Lovelace" })).toContainText("Analytical Engines");
});
