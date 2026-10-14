import type { PluginHost } from "../../plugin-api.ts";

/** How many pages run each HTML now, by a hash of its text. */
type Counts = Record<string, number>;

const KEY = "running";

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Which HTML runs in this browser now, kept where the plugin keeps things in the browser. A page
 * takes its own out when it is left. A page that stopped answering because of what it ran (a loop,
 * where the browser keeps the frame and the app in one process) is never left that way, so its HTML
 * stays listed, and when it is opened again, in that tab or another, it asks before it runs.
 */
export function runningIn(storage: PluginHost["storage"]) {
  const mine = new Map<string, number>();
  const read = (): Counts => {
    const stored = storage.get(KEY);
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Counts) } : {};
  };
  const add = (key: string, by: number) => {
    const counts = read();
    const n = (Number(counts[key]) || 0) + by;
    if (n > 0) counts[key] = n;
    else delete counts[key];
    try {
      storage.set(KEY, counts);
    } catch {
      // A browser that keeps nothing can't say what ran either.
    }
  };
  const left = () => mine.forEach((n, key) => add(key, -n));
  const back = (event: PageTransitionEvent) => event.persisted && mine.forEach((n, key) => add(key, n));
  addEventListener("pagehide", left);
  addEventListener("pageshow", back);
  return {
    /** Whether this HTML runs in another page now, or did when its page stopped answering. */
    elsewhere: (html: string) => (Number(read()[hash(html)]) || 0) > (mine.get(hash(html)) ?? 0),
    /** Lists this HTML as running in this page, until what this answers is called. */
    started(html: string): () => void {
      const key = hash(html);
      mine.set(key, (mine.get(key) ?? 0) + 1);
      add(key, 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const n = (mine.get(key) ?? 1) - 1;
        if (n) mine.set(key, n);
        else mine.delete(key);
        add(key, -1);
      };
    },
    /** Forgets this HTML ran anywhere but here: the member has said to run it. */
    forget(html: string) {
      const key = hash(html);
      add(key, (mine.get(key) ?? 0) - (Number(read()[key]) || 0));
    },
    stop() {
      removeEventListener("pagehide", left);
      removeEventListener("pageshow", back);
    },
  };
}
