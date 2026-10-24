import { expect, type Page } from "@playwright/test";
import { anotherPerson, join, runCommand, signInAs, signInAsNewPerson, test } from "./helpers.ts";

// On the dev server nothing is counted and no operator's workspace is named, so the Dev User stands for the
// operator and is shown made-up numbers. Anyone else is no operator, whatever they are admin of.

const usagePage = (page: Page) => page.getByRole("region", { name: "Usage" });
const workspaceMenu = async (page: Page) => {
  await page.locator(".workspace-button").click();
  return page.getByRole("menu");
};

test("the Dev User, standing for the operator, opens Usage from the workspace menu and the command palette, drawn in the app", async ({ page }) => {
  await signInAs(page, "dev@common.ink", "Dev User");
  await (await workspaceMenu(page)).getByRole("menuitem", { name: "Usage" }).click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(usagePage(page).getByText("Made-up numbers")).toBeVisible();
  await expect(usagePage(page).getByRole("heading", { name: "Weekly active members" })).toBeVisible();
  // The app's own tabs and sidebar are around it, and its type is the app's.
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: /Usage/ })).toBeVisible();
  await expect(usagePage(page).getByRole("heading", { name: "Usage", level: 1 })).toHaveCSS("font-family", await page.evaluate(() => getComputedStyle(document.body).fontFamily));

  await usagePage(page).getByRole("button", { name: "7 days" }).click();
  await expect(usagePage(page).getByText("sign-ups in 7 days")).toBeVisible();

  await page.goto("/");
  await expect(page.locator(".workspace-button")).toBeVisible();
  await runCommand(page, "Go to Usage");
  await expect(usagePage(page)).toBeVisible();
});

test("anyone else, an admin of their own workspace or an editor in another's, is offered no Usage and is answered nothing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  for (const someone of [page, grace]) {
    await someone.goto("/");
    await expect((await workspaceMenu(someone)).getByRole("menuitem", { name: "Members" })).toBeVisible();
    await expect(someone.getByRole("menuitem", { name: "Usage" })).toHaveCount(0);
    await someone.keyboard.press("Escape");

    await someone.keyboard.press("ControlOrMeta+Shift+P");
    const palette = someone.getByRole("dialog", { name: "Commands" });
    await palette.getByRole("combobox").fill("Go to Usage");
    await expect(palette.getByRole("option", { name: /^Go to Usage/ })).toHaveCount(0);
    await someone.keyboard.press("Escape");

    await someone.goto("/usage");
    await expect(usagePage(someone)).toHaveCount(0);
    expect((await someone.request.get("/api/usage")).status()).toBe(404);
  }
});
