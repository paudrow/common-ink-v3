import type { Page } from "@playwright/test";
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

/** Connects an agent for the signed-in person, and returns a way to call its MCP tools as it. */
export async function connectAgent(page: Page, name: string) {
  const { agent, token } = await page.evaluate(async (agentName) => {
    const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: agentName }) });
    return (await res.json()) as { agent: { id: string }; token: string };
  }, name);
  const tool = async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
    const res = await page.request.post("/mcp", {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } },
    });
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as T;
  };
  return { id: agent.id, tool };
}
