import { test as base, expect, type Frame, type Locator, type Page, type Request } from "@playwright/test";
import type { Me, OpInput, Results, Role } from "../../src/core/protocol.ts";

/** Playwright's `test`, which closes at the end of each test every browser context it opened beside its own: another person's, a visitor's. */
export const test = base.extend<{ closesContexts: void }>({
  closesContexts: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts());
      await use();
      await Promise.all(browser.contexts().filter((context) => !before.has(context)).map((context) => context.close()));
    },
    { auto: true },
  ],
});

/** Signs in without Google, which only this machine and Previews allow (`devSignIn` in src/worker/auth.ts). `next` is where the app opens. */
export async function signInAs(page: Page, email: string, name: string, next = "/") {
  await page.goto(`/auth/dev?${new URLSearchParams({ email, name, next })}`);
}

/**
 * Whether a todo's row is selected as vim's j and k select one: the row itself has the keyboard, not
 * its checkbox, and it is outlined.
 */
export async function expectRowSelected(row: Locator) {
  await expect.poll(() => row.evaluate((li) => document.activeElement === li), "the row has the keyboard").toBe(true);
  expect(await row.evaluate((li) => [getComputedStyle(li).outlineStyle, getComputedStyle(li).outlineWidth, getComputedStyle(li).outlineOffset]), "the row is outlined").toEqual(["solid", "2px", "-2px"]);
}

export const newEmail = () => `browser-${crypto.randomUUID()}@example.com`;

/** Google sign-in, as a signed-out person is offered it: the app's sign-in page has one, and the landing page at `/` several. */
export const signInLink = (page: Page) => page.getByRole("link", { name: "Sign in with Google" }).first();

export async function signInAsNewPerson(page: Page, name: string) {
  await signInAs(page, newEmail(), name);
}

export const me = (page: Page) => page.evaluate(async () => (await (await fetch("/api/me")).json()) as Me);

/** Performs `op` as the signed-in person, the way another tab or agent would, in their first workspace unless one is named. */
export function perform<T extends OpInput>(page: Page, op: T, workspaceId?: string): Promise<Results[T["type"]]> {
  return page.evaluate(
    async ({ body, workspaceId }) => {
      const id = workspaceId ?? ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { body: op as OpInput, workspaceId },
  ) as Promise<Results[T["type"]]>;
}

/** What the built Worker answers for a request it dropped: a 500 whose body is miniflare's own words, not the Worker's JSON. */
export const DROPPED = { status: 500, contentType: "text/plain", body: "Error: Network connection lost." };

/**
 * Answers the first `times` operations of `type` the page sends as `DROPPED`. The rest go through. `dropped` counts those answered so.
 * `handled` resolves once the page has had the last of those answers and drawn two frames since, so what it made of them is on the page.
 */
export async function dropFirst(page: Page, type: string, times = 1) {
  const answers = new Set<Request>();
  let had!: () => void;
  const answered = new Promise<void>((resolve) => (had = resolve));
  page.on("requestfinished", (request) => {
    if (answers.delete(request) && !answers.size && sent.dropped >= times) had();
  });
  const sent = {
    dropped: 0,
    handled: async () => {
      await answered;
      await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
    },
  };
  await page.route("**/api/workspaces/*/ops", (route) => {
    if (sent.dropped >= times || (route.request().postDataJSON() as { type?: string }).type !== type) return route.fallback();
    sent.dropped++;
    answers.add(route.request());
    return route.fulfill(DROPPED);
  });
  return sent;
}

/** A new person signed in in a browser of their own, beside whoever `page` is. */
export async function anotherPerson(page: Page, name: string): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  const theirs = await context.newPage();
  await signInAsNewPerson(theirs, name);
  return theirs;
}

/**
 * Makes the person signed in on `page` a member of `admin`'s first workspace with `role`, the way
 * anyone becomes one: the admin invites their email, and they open Common Ink.
 */
export async function join(page: Page, admin: Page, role: Role): Promise<{ workspaceId: string; inviteId: string }> {
  const workspaceId = (await me(admin)).workspaces[0]!.id;
  const { invite } = await perform(admin, { type: "member.invite", email: (await me(page)).person.email, as: role });
  // They have an account already, so the invite waits for them to join, which they do from Common Ink's own page.
  const joined = await page.evaluate(async (id) => (await fetch(`/api/invites/${id}`, { method: "POST" })).status, invite!.id);
  expect(joined).toBe(200);
  return { workspaceId, inviteId: invite!.id };
}

/**
 * Signs `page` in as a new person who is a viewer of another new person's workspace, with a note there
 * that its admin wrote. `admin` is that person, in a browser of their own.
 */
export async function asViewerOfNote(page: Page, text: string, name = "Vera Viewer") {
  await signInAsNewPerson(page, name);
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "viewer");
  const note = await perform(admin, { type: "note.create", text });
  return { note, admin, workspaceId };
}

/** A browser with no cookies at all, as someone who was only sent a link has. */
export async function visitor(page: Page): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  return context.newPage();
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

/** The token a new agent's setup shows once, under "Set it up by hand". */
export async function shownToken(shown: Locator) {
  await shown.getByText("Set it up by hand").click();
  return shown.getByRole("textbox", { name: "Token" }).inputValue();
}

/** Connects an agent for the signed-in person, and returns a way to call its MCP tools as it. */
export async function connectAgent(page: Page, name: string) {
  const { agent, token } = await page.evaluate(async (agentName) => {
    const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: agentName }) });
    return (await res.json()) as { agent: { id: string }; token: string };
  }, name);
  return { id: agent.id, ...agentWith(page, token) };
}

/** The folder tree's row for a folder, or for one of the lists that stand beside the folders: "All notes", "Shared with me". */
export const folderRow = (page: Page, name: string) => page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name, exact: true });

/** Opens a folder's list from the tree, with a click or, to keep its tab, a double click. */
export async function openFolder(page: Page, name: string, how: "click" | "dblclick" = "click") {
  await folderRow(page, name)[how]();
}

/** Opens the list of every note in a tab, which is where a note is found by its title. A second call comes back to it from a note opened since. */
export const openAllNotes = (page: Page) => folderRow(page, "All notes").click();

/** The names of the cards in the folder's list that is showing, in order. A card has no title row; its name is there for a screen reader, and `editOf` is the way in. */
export const listedNotes = (page: Page) => page.getByRole("navigation", { name: "Notes" }).locator(".card-title");

/** A note's title in the folder's list that is showing. */
export const listedNote = (page: Page, title: string) => listedNotes(page).filter({ hasText: new RegExp(`^${title}$`) });

/** A note's card in the folder's list that is showing: its title, its note drawn to be read, and its buttons. */
export const noteCard = (page: Page, title: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: title, exact: true });

/** The Edit link of a note's card, which opens the note as a click on its title once did. */
export const editOf = (page: Page, title: string) => noteCard(page, title).getByRole("link", { name: "Edit" });

/**
 * Opens a note from the folder's list that is showing in a tab of its own that is kept, and comes to it,
 * leaving the list's tab where it is: Edit with a modifier opens the note behind the list, and a click on its tab brings it in front.
 */
export async function openKept(page: Page, title: string) {
  const card = noteCard(page, title);
  await card.getByRole("link", { name: "Edit" }).click({ modifiers: ["ControlOrMeta"] });
  await card.locator("xpath=ancestor::section[@data-region][1]").getByRole("tab", { name: title, exact: true }).click();
}

/** Whether a frame is one of Common Ink's own plugins', which run shut off as a workspace's do and are no part of what a test installs. */
export const ownFrame = (frame: Frame) => [frame, frame.parentFrame()].some((f) => f?.name() === "ink-own-plugin");

/** What one of Common Ink's own plugins has drawn in its frame, by the name of the view it is in. */
export const ownPlugin = (page: Page, view: string) => page.locator(`.plugin-frame[aria-label="${view}"] > iframe`).contentFrame().locator("iframe").contentFrame();

/** Every frame in the page but those of Common Ink's own plugins: the frames of what a note embeds and a workspace installs. */
export const THEIR_FRAMES = 'iframe:not([name="ink-own-plugin"])';

/** Runs a command by its title from the command palette, with the keyboard alone. */
export async function runCommand(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill(title);
  await expect(palette.getByRole("option").first()).toHaveText(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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
