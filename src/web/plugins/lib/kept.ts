import { useEffect, useState } from "react";
import type { PluginHost } from "../../plugin-api.ts";

/** State a plugin keeps in its storage, so it survives a reload. */
export function useKept<T>(storage: PluginHost["storage"], key: string, is: (v: unknown) => v is T, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    const kept = storage.get(key);
    return is(kept) ? kept : fallback;
  });
  useEffect(() => storage.set(key, value), [storage, key, value]);
  return [value, setValue] as const;
}
