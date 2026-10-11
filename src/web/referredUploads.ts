import type { ReferredUpload } from "../core/protocol.ts";

type Referred = ReferredUpload["upload"];

const said = (upload: Referred) => (upload ? [upload.name, upload.type, upload.kind, upload.size, upload.width, upload.height, upload.state].join("\n") : null);

/**
 * What the app has been told of the uploads notes refer to, by upload id: by each read of a note,
 * and by whatever made, changed or removed one. The latest word on an upload is the one kept.
 */
export function referredUploads() {
  const known = new Map<string, Referred>();
  const listeners = new Set<() => void>();
  return {
    /** Undefined for an upload nothing has been said of. */
    get: (id: string): Referred | undefined => known.get(id),
    /** Listeners are told once, and only when something is different from what was known. */
    learn(uploads: readonly ReferredUpload[]) {
      let changed = false;
      for (const { id, upload } of uploads) {
        if (known.has(id) && said(known.get(id)!) === said(upload)) continue;
        known.set(id, upload);
        changed = true;
      }
      if (changed) for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
