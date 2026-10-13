import { expect, type Frame, type Page } from "@playwright/test";
import type { Capability } from "../../src/core/plugins.ts";
import { perform } from "./helpers.ts";

export interface Written {
  name: string;
  version?: string;
  description?: string;
  capabilities?: { name: Capability; reason: string; origins?: string[] }[];
  commands?: { id: string; title: string }[];
  views?: { slot: "inspector" | "page"; id: string; label: string }[];
  embeds?: { name: string; title: string; height?: number }[];
  settings?: Record<string, unknown>;
}

/** Installs a plugin as the admin on `page` through the API, and allows what is named. Its id in the workspace is the answer. */
export async function install(page: Page, manifest: Written, code: string, allow: Capability[] = []): Promise<string> {
  const { id, plugins } = await perform(page, { type: "plugin.install", manifest: JSON.stringify(manifest), code });
  const codeHash = plugins.find((p) => p.id === id)!.codeHash!;
  for (const capability of allow) await perform(page, { type: "plugin.permit", id, capability, allowed: true, codeHash });
  return id;
}

/** The name of an installed plugin's code as the record has it now, which allowing it anything has to say. */
export const codeHashOf = async (page: Page, id: string, workspaceId?: string) => (await perform(page, { type: "plugin.list" }, workspaceId)).plugins.find((p) => p.id === id)!.codeHash!;

/** The Plugins page, reached through More in the sidebar, so the app is not loaded again. */
export async function openPlugins(page: Page) {
  const modes = page.getByRole("navigation", { name: "Modes" });
  if (!(await modes.getByRole("link", { name: "Plugins" }).isVisible())) await modes.getByRole("button", { name: "More" }).click();
  await modes.getByRole("link", { name: "Plugins" }).click();
  await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible();
}

/** A plugin's row in the Plugins page's list. */
export const pluginRow = (page: Page, name: string) => page.getByRole("list", { name: "Plugins" }).getByRole("listitem", { name, exact: true });

/** One plugin's details, opened from its row, which is where its permissions are read and decided. */
export async function openDetails(page: Page, name: string) {
  await pluginRow(page, name).getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

/** Performs `op` as the plugin for whoever is on `page`, the way the app does for a plugin's frame. What the server answers, with its status. */
export function asPlugin(page: Page, workspaceId: string, pluginId: string, op: Record<string, unknown>): Promise<{ status: number; body: { error?: string; message?: string } & Record<string, unknown> }> {
  return page.evaluate(
    async ({ workspaceId, pluginId, op }) => {
      const res = await fetch(`/api/workspaces/${workspaceId}/plugins/${pluginId}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
      return { status: res.status, body: await res.json() };
    },
    { workspaceId, pluginId, op },
  );
}

/** Turns an installed plugin on for whoever is on `page`, on the Plugins page, as a member does. */
export async function turnOn(page: Page, name: string, workspaceId?: string) {
  if (!page.url().endsWith("/plugins")) await page.goto("/plugins");
  await pluginRow(page, name).getByRole("checkbox", { name, exact: true }).check();
  await expect(pluginRow(page, name).getByRole("checkbox", { name, exact: true })).toBeChecked();
  // The choice is the member's setting, and has reached the server before the test goes on to another address.
  const id = (await perform(page, { type: "plugin.list" }, workspaceId)).plugins.find((p) => p.manifest.name === name)!.id;
  await expect.poll(async () => (JSON.parse((await perform(page, { type: "settings.read" }, workspaceId)).text || "{}") as Record<string, unknown>)[`${id}.enabled`]).toBe(true);
}

/** Has the app read the workspace's record of its plugins again now, as it does when its window is come back to. */
export const relist = (page: Page) => page.evaluate(() => void window.dispatchEvent(new Event("focus")));

/** The documents plugins are running as, which have no address. */
export const running = (page: Page) => page.frames().filter((f) => f.url() === "about:srcdoc");

/** The frame a plugin is running in for one context, once it has started. */
export async function frameFor(page: Page, kind: "background" | "view" | "embed", which?: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of running(page)) {
          const context = await frame.evaluate(() => (window as unknown as { ink?: { context: { kind: string; id?: string; name?: string } | null } }).ink?.context ?? null).catch(() => null);
          if (context?.kind === kind && (which === undefined || context.id === which || context.name === which)) found = frame;
        }
        return found !== undefined;
      },
      { message: `a ${kind} frame${which ? ` for ${which}` : ""} is running` },
    )
    .toBe(true);
  return found!;
}

export async function runCommand(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(title);
  await expect(page.getByRole("option", { name: title })).toBeVisible();
  await page.keyboard.press("Enter");
}

export const toast = (page: Page) => page.getByRole("group", { name: "Notice" });
