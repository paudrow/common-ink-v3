import { NO_SUCH_WORKSPACE, type Agent, type AgentEdit, type ConnectOptions, type MeHere, type OpErrorCode, type OpInput, type Results, type Shared } from "../core/protocol.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: OpErrorCode | "signed_out" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

const sessionListeners = new Set<() => void>();
let signedOut = false;
const sessionIs = (out: boolean) => {
  if (out === signedOut) return;
  signedOut = out;
  for (const listener of [...sessionListeners]) listener();
};

/**
 * Whether the server last said this browser is signed out, as it does once a session ends under an
 * open page. Nothing is worth sending again until it is false, which any answered request makes it.
 */
export const session = {
  subscribe(listener: () => void) {
    sessionListeners.add(listener);
    return () => void sessionListeners.delete(listener);
  },
  signedOut: () => signedOut,
};

/** Browsers cap a keepalive request body at 64 KiB, counted in bytes. */
const KEEPALIVE_BYTES = 60_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  // A refusal is an answer to whoever is signed in, as much as a result is. A fault says nothing either way.
  if (res.status === 401) sessionIs(true);
  else if (res.status < 500) sessionIs(false);
  if (!res.ok) throw new ApiError(res.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? res.statusText);
  return body as T;
}

export const getMe = () => request<MeHere>("/api/me");

const refused = new Set<() => void>();

/**
 * Calls `listener` when an operation is refused for who the member is: their role doesn't allow it,
 * or they aren't in the workspace. Either may be news, such as a role an admin changed a moment ago.
 */
export function onRefused(listener: () => void): () => void {
  refused.add(listener);
  return () => void refused.delete(listener);
}

/** The workspace at the end of an address, among the member's own. Null when there is nothing there for them. */
const where = (path: string) =>
  request<{ workspaceId: string }>(path).then(
    (found) => found.workspaceId,
    (err) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    },
  );

export const workspaceOfNote = (noteId: string) => where(`/api/notes/${noteId}`);
export const workspaceOfInvite = (inviteId: string) => where(`/api/invites/${inviteId}`);

export function perform<T extends OpInput>(workspaceId: string, op: T): Promise<Results[T["type"]]> {
  const body = JSON.stringify(op);
  const answer = request<Results[T["type"]]>(`/api/workspaces/${workspaceId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: new TextEncoder().encode(body).byteLength < KEEPALIVE_BYTES,
  });
  answer.catch((err) => {
    if (err instanceof ApiError && (err.code === "forbidden" || err.message === NO_SUCH_WORKSPACE)) for (const listener of [...refused]) listener();
  });
  return answer;
}

/** What a link opens, asked as whoever holds it. Neither asks who that is unless the link is for people signed in. */
export const openShared = (token: string) => request<Shared>(`/api/shared/${token}`);
export const readShared = (token: string, noteId: string) => request<Results["shared.read"]>(`/api/shared/${token}/notes/${noteId}`);

export const listAgents = () => request<{ agents: Agent[] }>("/api/agents").then((r) => r.agents);

/** The token in the answer is the only time it can be seen. */
export const connectAgent = (name: string, options: ConnectOptions) =>
  request<{ agent: Agent; token: string }>("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...options }) });

/** Changes what an agent may do. Its token stays the one it has. */
export const editAgent = (id: string, edit: AgentEdit) =>
  request<{ agent: Agent }>(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit) }).then((r) => r.agent);

export const disconnectAgent = (id: string) => request<unknown>(`/api/agents/${id}`, { method: "DELETE" });

export const signOut = () => fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
