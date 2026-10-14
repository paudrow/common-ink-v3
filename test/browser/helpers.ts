import { expect, type Page } from "@playwright/test";
import type { Me, OpInput, Results } from "../../src/core/protocol.ts";

export async function signInAsNewPerson(page: Page, name: string) {
  const email = `browser-${crypto.randomUUID()}@example.com`;
  await page.goto(`/auth/dev?${new URLSearchParams({ email, name })}`);
}

/** Performs `op` in the signed-in person's first workspace, the way another tab or agent would. */
export function perform<T extends OpInput>(page: Page, op: T): Promise<Results[T["type"]]> {
  return page.evaluate(async (body) => {
    const me = (await (await fetch("/api/me")).json()) as Me;
    const res = await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message);
    return json;
  }, op as OpInput) as Promise<Results[T["type"]]>;
}

export const noteIdIn = (page: Page) => /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]!;

/** A way to call the MCP tools as the agent `token` belongs to. `status` is what /mcp answers a call with. */
export function agentWith(page: Page, token: string) {
  const call = (toolName: string, args: Record<string, unknown>) =>
    page.request.post("/mcp", {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } },
    });
  const tool = async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
    const { result } = (await (await call(toolName, args)).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as T;
  };
  return { tool, status: async () => (await call("list_workspaces", {})).status() };
}

/** Connects an agent for the signed-in person, and returns a way to call its MCP tools as it. */
export async function connectAgent(page: Page, name: string) {
  const { agent, token } = await page.evaluate(async (agentName) => {
    const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: agentName }) });
    return (await res.json()) as { agent: { id: string }; token: string };
  }, name);
  return { id: agent.id, ...agentWith(page, token) };
}

/** The folder tree's row for a folder, or for the list that stands beside the folders: "All notes". */
export const folderRow = (page: Page, name: string) => page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name, exact: true });

/** Opens the list of every note in a tab, which is where a note is found by its title. A second call comes back to it from a note opened since. */
export const openAllNotes = (page: Page) => folderRow(page, "All notes").click();

/** The titles in the folder's list that is showing, in order. Clicking one opens its note. */
export const listedNotes = (page: Page) => page.getByRole("navigation", { name: "Notes" }).getByRole("link");

/** A note's title in the folder's list that is showing. */
export const listedNote = (page: Page, title: string) => listedNotes(page).filter({ hasText: new RegExp(`^${title}$`) });

/** A note's card in the folder's list that is showing: its title, its details, and its text once expanded. */
export const noteCard = (page: Page, title: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: title, exact: true });

/** Runs a command by its title from the command palette, with the keyboard alone. */
export async function runCommand(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill(title);
  await expect(palette.getByRole("option").first()).toHaveText(new RegExp(`^${title}`));
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

/** Closes the sidebar to its bar, or opens it, by its command: no button does it. */
export const toggleSidebar = (page: Page) => runCommand(page, "Toggle sidebar");
/** Closes the inspector's panel, or shows the one last used, by its command. */
export const toggleInspector = (page: Page) => runCommand(page, "Toggle inspector");

/** A panel's icon in the inspector's bar, which is always there. */
export const panelIcon = (page: Page, name: string) => page.getByRole("navigation", { name: "Inspector bar" }).getByRole("button", { name, exact: true });

/** Shows a panel of the inspector from its icon, unless it is the one showing: the same icon again would close it. */
export async function showPanel(page: Page, name: string) {
  const icon = panelIcon(page, name);
  if ((await icon.getAttribute("aria-expanded")) !== "true") await icon.click();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
}

/** Shows a panel of the inspector and pins it beside the page, as a member does to keep it there: a first visit has none pinned. */
export async function pinPanel(page: Page, name: string) {
  await showPanel(page, name);
  const pin = page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Pin beside the page" });
  if ((await pin.getAttribute("aria-pressed")) !== "true") await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
}

/** The names of the icons in the inspector's bar, in order: one for each panel, whatever is in front. */
export const panelIcons = (page: Page) => () =>
  page
    .getByRole("navigation", { name: "Inspector bar" })
    .getByRole("button")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));

/** The name of the panel the inspector shows, in the panel's header. */
export const shownPanel = (page: Page) => page.getByRole("complementary", { name: "Inspector" }).locator(".panel-head h2");
