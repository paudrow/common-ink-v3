import type { Agent, AgentEdit, ConnectOptions, Me, OpErrorCode, OpInput, Results } from "../core/protocol.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: OpErrorCode | "signed_out" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

/** Browsers cap a keepalive request body at 64 KiB, counted in bytes. */
const KEEPALIVE_BYTES = 60_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? res.statusText);
  return body as T;
}

export const getMe = () => request<Me>("/api/me");

export function perform<T extends OpInput>(workspaceId: string, op: T): Promise<Results[T["type"]]> {
  const body = JSON.stringify(op);
  return request(`/api/workspaces/${workspaceId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: new TextEncoder().encode(body).byteLength < KEEPALIVE_BYTES,
  });
}

export const listAgents = () => request<{ agents: Agent[] }>("/api/agents").then((r) => r.agents);

/** The token in the answer is the only time it can be seen. */
export const connectAgent = (name: string, options: ConnectOptions) =>
  request<{ agent: Agent; token: string }>("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...options }) });

/** Changes what an agent may do. Its token stays the one it has. */
export const editAgent = (id: string, edit: AgentEdit) =>
  request<{ agent: Agent }>(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit) }).then((r) => r.agent);

export const disconnectAgent = (id: string) => request<unknown>(`/api/agents/${id}`, { method: "DELETE" });

export const signOut = () => fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
