import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, me, newEmail, perform, signInAs, signInLink } from "./helpers.ts";

const account = (page: Page) => page.getByRole("region", { name: "Account" });

async function switchTo(page: Page, workspace: string) {
  await page.locator(".workspace-button").click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${workspace}`) }).click();
  await expect(page.locator(".workspace-button")).toContainText(workspace);
}

test("a member deletes their account from Settings: they are signed out, the workspace they were alone in goes, and what they wrote in a shared one stays under a former member", async ({ page }) => {
  await signInAs(page, newEmail(), "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const note = await perform(grace, { type: "note.create", text: "# Grace's plan" }, workspaceId);
  const email = (await me(grace)).person.email;

  await grace.goto("/settings/account");
  await account(grace).getByRole("button", { name: "Delete account…" }).click();
  const asked = account(grace).getByRole("form", { name: "Delete account" });
  await expect(asked).toContainText("Grace's workspace is deleted with it, since nobody else is in it.");
  const deleteIt = asked.getByRole("button", { name: "Delete my account" });
  await expect(deleteIt).toBeDisabled();
  await asked.getByRole("textbox", { name: `Type ${email} to confirm` }).fill(email);
  await deleteIt.click();

  await expect(signInLink(grace)).toBeVisible();
  expect(await grace.evaluate(async () => (await fetch("/api/me")).status)).toBe(401);
  expect((await perform(page, { type: "note.history", id: note.id }, workspaceId)).map((c) => c.author.name)).toEqual(["A former member"]);
  expect((await perform(page, { type: "member.list" }, workspaceId)).map((m) => m.name)).toEqual(["Ada Lovelace"]);
});

test("the only admin of a workspace others are in is told to hand it on first, and nothing is deleted", async ({ page }) => {
  await signInAs(page, newEmail(), "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");

  await page.goto("/settings/account");
  await account(page).getByRole("button", { name: "Delete account…" }).click();
  await expect(account(page).getByRole("group", { name: "Delete account" })).toContainText("You are the only admin of Ada's workspace, where others are members. Make someone else an admin on Members, or delete the workspace, first.");
  await expect(account(page).getByRole("textbox")).toHaveCount(0);
  expect((await me(page)).workspaces.map((w) => w.name)).toEqual(["Ada's workspace"]);
});

test("an admin deletes a workspace from Settings: its members lose it at once and go on in their own, and an admin with none left gets a new one", async ({ page }) => {
  await signInAs(page, newEmail(), "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  await perform(page, { type: "note.create", text: "# Doomed" }, workspaceId);

  // An editor isn't offered it.
  await grace.reload();
  await switchTo(grace, "Ada's workspace");
  await grace.goto("/settings/account");
  await expect(account(grace).getByRole("button", { name: "Delete account…" })).toBeVisible();
  await expect(account(grace).getByRole("button", { name: "Delete workspace…" })).toHaveCount(0);

  await page.goto("/settings/account");
  await expect(account(page)).toContainText("Deletes Ada's workspace for everyone in it");
  await account(page).getByRole("button", { name: "Delete workspace…" }).click();
  const asked = account(page).getByRole("form", { name: "Delete workspace" });
  await asked.getByRole("textbox", { name: "Type Ada's workspace to confirm" }).fill("Ada's workspace");
  await asked.getByRole("button", { name: "Delete workspace" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".workspace-button")).toContainText("Ada's workspace");
  const now = (await me(page)).workspaces;
  expect(now.map((w) => [w.name, w.role])).toEqual([["Ada's workspace", "admin"]]);
  expect(now[0]!.id).not.toBe(workspaceId);
  expect((await me(grace)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
});
