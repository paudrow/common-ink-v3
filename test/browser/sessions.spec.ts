import { expect, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, join, me, newEmail, signInAs, signInLink, test } from "./helpers.ts";

const whoAmI = (page: Page) => page.evaluate(async () => (await fetch("/api/me")).status);

async function switchTo(page: Page, workspace: string) {
  await page.locator(".workspace-button").click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${workspace}`) }).click();
  await expect(page.locator(".workspace-button")).toContainText(workspace);
}

/** The same person in a browser of their own, signed in apart from `page`. */
async function anotherBrowser(page: Page, email: string, name: string): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  const theirs = await context.newPage();
  await signInAs(theirs, email, name);
  return theirs;
}

test("a member signs out everywhere from Settings, and every browser they were signed in on is signed out, this one too, and their agents are disconnected", async ({ page }) => {
  const email = newEmail();
  await signInAs(page, email, "Ada Lovelace");
  const laptop = await anotherBrowser(page, email, "Ada Lovelace");
  expect((await me(laptop)).person.email).toBe(email);
  const agent = await connectAgent(page, "Claude");
  expect(await agent.status()).toBe(200);

  await page.goto("/settings/account");
  const account = page.getByRole("region", { name: "Account" });
  await expect(account).toContainText(`Signed in as ${email}`);
  await account.getByRole("button", { name: "Sign out everywhere…" }).click();
  const asked = account.getByRole("group", { name: "Sign out everywhere" });
  await expect(asked.getByRole("checkbox", { name: "Also disconnect my agents" })).toBeChecked();
  await asked.getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(signInLink(page)).toBeVisible();
  expect(await agent.status()).toBe(401);
  expect(await whoAmI(laptop)).toBe(401);
  await laptop.reload();
  await expect(signInLink(laptop)).toBeVisible();

  await signInAs(laptop, email, "Ada Lovelace");
  expect((await me(laptop)).person.email).toBe(email);
});

test("an admin signs a member out everywhere from Members, and the member stays in the workspace, with their agents when the admin unticks disconnecting them", async ({ page }) => {
  await signInAs(page, newEmail(), "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  const agent = await connectAgent(grace, "Claude");

  await page.goto("/members");
  const row = page.getByRole("region", { name: "Members" }).getByRole("list", { name: "Members" }).getByRole("listitem", { name: "Grace Hopper" });
  await row.getByRole("button", { name: "Sign out Grace Hopper" }).click();
  const asked = row.getByRole("group", { name: "Sign out Grace Hopper" });
  await expect(asked).toContainText("They stay in");
  const theirAgents = asked.getByRole("checkbox", { name: "Also disconnect their agents" });
  await expect(theirAgents).toBeChecked();
  await theirAgents.uncheck();
  await asked.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page.getByRole("region", { name: "Members" }).getByRole("status")).toHaveText("Grace Hopper is signed out everywhere.");
  await expect(row).toBeVisible();

  expect(await whoAmI(grace)).toBe(401);
  expect(await agent.status()).toBe(200);
  await grace.reload();
  await expect(signInLink(grace)).toBeVisible();
  expect(await whoAmI(page)).toBe(200);
});

test("only an admin is offered signing someone else out", async ({ page }) => {
  await signInAs(page, newEmail(), "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");

  await grace.goto("/");
  await switchTo(grace, "Ada's workspace");
  await grace.goto("/members");
  const members = grace.getByRole("region", { name: "Members" }).getByRole("list", { name: "Members" });
  await expect(members.getByRole("listitem")).toHaveCount(2);
  await expect(members.getByRole("button", { name: /^Sign out/ })).toHaveCount(0);
});
