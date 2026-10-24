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
  await expect(same).toHaveText("Looks like the same person as Ada King. Same email.Not the same person");
  await same.getByRole("button", { name: "Not the same person" }).click();
  await expect(same).toHaveCount(0);
  await page.goto("/person/Ada%20King");
  await expect(page.getByRole("region", { name: "Your contact Ada King" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Looks like the same person" })).toHaveCount(0);
});
