import { expect, type Page } from "@playwright/test";

/** The Plugins page, reached through More in the sidebar, so the app is not loaded again. */
export async function openPlugins(page: Page) {
  const modes = page.getByRole("navigation", { name: "Modes" });
  if (!(await modes.getByRole("link", { name: "Plugins" }).isVisible())) await modes.getByRole("button", { name: "More" }).click();
  await modes.getByRole("link", { name: "Plugins" }).click();
  await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible();
}

/** A plugin's row in the Plugins page's list. */
export const pluginRow = (page: Page, name: string) => page.getByRole("list", { name: "Plugins" }).getByRole("listitem", { name, exact: true });

/** One plugin's details, opened from its row. */
export async function openDetails(page: Page, name: string) {
  await pluginRow(page, name).getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}
