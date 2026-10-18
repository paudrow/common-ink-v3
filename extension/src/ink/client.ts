import { noteSlug } from "../../../src/core/slug.ts";
import type { Folder, FolderList, Workspace } from "../clip/folders.ts";
import type { PlacedUpload } from "../clip/types.ts";

export class InkError extends Error {
  readonly name = "InkError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceList {
  person: { id: string; name: string };
  workspaces: readonly Workspace[];
  readOnly: boolean;
  folderIds: readonly string[] | null;
}

export interface NewNote {
  workspaceId: string;
  folderId: string;
  text: string;
  writeId: string;
}

export interface CreatedNote {
  id: string;
  slug: string;
  title: string;
  folderId: string;
}

export interface Ink {
  listWorkspaces(): Promise<WorkspaceList>;
  listFolders(workspaceId: string): Promise<FolderList>;
  createNote(input: NewNote): Promise<CreatedNote>;
  uploadImage(input: { workspaceId: string; folderId: string; name: string; bytes: Uint8Array }): Promise<PlacedUpload>;
  uploadFile(input: { workspaceId: string; folderId: string; name: string; bytes: Uint8Array }): Promise<{ id: string }>;
}

export function createInk(auth: { token: string; host: string }, fetchImpl: typeof fetch = fetch): Ink {
  const origin = originOf(auth.host);
  let id = 0;

  async function request(url: string, init: RequestInit): Promise<Response> {
    if (new URL(url).origin !== origin) throw new InkError("invalid", "Refusing to send the token to another host.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${auth.token}`);
    const response = await fetchImpl(url, { ...init, headers });
    if (response.status === 401) throw new InkError("unauthorized", "That sign-in was refused. Sign in again.");
    return response;
  }

  async function tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await request(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await response.json().catch(() => null)) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } | null;
    const result = body?.result;
    if (!result) throw new InkError("invalid", body?.error?.message || "Common Ink did not answer.");
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) {
      const match = /^([a-z_]+): ([\s\S]*)$/.exec(text);
      throw new InkError(match?.[1] ?? "invalid", match?.[2] ?? text);
    }
    return JSON.parse(text) as unknown;
  }

  return {
    async listWorkspaces() {
      const value = (await tool("list_workspaces", {})) as Partial<WorkspaceList> | null;
      const workspaces = Array.isArray(value?.workspaces) ? value.workspaces.filter(isWorkspace) : [];
      return {
        person: { id: value?.person?.id ?? "", name: value?.person?.name ?? "" },
        workspaces,
        readOnly: value?.readOnly === true,
        folderIds: Array.isArray(value?.folderIds) ? value.folderIds.filter((item) => typeof item === "string") : null,
      };
    },
    async listFolders(workspaceId) {
      const value = (await tool("list_folders", { workspaceId })) as { unsortedId?: unknown; folders?: unknown } | null;
      const folders = Array.isArray(value?.folders) ? value.folders.filter(isFolder) : [];
      const unsortedId = typeof value?.unsortedId === "string" ? value.unsortedId : null;
      return { unsortedId, folders };
    },
    async createNote(input) {
      const value = (await tool("create_note", {
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        text: input.text,
        linkTitles: "keep",
        mentionNames: "keep",
        writeId: input.writeId,
      })) as { id?: unknown; slug?: unknown; title?: unknown; folderId?: unknown };
      if (typeof value.id !== "string") throw new InkError("invalid", "Common Ink did not return the note.");
      const title = typeof value.title === "string" ? value.title : "";
      return {
        id: value.id,
        slug: typeof value.slug === "string" && value.slug ? value.slug : noteSlug(title),
        title,
        folderId: typeof value.folderId === "string" ? value.folderId : input.folderId,
      };
    },
    async uploadImage(input) {
      const response = await request(`${origin}/api/workspaces/${input.workspaceId}/uploads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: input.name, folderId: input.folderId })),
        },
        body: new Blob([input.bytes.slice()]),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new InkError(body?.error ?? "invalid", body?.message || "The image could not be uploaded.");
      }
      const upload = (await response.json()) as { id?: unknown; kind?: unknown; width?: unknown; height?: unknown };
      if (upload.kind !== "image" || typeof upload.id !== "string") throw new InkError("not-image", "The file was not an image.");
      return { id: upload.id, width: numberOrNull(upload.width), height: numberOrNull(upload.height) };
    },
    async uploadFile(input) {
      const response = await request(`${origin}/api/workspaces/${input.workspaceId}/uploads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: input.name, folderId: input.folderId })),
        },
        body: new Blob([input.bytes.slice()]),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new InkError(body?.error ?? "invalid", body?.message || "The file could not be uploaded.");
      }
      const upload = (await response.json()) as { id?: unknown };
      if (typeof upload.id !== "string") throw new InkError("invalid", "Common Ink did not return the file.");
      return { id: upload.id };
    },
  };
}

function originOf(host: string): string {
  let url: URL;
  try {
    url = new URL(host.includes("://") ? host : `https://${host}`);
  } catch {
    throw new InkError("invalid", "The host must be an http(s) address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InkError("invalid", "The host must be an http(s) address.");
  return url.origin;
}

function isWorkspace(value: unknown): value is Workspace {
  return !!value && typeof value === "object" && typeof (value as Workspace).id === "string" && typeof (value as Workspace).name === "string";
}

function isFolder(value: unknown): value is Folder {
  if (!value || typeof value !== "object") return false;
  const folder = value as Folder;
  return typeof folder.id === "string" && typeof folder.name === "string" && typeof folder.path === "string" && (folder.access === "edit" || folder.access === "view");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}
