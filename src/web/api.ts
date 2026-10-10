import type { Me, OpErrorCode, OpInput, Results } from "../core/protocol.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: OpErrorCode | "signed_out" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

const KEEPALIVE_LIMIT = 60_000;

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
    keepalive: body.length < KEEPALIVE_LIMIT,
  });
}

export const signOut = () => fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
