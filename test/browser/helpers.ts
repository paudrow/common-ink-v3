import { test, type Frame, type Page } from "@playwright/test";
import type { Me, OpInput, Results, Role } from "../../src/core/protocol.ts";

/** Signs in without Google, which only this machine and Previews allow (`devSignIn` in src/worker/auth.ts). `next` is where the app opens. */
export async function signInAs(page: Page, email: string, name: string, next = "/") {
  await page.goto(`/auth/dev?${new URLSearchParams({ email, name, next })}`);
}

export const newEmail = () => `browser-${crypto.randomUUID()}@example.com`;

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
  await me(page);
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

/** Opens the list of every note in a tab, which is where a note is found by its title. A second call comes back to it from a note opened since. */
export const openAllNotes = (page: Page) => folderRow(page, "All notes").click();

/** The titles in the folder's list that is showing, in order. Clicking one opens its note. */
export const listedNotes = (page: Page) => page.getByRole("navigation", { name: "Notes" }).getByRole("link");

/** A note's title in the folder's list that is showing. */
export const listedNote = (page: Page, title: string) => listedNotes(page).filter({ hasText: new RegExp(`^${title}$`) });

/** A note's card in the folder's list that is showing: its title, its details, and its text once expanded. */
export const noteCard = (page: Page, title: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: title, exact: true });

/** Whether a frame is one of Common Ink's own plugins', which run shut off as a workspace's do and are no part of what a test installs. */
export const ownFrame = (frame: Frame) => [frame, frame.parentFrame()].some((f) => f?.name() === "ink-own-plugin");

/** What one of Common Ink's own plugins has drawn in its frame, by the name of the view it is in. */
export const ownPlugin = (page: Page, view: string) => page.locator(`.plugin-frame[aria-label="${view}"] > iframe`).contentFrame().locator("iframe").contentFrame();

/** Every frame in the page but those of Common Ink's own plugins: the frames of what a note embeds and a workspace installs. */
export const THEIR_FRAMES = 'iframe:not([name="ink-own-plugin"])';
