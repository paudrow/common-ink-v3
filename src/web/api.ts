import { partSpan, partsLeft, planParts } from "../core/parts.ts";
import { tellFault } from "./faults.ts";
import { NO_SUCH_WORKSPACE, type Invitation, type Agent, type ClipperGrantView, type AgentEdit, type ConnectOptions, type MeHere, type OpErrorCode, type OpInput, type Results, type SendingUpload, type Shared, type Upload } from "../core/protocol.ts";
import { forgetAll } from "./stash.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: OpErrorCode | "signed_out" | "unknown",
    message: string,
    /** A fault answered by something other than the Worker, such as Cloudflare's page for a Worker it cut off. The Worker reports its own. */
    readonly cutOff = false,
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
  if (!res.ok) throw new ApiError(res.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? res.statusText, res.status >= 500 && typeof body.error !== "string");
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

/**
 * The workspace at the end of an address, among the member's own. Null only when the server says there
 * is nothing there for them. Anything else it answers, such as signed out or too many requests, throws.
 */
const where = (path: string, init?: RequestInit) =>
  request<{ workspaceId: string }>(path, init).then(
    (found) => found.workspaceId,
    (err) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    },
  );

export const workspaceOfNote = (noteId: string) => where(`/api/notes/${noteId}`);
/** Where an invite's link leads: the workspace once its person has joined, what the invite is while it waits for them, or null for nowhere. */
export const inviteAt = (inviteId: string) =>
  request<{ workspaceId: string } | { invite: Invitation }>(`/api/invites/${inviteId}`).then(
    (found) => ("invite" in found ? found.invite : found.workspaceId),
    (err) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    },
  );

/** Joins the workspace an invite is for, as the person it is for. Null when it no longer waits for them. */
export const joinInvite = (inviteId: string) => where(`/api/invites/${inviteId}`, { method: "POST" });

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
    tellBroken(op.type, err);
  });
  return answer;
}

/** An operation answered with a fault the Worker didn't make is told of, as the page saw it: the Worker can't tell of one Cloudflare cut off. */
const tellBroken = (op: string, err: unknown) => {
  if (err instanceof ApiError && err.cutOff) tellFault({ name: "ApiError", message: err.message, op, status: err.status });
};

/**
 * Performs an operation as a plugin installed in the workspace, for the member. The server lets it do
 * only what the plugin is permitted and records the plugin as the author. A refusal here says nothing
 * of the member's own standing, so nobody listening for those is told.
 */
export function performAsPlugin<T extends OpInput>(workspaceId: string, pluginId: string, op: T, draft = false): Promise<Results[T["type"]]> {
  const answer = request<Results[T["type"]]>(`/api/workspaces/${workspaceId}/plugins/${pluginId}${draft ? "/draft" : ""}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
  answer.catch((err) => tellBroken(op.type, err));
  return answer;
}

/**
 * Loads a full-trust plugin's code as a module from the app's own address, which the page's policy
 * allows where it allows no `eval`. The server answers only code of `hash` that runs for this member.
 */
export const trustedModule = async (workspaceId: string, pluginId: string, hash: string) =>
  ((await import(/* @vite-ignore */ `/api/workspaces/${workspaceId}/plugins/${pluginId}/trusted/${hash}.js`)) as { default: (host: unknown, modules: unknown) => unknown }).default;

/** Where an upload's bytes are asked for by the member's session. */
export const uploadAddress = (workspaceId: string, id: string) => `/api/workspaces/${workspaceId}/uploads/${id}`;

/** Where they are asked for by whoever holds a link, which decides in place of a session. */
export const sharedUploadAddress = (token: string, id: string) => `/api/shared/${token}/uploads/${id}`;

/** A file larger than this goes in parts, which say how far they have got and pick up where they stopped. A smaller one goes in one request. */
export const IN_PARTS_FROM = 8 * 1024 * 1024;
/** How many parts go at once. */
const AT_ONCE = 3;
/** How many rounds in a row may store no part before the file is given up on, and how long the first wait between them is. */
const ROUNDS = 6;
const FIRST_WAIT_MS = 1000;
const UNREACHED = "The file didn't reach Common Ink. Check your connection and try again.";

type SendAs = { name: string; folderId?: string; private?: boolean };

/**
 * Sends a file's bytes to a workspace and says how far they have got: in one request, or, for a file
 * over {@link IN_PARTS_FROM}, in parts. `onStarted` is told of a file sent in parts as soon as it has
 * an id, long before it is there to be seen. The type is never the browser's guess: the server reads it from the bytes.
 */
export function sendUpload(workspaceId: string, file: Blob, as: SendAs, onProgress?: (sent: number) => void, onStarted?: (sending: SendingUpload) => void): Promise<Upload> {
  return file.size > IN_PARTS_FROM ? sendInParts(workspaceId, file, as, onProgress, onStarted) : sendWhole(workspaceId, file, as, onProgress);
}

/** One part, to the address it goes to. The address is all the permission it needs. */
function putPart(address: string, part: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", address);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onerror = xhr.onabort = () => reject(new ApiError(0, "unknown", UNREACHED));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { error?: string; message?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? UNREACHED));
    };
    xhr.send(part);
  });
}

/** Waits `ms`, and for as long as the browser is offline, so a laptop closed half way carries on once it is open and connected again. */
const waitToRetry = (ms: number) =>
  new Promise<void>((done) => {
    const ready = () => (navigator.onLine ? done() : window.addEventListener("online", () => done(), { once: true }));
    setTimeout(ready, ms);
  });

/**
 * Sends a file in parts, several at once. A part that fails is sent again to a fresh address, and the
 * parts already stored are never sent twice, so a dropped connection picks up where it stopped. A
 * round in which nothing was stored waits longer each time, and after {@link ROUNDS} of them the file
 * is given up on and what was sent of it thrown away. A refusal that no retry changes stops it at once.
 */
async function sendInParts(workspaceId: string, file: Blob, as: SendAs, onProgress?: (sent: number) => void, onStarted?: (sending: SendingUpload) => void): Promise<Upload> {
  let sending = await perform(workspaceId, { type: "upload.start", name: as.name, size: file.size, ...(as.folderId ? { folderId: as.folderId } : {}), private: as.private ?? false });
  onStarted?.(sending);
  const plan = planParts(sending.size, sending.partSize);
  const going = new Map<number, number>();
  const tell = (stored: ReadonlySet<number>) => onProgress?.([...stored].reduce((sum, n) => sum + partSpan(plan, n)!.length, 0) + [...going.values()].reduce((sum, n) => sum + n, 0));
  try {
    for (let quiet = 0; ; ) {
      const stored = new Set(sending.stored);
      const left = partsLeft(plan, stored);
      const before = stored.size;
      let failed: unknown = null;
      const next = async (): Promise<void> => {
        const number = left.shift();
        if (number === undefined) return;
        const { offset, length } = partSpan(plan, number)!;
        try {
          await putPart(sending.address.replace("{part}", String(number)), file.slice(offset, offset + length), (sent) => {
            going.set(number, sent);
            tell(stored);
          });
          stored.add(number);
        } catch (err) {
          failed = err;
          // Refused for who is asking, or for an upload or folder no longer there: no retry changes that.
          if (final(err)) throw err;
        } finally {
          going.delete(number);
          tell(stored);
        }
        return next();
      };
      await Promise.all(Array.from({ length: AT_ONCE }, next));
      if (stored.size === plan.count) break;
      quiet = stored.size > before ? 0 : quiet + 1;
      if (quiet >= ROUNDS) throw failed ?? new ApiError(0, "unknown", UNREACHED);
      await waitToRetry(FIRST_WAIT_MS * 2 ** quiet);
      sending = await perform(workspaceId, { type: "upload.resume", id: sending.id });
    }
    return await perform(workspaceId, { type: "upload.finish", id: sending.id });
  } catch (err) {
    void perform(workspaceId, { type: "upload.abort", id: sending.id }).catch(() => {});
    throw err;
  }
}

/** A part refused for good: for who is asking (403), or for an upload or a folder that is gone (404). A lapsed or spent address (410, 409), a broken connection and a fault are retried. */
const final = (err: unknown) => err instanceof ApiError && (err.status === 403 || err.status === 404);

function sendWhole(workspaceId: string, file: Blob, as: SendAs, onProgress?: (sent: number) => void): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/workspaces/${workspaceId}/uploads`);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Ink-Upload", encodeURIComponent(JSON.stringify(as)));
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onerror = xhr.onabort = () => reject(new ApiError(0, "unknown", UNREACHED));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { error?: string; message?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Upload);
      else reject(new ApiError(xhr.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? (xhr.statusText || "The file couldn't be uploaded.")));
    };
    xhr.send(file);
  });
}

/** The first `upTo` bytes of an upload, from the address its bytes are asked for, which answers as it answers a picture: by the session, through the same check. */
export async function readUpload(address: string, upTo: number): Promise<Uint8Array> {
  const res = await fetch(address, { headers: { Range: `bytes=0-${upTo - 1}` }, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, (body.error as ApiError["code"]) ?? "unknown", body.message ?? "The file couldn't be read.");
  }
  return new Uint8Array(await res.arrayBuffer()).subarray(0, upTo);
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

/** The member's own clipper sign-ins that still work. */
export const listClipperGrants = () => request<{ grants: ClipperGrantView[] }>("/api/clipper").then((r) => r.grants);
export const revokeClipperGrant = (id: string) => request<unknown>(`/api/clipper/${id}`, { method: "DELETE" });

export function signOut() {
  forgetAll();
  return fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
}
