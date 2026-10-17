import { expect, type Locator, type Page } from "@playwright/test";

/** Settings, drawn as a dialog over whatever the window shows. Everything of Settings is found inside it. */
export const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });

/** What Settings says of saving: its own status, not the one of whatever is under it. */
export const saveState = (page: Page) => settingsDialog(page).getByRole("status");

/** Closes Settings with its button, and waits for the window under it to be back at an address outside /settings. */
export async function closeSettings(page: Page) {
  await settingsDialog(page).getByRole("button", { name: "Close settings" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/settings(\/|$)/);
}

/** The settings of one category, as Settings is showing them. */
export const group = (page: Page, name: string) => settingsDialog(page).getByRole("region", { name, exact: true });

/** Opens one category from the list beside the settings, and answers its settings. */
export async function category(page: Page, name: string): Promise<Locator> {
  await settingsDialog(page).getByRole("navigation", { name: "Categories" }).getByRole("link", { name, exact: true }).click();
  await expect(group(page, name)).toBeVisible();
  return group(page, name);
}

export const json = (page: Page) => settingsDialog(page).getByRole("textbox", { name: "Settings JSON" });

/** Shows the settings as JSON, from the options. */
export const openJson = (page: Page) => settingsDialog(page).getByRole("button", { name: "Open settings (JSON)" }).click();

/** Shows the settings as options again, from the JSON. */
export const openOptions = (page: Page) => settingsDialog(page).getByRole("button", { name: "Open settings (UI)" }).click();

/** Replaces the whole of the JSON, as a member who selects all and types would. */
export async function typeJson(page: Page, text: string) {
  if (!(await json(page).isVisible())) await openJson(page);
  await json(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

/** Turns a plugin on or off where that is done: on the Plugins page. The page is left there. */
export async function setPlugin(page: Page, name: string, on: boolean) {
  await page.goto("/plugins");
  await page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name, exact: true }).setChecked(on);
}
