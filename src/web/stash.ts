import type { OpInput } from "../core/protocol.ts";

/** A note's write as the editor sends it, with the id the server knows it by when it comes again. */
export type NoteWrite = Extract<OpInput, { type: "note.write" }> & { writeId: string };

/** A note's typing kept in the browser as a page went, for a later load to send. */
export interface Kept {
  /** The page and the note: each page keeps its own, and forgets only its own. */
  key: string;
  workspaceId: string;
  personId: string;
  /** The write on its way as the page went, sent first so that the server's answer says what it was merged with. */
  op: NoteWrite;
  /** All the member had typed, which can be more than `op` holds. */
  text: string;
  /** The id of the write that sends what `text` holds beyond `op`, the same however often it is sent. */
  nextWriteId: string;
  /** When it was kept, by the browser's clock. */
  at: number;
}

const STORE = "typing";
const OPEN_MS = 2000;
let db: IDBDatabase | null = null;
let opening: Promise<IDBDatabase | null> | null = null;
/** Once the member signs out, this page keeps nothing more. */
let signedOut = false;

/**
 * The browser's store, or null where there is none or it refuses, as some do in a private window. A
 * page that can't keep typing goes on without it.
 */
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const asked = indexedDB.open("ink-typing", 1);
      asked.onupgradeneeded = () => asked.result.createObjectStore(STORE, { keyPath: "key" });
      asked.onsuccess = () => resolve((db = asked.result));
      asked.onerror = asked.onblocked = () => resolve(null);
      // A note's first read waits for what was kept for it, so a store that never answers is taken for none.
      setTimeout(() => resolve(null), OPEN_MS);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** Everything kept, once the store is open, which `keep` needs. */
export async function kept(): Promise<Kept[]> {
  const store = await open();
  if (!store) return [];
  return new Promise((resolve) => {
    try {
      const asked = store.transaction(STORE).objectStore(STORE).getAll();
      asked.onsuccess = () => resolve(asked.result as Kept[]);
      asked.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function change(edit: (store: IDBObjectStore) => void) {
  if (!db) return;
  try {
    const writing = db.transaction(STORE, "readwrite");
    edit(writing.objectStore(STORE));
    writing.commit();
  } catch {}
}

/** Starts keeping typing before this returns, since a page going away gives nothing after it time to start. Nothing is kept until the store has been opened. */
export function keep(typing: Kept) {
  if (!signedOut) change((store) => store.put(typing));
}

export const forget = (key: string) => change((store) => store.delete(key));

/** Forgets everything kept, for whoever kept it, as the member signs out, and keeps nothing more in this page. */
export function forgetAll() {
  signedOut = true;
  void open().then(() => change((store) => store.clear()));
}
