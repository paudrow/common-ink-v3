import { ApiError } from "./api.ts";
import type { SettingValue } from "./plugin-api.ts";
import { documentOf, editSetting, sameValue } from "./settings.ts";

export type SettingsStatus =
  | { kind: "loading" }
  /** The stored document couldn't be read. The defaults are in use and nothing is written, so it can't be lost. */
  | { kind: "unread"; message: string }
  | { kind: "saved" }
  | { kind: "saving" }
  /** The server couldn't be reached. The write is tried again. */
  | { kind: "retrying" }
  /** The session ended. The changes are kept here and sent on the next `refresh`, which is asked for once the member is signed in again. */
  | { kind: "signedOut" }
  /** The server won't take the document, and said why. The change was taken back out. */
  | { kind: "refused"; message: string };

export interface SettingsStore {
  subscribe(listener: () => void): () => void;
  /** The member's document as text: what the server has, with the changes made here that it doesn't have yet. */
  text(): string;
  /** The same object until it changes. */
  status(): SettingsStatus;
  /** Reads the stored document. Until that has worked once, the text is `{}` and changes are refused. */
  load(): Promise<void>;
  /** Sets one key, or takes it out when `value` is undefined. False when the change was refused. */
  set(key: string, value: SettingValue | undefined): boolean;
  /** Replaces the whole text, which must be a JSON object. False when the change was refused. */
  replace(text: string): boolean;
  /** Sends what isn't saved now, in place of the write in flight. For when the page is going away. */
  flush(): void;
  /** Reads the document again, for a change made in another browser. Changes made here are put back over it. */
  refresh(): Promise<void>;
}

interface Stored {
  text: string;
  revision: number;
}

export interface SettingsServer {
  read(): Promise<Stored>;
  write(text: string, on: { baseRevision: number; writeId: string; supersedes?: string }): Promise<{ revision: number }>;
}

/** One key set to a value, or taken out when the value is undefined. */
interface Edit {
  key: string;
  value: unknown;
}

const RETRY_MS = 3000;
const SAVED: SettingsStatus = { kind: "saved" };
const SAVING: SettingsStatus = { kind: "saving" };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isConflict = (err: unknown) => err instanceof ApiError && err.code === "conflict";
/** The server answered, and its answer was no. Asking again would get the same. */
const isSignedOut = (err: unknown) => err instanceof ApiError && err.status === 401;
const isRefusal = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && !isSignedOut(err);

/**
 * A member's settings in one workspace, as this browser has them. A write names the revision it was
 * made on, so one made on an older copy is refused, not taken over a newer one. The changes made
 * here are kept key by key until the server has them, so that after such a refusal they are put
 * back over what the server has, and a change to another key made elsewhere survives.
 */
export function createSettingsStore(server: SettingsServer): SettingsStore {
  const listeners = new Set<() => void>();
  let base: Stored = { text: "{}", revision: 0 };
  let text = base.text;
  /** The changes in `text` that `base` doesn't have, oldest first. */
  let pending: Edit[] = [];
  let loaded = false;
  let status: SettingsStatus = { kind: "loading" };
  /** The write in flight whose answer is still wanted. A write that took its place is the one here. */
  let sending: { id: string; text: string; count: number } | null = null;
  /** A write the server never answered, such as one cut off as the page left. It may have been taken, so the next write says it takes its place. */
  let unanswered: string | undefined;

  const tell = (next: SettingsStatus = status) => {
    status = next;
    for (const listener of [...listeners]) listener();
  };

  function rebase(onto: Stored) {
    base = onto;
    text = pending.reduce((document, edit) => editSetting(document, edit.key, edit.value), onto.text);
    if (sameValue(documentOf(text), documentOf(onto.text))) {
      text = onto.text;
      pending = [];
    }
  }

  function save(supersedes?: string) {
    if (text === base.text) return tell(status.kind === "saving" || status.kind === "retrying" || status.kind === "signedOut" ? SAVED : status);
    const mine = (sending = { id: crypto.randomUUID(), text, count: pending.length });
    tell(SAVING);
    server.write(mine.text, { baseRevision: base.revision, writeId: mine.id, supersedes: supersedes ?? unanswered }).then(
      ({ revision }) => {
        if (sending !== mine) return;
        unanswered = undefined;
        sending = null;
        base = { text: mine.text, revision };
        pending = pending.slice(mine.count);
        save();
      },
      async (err: unknown) => {
        if (sending !== mine) return;
        if (isConflict(err)) {
          unanswered = undefined;
          const read = await server.read().catch(() => null);
          if (sending !== mine) return;
          sending = null;
          if (read) {
            rebase(read);
            return save();
          }
        } else if (isRefusal(err)) {
          sending = null;
          pending = [];
          text = base.text;
          return tell({ kind: "refused", message: messageOf(err) });
        }
        sending = null;
        unanswered = mine.id;
        if (isSignedOut(err)) return tell({ kind: "signedOut" });
        tell({ kind: "retrying" });
        setTimeout(() => !sending && save(), RETRY_MS);
      },
    );
  }

  function change(next: string, edits: Edit[]) {
    if (!loaded) return false;
    if (next === text) return true;
    text = next;
    pending.push(...edits);
    if (sending) tell();
    else save();
    return true;
  }

  async function load() {
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
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    text: () => text,
    status: () => status,
    load,
    set(key, value) {
      const document = documentOf(text) ?? {};
      if (value === undefined ? !Object.hasOwn(document, key) : sameValue(document[key], value)) return loaded;
      return change(editSetting(text, key, value), [{ key, value }]);
    },
    replace(next) {
      const before = documentOf(text) ?? {};
      const after = documentOf(next);
      if (!after) return false;
      const set = Object.keys(after).filter((key) => !sameValue(before[key], after[key]));
      const gone = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
      return change(next, [...set.map((key) => ({ key, value: after[key] })), ...gone.map((key) => ({ key, value: undefined }))]);
    },
    flush() {
      if (loaded && text !== base.text && sending?.text !== text) save(sending?.id);
    },
    async refresh() {
      if (!loaded) return load();
      const read = await server.read().catch(() => null);
      // A write in flight was made on what is here now, so it will be refused and read this for itself.
      if (!read || sending) return;
      if (read.revision <= base.revision) return status.kind === "signedOut" ? save() : undefined;
      rebase(read);
      if (text === base.text) tell(status.kind === "saved" || status.kind === "refused" || status.kind === "signedOut" ? SAVED : status);
      else save();
    },
  };
}

/** What a member is told of how their settings stand, on the Settings page and wherever else one is changed. */
export const statusLabel = (status: SettingsStatus) => {
  switch (status.kind) {
    case "loading":
      return "Loading your settings…";
    case "unread":
      return "Your settings couldn't be loaded, so nothing can be changed here";
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "retrying":
      return "Couldn't save. Retrying…";
    case "signedOut":
      return "Not saved: you're signed out";
    case "refused":
      return `Not saved, and put back as it was: ${status.message}`;
  }
};
