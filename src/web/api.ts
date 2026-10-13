import { NO_SUCH_WORKSPACE, type Agent, type AgentEdit, type ConnectOptions, type Me, type OpErrorCode, type OpInput, type Results, type Shared, type Upload } from "../core/protocol.ts";

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

/** Where an upload's bytes are asked for by the member's session. */
export const uploadAddress = (workspaceId: string, id: string) => `/api/workspaces/${workspaceId}/uploads/${id}`;

/** Where they are asked for by whoever holds a link, which decides in place of a session. */
export const sharedUploadAddress = (token: string, id: string) => `/api/shared/${token}/uploads/${id}`;

/**
 * Sends a file's bytes to a workspace, as the body of one request that says how far it has got.
 * The file is named in a header, and the type is never the browser's guess: the server reads it from the bytes.
 */
export function sendUpload(workspaceId: string, file: Blob, as: { name: string; folderId?: string; private?: boolean }, onProgress?: (sent: number) => void): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/workspaces/${workspaceId}/uploads`);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Ink-Upload", encodeURIComponent(JSON.stringify(as)));
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onerror = xhr.onabort = () => reject(new ApiError(0, "unknown", "The file didn't reach Common Ink. Check your connection and try again."));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { error?: string; message?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Upload);
      else reject(new ApiError(xhr.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? (xhr.statusText || "The file couldn't be uploaded.")));
    };
    xhr.send(file);
  });
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
