import { blockImages, clipToMarkdown } from "./clip/render.ts";
import { defaultFolder, defaultWorkspace, type FolderList, type Workspace } from "./clip/folders.ts";
import { fetchImage, imageBox, inlineBytes, placeId, planImage } from "./clip/images.ts";
import { noteUrl } from "./clip/note.ts";
import { parseCapture } from "./clip/parse.ts";
import type { Clip, ClipMode, Draft, Inline, PlacedMap } from "./clip/types.ts";
import { createInk, InkError } from "./ink/client.ts";
import { fetchDocument, urlLooksLikeDocument, type DownloadedFile } from "./clip/document.ts";
import { reduce, settle, type Session } from "./session.ts";
import { clipFromTree } from "./clip/tree.ts";
import { clipWithTweet, fetchOembed, tweetFromOembed, tweetTarget } from "./clip/tweet.ts";
import { clipWithVideo, fetchWatch, thinVideo, watchTarget } from "./clip/video.ts";

const NOTE_TEXT_LIMIT = 500_000;
const PERSIST_LIMIT = 8_000_000;
const CLIP_MS = 12_000;

export interface AuthView {
  host: string;
  status: "missing" | "ready" | "rejected";
  personName: string | null;
  readOnly: boolean;
  workspaces: readonly Workspace[];
}

export type FolderCache = { status: "empty" } | { status: "loading"; workspaceId: string } | { status: "ready"; workspaceId: string; list: FolderList } | { status: "error"; workspaceId: string; message: string };

export interface ExtensionState {
  auth: AuthView;
  session: Session;
  folders: FolderCache;
  notice: string | null;
}

interface SavedAuth {
  token: string;
  host: string;
}

interface LastPlace {
  workspaceId: string;
  folderId: string;
}

export function createClipper(): Clipper {
  let session: Session = { status: "idle" };
  let auth: SavedAuth | null = null;
  let personName: string | null = null;
  let readOnly = false;
  let rejected = false;
  let workspaces: readonly Workspace[] = [];
  let folders: FolderCache = { status: "empty" };
  let notice: string | null = null;
  let lastPlace: LastPlace | null = null;
  let touched = 0;
  const fileBytes = new Map<string, Uint8Array>();
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function load(): Promise<void> {
    const local = await chrome.storage.local.get(["auth", "lastPlace"]);
    auth = isAuth(local.auth) ? local.auth : null;
    lastPlace = isPlace(local.lastPlace) ? local.lastPlace : null;
    const stored = await chrome.storage.session.get(["pending"]);
    if (isSession(stored.pending)) session = stored.pending;
    if (auth) {
      try {
        const list = await createInk(auth).listWorkspaces();
        personName = list.person.name;
        readOnly = list.readOnly;
        workspaces = list.workspaces;
        rejected = false;
      } catch {
        rejected = true;
      }
    }
    if (session.status === "saving") await commit();
  }

  async function persist(): Promise<void> {
    const text = JSON.stringify(session);
    if (text.length >= PERSIST_LIMIT) {
      await chrome.storage.session.remove(["pending"]);
      return;
    }
    await chrome.storage.session.set({ pending: session });
  }

  function view(): ExtensionState {
    return {
      auth: {
        host: auth?.host ?? "https://commonink.app",
        status: !auth ? "missing" : rejected ? "rejected" : "ready",
        personName,
        readOnly,
        workspaces,
      },
      session,
      folders,
      notice,
    };
  }

  async function ensureFolders(workspaceId: string | null, force = false): Promise<void> {
    if (!auth || rejected || !workspaceId) return;
    if (!force && folders.status === "ready" && folders.workspaceId === workspaceId) return;
    if (!force && folders.status === "loading" && folders.workspaceId === workspaceId) return;
    folders = { status: "loading", workspaceId };
    try {
      const list = await createInk(auth).listFolders(workspaceId);
      folders = { status: "ready", workspaceId, list };
      if ((session.status === "review" || session.status === "failed") && session.draft.workspaceId === workspaceId && !session.draft.folderId) {
        session = reduce(session, { type: "draft", patch: { folderId: defaultFolder(list, lastPlace, workspaceId) } });
        await persist();
      }
    } catch (err) {
      folders = { status: "error", workspaceId, message: err instanceof InkError ? err.message : "Could not load folders." };
    }
  }

  function defaultsFor(title: string): Draft {
    const workspaceId = defaultWorkspace(workspaces, lastPlace?.workspaceId ?? null);
    const list = folders.status === "ready" && folders.workspaceId === workspaceId ? folders.list : null;
    return { title, workspaceId, folderId: workspaceId && list ? defaultFolder(list, lastPlace, workspaceId) : null };
  }

  async function take(capture: unknown): Promise<ExtensionState> {
    try {
      const parsed = parseCapture(capture);
      const clip = await maybeVideo(await maybeTweet(clipFromTree(parsed)));
      const draft = defaultsFor(clip.title || parsed.title);
      touched = Date.now();
      session = reduce(session, { type: "captured", clip, defaults: { ...draft, title: clip.title || parsed.title || "Untitled" } });
      notice = null;
      await persist();
      await ensureFolders(session.status === "review" ? session.draft.workspaceId : null, true);
      if (session.status === "review" && !session.draft.folderId && folders.status === "ready") {
        session = reduce(session, { type: "draft", patch: { folderId: defaultFolder(folders.list, lastPlace, folders.workspaceId) } });
        await persist();
      }
    } catch (err) {
      notice = err instanceof Error ? err.message : "Could not clip this page.";
      if (session.status === "clipping") session = { status: "idle" };
      await persist();
    }
    return view();
  }

  async function commit(): Promise<void> {
    if (session.status !== "saving" || !auth) return;
    if (session.note) {
      const draft = session.draft;
      session = reduce(session, { type: "created", note: { ...session.note, url: noteUrl(auth.host, session.note) } });
      lastPlace = { workspaceId: draft.workspaceId, folderId: draft.folderId };
      await chrome.storage.local.set({ lastPlace });
      await chrome.action.setBadgeText({ text: "" });
      await persist();
      return;
    }
    const ink = createInk(auth);
    const draft = session.draft;
    if (session.clip.file && !session.placed.document) {
      const file = session.clip.file;
      const bytes = fileBytes.get(file.url) ?? (await refetchDocument(file.url));
      if (!bytes) {
        session = reduce(session, { type: "failed", message: "The file could not be downloaded." });
        await persist();
        return;
      }
      try {
        const uploaded = await ink.uploadFile({ workspaceId: draft.workspaceId, folderId: draft.folderId, name: file.name, bytes });
        fileBytes.delete(file.url);
        session = reduce(session, { type: "placed", id: "document", upload: { id: uploaded.id, width: null, height: null } });
      } catch (err) {
        session = reduce(session, { type: "failed", message: err instanceof InkError ? err.message : "The file could not be uploaded." });
        await persist();
        return;
      }
      await persist();
    }
    if (session.status !== "saving") return;
    for (const image of blockImages(session.clip)) {
      if (session.status !== "saving") return;
      const id = placeId(image);
      if (!id) {
        const reason = image.source.kind === "skip" ? image.source.reason : "unreadable";
        session = reduce(session, { type: "miss", miss: { key: image.key, reason } });
        continue;
      }
      if (session.placed[id]) continue;
      const bytes = image.source.kind === "inline" ? inlineBytes(image) : image.source.kind === "remote" ? await fetchImage(image.source.url) : null;
      const plan = planImage(bytes);
      if (plan.action === "miss") {
        session = reduce(session, { type: "miss", miss: { key: image.key, reason: plan.reason } });
        await persist();
        continue;
      }
      try {
        const uploaded = await ink.uploadImage({ workspaceId: draft.workspaceId, folderId: draft.folderId, name: plan.name, bytes: plan.bytes });
        const box = imageBox(uploaded, image);
        session = reduce(session, { type: "placed", id, upload: { id: uploaded.id, width: box?.width ?? null, height: box?.height ?? null } });
      } catch (err) {
        const reason = err instanceof InkError && err.code === "not-image" ? "not-image" : "unfetched";
        session = reduce(session, { type: "miss", miss: { key: image.key, reason } });
      }
      await persist();
    }
    if (session.status !== "saving") return;
    const placed: PlacedMap = session.placed;
    const text = clipToMarkdown(session.clip, draft.title, placed);
    if (text.length > NOTE_TEXT_LIMIT) {
      session = reduce(session, { type: "failed", message: "This clip is too long for a note." });
      await persist();
      return;
    }
    try {
      const note = await ink.createNote({ workspaceId: draft.workspaceId, folderId: draft.folderId, text, writeId: session.createKey });
      session = reduce(session, { type: "noted", note: { id: note.id, slug: note.slug, title: note.title || draft.title } });
      await persist();
      if (session.status !== "saving" || !session.note) return;
      session = reduce(session, { type: "created", note: { ...session.note, url: noteUrl(auth.host, session.note) } });
      lastPlace = { workspaceId: draft.workspaceId, folderId: draft.folderId };
      await chrome.storage.local.set({ lastPlace });
      await chrome.action.setBadgeText({ text: "" });
      await persist();
    } catch (err) {
      session = reduce(session, { type: "failed", message: err instanceof InkError ? err.message : "Could not save the note." });
      await persist();
    }
  }

  async function takeFile(file: DownloadedFile): Promise<ExtensionState> {
    fileBytes.set(file.url, file.bytes);
    const now = new Date();
    const clip: Clip = {
      mode: "page",
      title: file.title,
      source: { pageTitle: file.name, pageUrl: file.url, clippedOn: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}` },
      blocks: [],
      file: { name: file.name, url: file.url },
    };
    touched = Date.now();
    session = reduce(session, { type: "captured", clip, defaults: { ...defaultsFor(clip.title), title: clip.title || "Untitled" } });
    notice = null;
    await persist();
    await ensureFolders(session.status === "review" ? session.draft.workspaceId : null, true);
    if (session.status === "review" && !session.draft.folderId && folders.status === "ready") {
      session = reduce(session, { type: "draft", patch: { folderId: defaultFolder(folders.list, lastPlace, folders.workspaceId) } });
      await persist();
    }
    return view();
  }

  async function adopt(token: string, host: string): Promise<ExtensionState> {
    notice = null;
    try {
      const client = createInk({ token: token.trim(), host: host.trim() });
      const list = await client.listWorkspaces();
      auth = { token: token.trim(), host: new URL(host.trim().includes("://") ? host.trim() : `https://${host.trim()}`).origin };
      personName = list.person.name;
      readOnly = list.readOnly;
      workspaces = list.workspaces;
      rejected = false;
      await chrome.storage.local.set({ auth });
      if (session.status === "review" || session.status === "failed") {
        const workspaceId = session.draft.workspaceId ?? defaultWorkspace(workspaces, lastPlace?.workspaceId ?? null);
        session = reduce(session, { type: "draft", patch: { workspaceId, folderId: null } });
        folders = { status: "empty" };
        await ensureFolders(workspaceId, true);
        await persist();
      }
    } catch (err) {
      rejected = true;
      notice = err instanceof InkError ? err.message : "Could not connect.";
    }
    return view();
  }

  const ready = load();

  const api: Clipper = {
    getState: () => enqueue(async () => {
      await ready;
      const workspaceId = session.status === "review" || session.status === "failed" ? session.draft.workspaceId : null;
      await ensureFolders(workspaceId);
      return view();
    }),
    wake: () => enqueue(async () => {
      await ready;
      const next = settle(session, touched, Date.now());
      if (next.status !== session.status) {
        session = next;
        notice = null;
        await chrome.action.setBadgeText({ text: "" });
        await persist();
      }
      if (folders.status === "ready" || folders.status === "error") folders = { status: "empty" };
      const workspaceId = session.status === "review" || session.status === "failed" ? session.draft.workspaceId : null;
      await ensureFolders(workspaceId, true);
      return view();
    }),
    signIn: (host) => enqueue(async () => {
      await ready;
      notice = null;
      let origin: string;
      try {
        origin = new URL(host.trim().includes("://") ? host.trim() : `https://${host.trim() || "commonink.app"}`).origin;
      } catch {
        notice = "The host must be an http(s) address.";
        return view();
      }
      const redirect = chrome.identity.getRedirectURL();
      let back: string | undefined;
      try {
        back = await chrome.identity.launchWebAuthFlow({ url: `${origin}/clipper/connect?redirect=${encodeURIComponent(redirect)}`, interactive: true });
      } catch {
        notice = "Sign-in was cancelled.";
        return view();
      }
      let granted = "";
      try {
        granted = new URLSearchParams((back ? new URL(back).hash : "").replace(/^#/, "")).get("token") ?? "";
      } catch {
        granted = "";
      }
      if (!granted.startsWith("cink_")) {
        notice = "Sign-in did not finish.";
        return view();
      }
      return adopt(granted, origin);
    }),
    connect: (token, host) => enqueue(async () => {
      await ready;
      return adopt(token, host);
    }),
    disconnect: () => enqueue(async () => {
      await ready;
      auth = null;
      personName = null;
      readOnly = false;
      rejected = false;
      workspaces = [];
      folders = { status: "empty" };
      lastPlace = null;
      notice = null;
      await chrome.storage.local.remove(["auth", "lastPlace"]);
      await persist();
      return view();
    }),
    capture: (tabId, frameId, mode) => enqueue(async () => {
      await ready;
      if (session.status === "saving") return view();
      notice = null;
      touched = Date.now();
      const tabUrl = await tabAddress(tabId);
      if (mode === "page" && tabUrl && urlLooksLikeDocument(tabUrl)) {
        const downloaded = await fetchDocument(tabUrl);
        if (downloaded === "too-big") {
          notice = "This file is too big to clip.";
          return view();
        }
        if (downloaded) return takeFile(downloaded);
      }
      const previous = session;
      session = reduce(session, { type: "clipping" });
      await persist();
      let response: { type?: string; capture?: unknown; message?: string } | undefined;
      try {
        response = await within(chrome.tabs.sendMessage(tabId, { type: "capture", mode }, { frameId }), CLIP_MS);
      } catch (err) {
        const downloaded = mode === "page" && tabUrl ? await fetchDocument(tabUrl) : null;
        if (downloaded === "too-big") {
          session = { status: "idle" };
          notice = "This file is too big to clip.";
          await persist();
          return view();
        }
        if (downloaded) return takeFile(downloaded);
        session = previous.status === "clipping" ? { status: "idle" } : previous;
        notice = err instanceof Error && err.message === "timeout" ? "This page took too long to clip." : "This page can't be clipped.";
        await persist();
        return view();
      }
      if (!response || response.type === "capture-failed") {
        const downloaded = mode === "page" && tabUrl ? await fetchDocument(tabUrl) : null;
        if (downloaded && downloaded !== "too-big") return takeFile(downloaded);
        session = previous.status === "clipping" ? { status: "idle" } : previous;
        notice = downloaded === "too-big" ? "This file is too big to clip." : response?.message || "Could not clip this page.";
        await persist();
        return view();
      }
      return take(response.capture);
    }),
    accept: (capture) => enqueue(async () => {
      await ready;
      return take(capture);
    }),
    setDraft: (patch) => enqueue(async () => {
      await ready;
      const previous = session.status === "review" || session.status === "failed" ? session.draft.workspaceId : null;
      session = reduce(session, { type: "draft", patch });
      if ((session.status === "review" || session.status === "failed") && patch.workspaceId && patch.workspaceId !== previous) {
        session = reduce(session, { type: "draft", patch: { folderId: null } });
        folders = { status: "empty" };
        await ensureFolders(patch.workspaceId);
      }
      await persist();
      return view();
    }),
    save: () => enqueue(async () => {
      await ready;
      if (readOnly) {
        notice = "This agent can only read.";
        return view();
      }
      notice = null;
      session = reduce(session, { type: "save" });
      await persist();
      await commit();
      return view();
    }),
    dismiss: () => enqueue(async () => {
      await ready;
      session = reduce(session, { type: "dismiss" });
      notice = null;
      await chrome.action.setBadgeText({ text: "" });
      await persist();
      return view();
    }),
  };

  return api;
}

export interface Clipper {
  getState(): Promise<ExtensionState>;
  wake(): Promise<ExtensionState>;
  signIn(host: string): Promise<ExtensionState>;
  connect(token: string, host: string): Promise<ExtensionState>;
  disconnect(): Promise<ExtensionState>;
  capture(tabId: number, frameId: number, mode: ClipMode): Promise<ExtensionState>;
  accept(capture: unknown): Promise<ExtensionState>;
  setDraft(patch: Partial<Draft>): Promise<ExtensionState>;
  save(): Promise<ExtensionState>;
  dismiss(): Promise<ExtensionState>;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function tabAddress(tabId: number): Promise<string | null> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? null;
  } catch {
    return null;
  }
}

async function refetchDocument(url: string): Promise<Uint8Array | null> {
  const downloaded = await fetchDocument(url);
  return downloaded && downloaded !== "too-big" ? downloaded.bytes : null;
}

async function maybeVideo(clip: Clip): Promise<Clip> {
  const watch = watchTarget(clip.source.pageUrl);
  if (!watch || clip.mode !== "page" || !thinVideo(clip.title, clipText(clip))) return clip;
  const card = await fetchWatch(watch);
  return card ? clipWithVideo(clip, card, watch) : clip;
}

async function maybeTweet(clip: Clip): Promise<Clip> {
  const page = tweetTarget(clip.source.pageUrl);
  const linked = firstHref(clip);
  const target = clip.mode === "link" ? (linked ? tweetTarget(linked) : null) : page && thinTweet(clip) ? page : null;
  if (!target) return clip;
  const html = await fetchOembed(target.permalink);
  if (!html) return clip;
  const tweet = tweetFromOembed(html, target.permalink);
  return tweet ? clipWithTweet(clip, tweet) : clip;
}

function thinTweet(clip: Clip): boolean {
  const text = clipText(clip);
  return text.length < 40 || /log in|sign up|javascript/i.test(text);
}

function clipText(clip: Clip): string {
  const parts: string[] = [];
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.type === "text") parts.push(inline.text);
      else if (inline.type !== "code") walk(inline.inlines);
    }
  };
  for (const block of clip.blocks) {
    if (block.type === "paragraph" || block.type === "heading") walk(block.inlines);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function firstHref(clip: Clip): string | null {
  for (const block of clip.blocks) {
    if (block.type !== "paragraph") continue;
    for (const inline of block.inlines) if (inline.type === "link") return inline.href;
  }
  return null;
}

function isAuth(value: unknown): value is SavedAuth {
  return !!value && typeof value === "object" && typeof (value as SavedAuth).token === "string" && typeof (value as SavedAuth).host === "string";
}

function isPlace(value: unknown): value is LastPlace {
  return !!value && typeof value === "object" && typeof (value as LastPlace).workspaceId === "string" && typeof (value as LastPlace).folderId === "string";
}

function isSession(value: unknown): value is Session {
  return !!value && typeof value === "object" && typeof (value as Session).status === "string";
}
