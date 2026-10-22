import { applyChanges, changesBetween } from "../core/text.ts";
import { ApiError } from "./api.ts";

export type AgentsFileStatus =
  | { kind: "loading" }
  /** The file couldn't be read, so nothing can be typed into it. */
  | { kind: "unread"; message: string }
  | { kind: "saved" }
  /** Typed, and sent once the typing pauses. */
  | { kind: "unsaved" }
  | { kind: "saving" }
  /** The server couldn't be reached. The write is tried again. */
  | { kind: "retrying" }
  /** The session ended. The text is kept here and sent on the next `refresh`. */
  | { kind: "signedOut" }
  /** The server won't take it, and said why. The text is kept here, and sent again with the next change. */
  | { kind: "refused"; message: string };

interface Stored {
  text: string;
  revision: number;
}

export interface AgentsFileServer {
  read(): Promise<Stored>;
  write(text: string, on: { baseRevision: number; writeId: string; supersedes?: string }): Promise<{ revision: number }>;
}

export interface AgentsFileStore {
  subscribe(listener: () => void): () => void;
  /** The file as text: what the server has, with what was typed here that it doesn't have yet. */
  text(): string;
  /** The same object until it changes. */
  status(): AgentsFileStatus;
  /** Reads the file, once. Until that has worked, typing is refused. */
  load(): Promise<void>;
  /** Takes the text as the member typed it, to be saved once the typing pauses. False before the file is read. */
  type(text: string): boolean;
  /** Sends what isn't saved now, for when the member leaves the editor or the page. */
  flush(): void;
  /** Reads the file again, for a change made in another browser, and puts what was typed here back over it. */
  refresh(): Promise<void>;
}

export const PAUSE_MS = 1000;
const RETRY_MS = 3000;
const SAVED: AgentsFileStatus = { kind: "saved" };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `mine` and `theirs`, each made from `base`, as one text: what was typed here put over what was saved elsewhere. */
export const merged = (base: string, mine: string, theirs: string) => applyChanges(changesBetween(base, mine).map(changesBetween(base, theirs)), theirs);

/**
 * The workspace's agents file as this browser has it. A write names the revision it was made on, so
 * one made on an older copy is refused as a conflict; the file is then read again and what was typed
 * here is merged over it, so two people writing at once both keep their words.
 */
export function createAgentsFileStore(server: AgentsFileServer, pauseMs = PAUSE_MS): AgentsFileStore {
  const listeners = new Set<() => void>();
  let base: Stored = { text: "", revision: 0 };
  let text = "";
  let loaded = false;
  let status: AgentsFileStatus = { kind: "loading" };
  /** The write in flight whose answer is still wanted. A write that took its place is the one here. */
  let sending: { id: string; text: string } | null = null;
  /** A write the server never answered. It may have been taken, so the next write says it takes its place. */
  let unanswered: { id: string; text: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tell = (next: AgentsFileStatus = status) => {
    status = next;
    for (const listener of [...listeners]) listener();
  };

  /** Takes the server's file, with what was typed here put back over it. A file that is a write of ours never answered already has it. */
  function rebase(onto: Stored) {
    if (onto.text !== unanswered?.text) text = merged(base.text, text, onto.text);
    unanswered = undefined;
    base = onto;
  }

  function retry() {
    tell({ kind: "retrying" });
    timer = setTimeout(() => !sending && save(), RETRY_MS);
  }

  /** Sends the text now, in place of any write in flight, which `supersedes` then names. */
  function save(supersedes = unanswered?.id) {
    clearTimeout(timer);
    if (text === base.text) return tell(SAVED);
    const mine = (sending = { id: crypto.randomUUID(), text });
    tell({ kind: "saving" });
    server.write(mine.text, { baseRevision: base.revision, writeId: mine.id, supersedes }).then(
      ({ revision }) => {
        if (sending !== mine) return;
        sending = null;
        unanswered = undefined;
        base = { text: mine.text, revision };
        save();
      },
      async (err: unknown) => {
        if (sending !== mine) return;
        if (err instanceof ApiError && err.code === "conflict") {
          const read = await server.read().catch(() => null);
          if (sending !== mine) return;
          sending = null;
          if (!read) return retry();
          rebase(read);
          return save();
        }
        sending = null;
        if (err instanceof ApiError && err.status === 401) {
          unanswered = mine;
          return tell({ kind: "signedOut" });
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return tell({ kind: "refused", message: messageOf(err) });
        unanswered = mine;
        retry();
      },
    );
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    text: () => text,
    status: () => status,
    async load() {
      if (loaded) return;
      tell({ kind: "loading" });
      try {
        const read = await server.read();
        if (loaded) return;
        loaded = true;
        base = read;
        text = read.text;
        tell(SAVED);
      } catch (err) {
        if (!loaded) tell({ kind: "unread", message: messageOf(err) });
      }
    },
    type(next) {
      if (!loaded) return false;
      if (next === text) return true;
      text = next;
      if (!sending) {
        clearTimeout(timer);
        timer = setTimeout(() => !sending && save(), pauseMs);
        if (status.kind !== "unsaved") tell({ kind: "unsaved" });
      }
      return true;
    },
    flush() {
      if (loaded && text !== base.text && sending?.text !== text) save(sending?.id ?? unanswered?.id);
    },
    async refresh() {
      if (!loaded) return;
      const read = await server.read().catch(() => null);
      // A write in flight was made on what is here now, so it will be refused and read this for itself.
      if (!read || sending) return;
      if (read.revision > base.revision) rebase(read);
      if (text === base.text) {
        clearTimeout(timer);
        return tell(SAVED);
      }
      // Signed in again, or refused before: what waited is sent. Otherwise a pause or a retry is on its way to send it.
      if (status.kind === "signedOut" || status.kind === "refused") return save();
      tell();
    },
  };
}

/** What the member is told of how the agents file stands. */
export const agentsFileLabel = (status: AgentsFileStatus) => {
  switch (status.kind) {
    case "loading":
      return "Loading the agents file…";
    case "unread":
      return "The agents file couldn't be loaded, so nothing can be changed here";
    case "saved":
      return "Saved";
    case "unsaved":
      return "Unsaved";
    case "saving":
      return "Saving…";
    case "retrying":
      return "Couldn't save. Retrying…";
    case "signedOut":
      return "Not saved: you're signed out";
    case "refused":
      return `Not saved: ${status.message}`;
  }
};
