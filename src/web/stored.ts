import { useEffect, useState } from "react";

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isString = (v: unknown): v is string => typeof v === "string";
export const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

export function readStored<T>(key: string, is: (v: unknown) => v is T): T | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return is(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const writeStored = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

/** State kept in localStorage, so it survives a reload. */
export function useStored<T>(key: string, is: (v: unknown) => v is T, fallback: T) {
  const [value, setValue] = useState<T>(() => readStored(key, is) ?? fallback);
  useEffect(() => writeStored(key, value), [key, value]);
  return [value, setValue] as const;
}

/**
 * A map this tab of the browser keeps through a reload, in sessionStorage: what is set last is kept
 * longest, and the last `size` entries are written as the page goes.
 */
export function keptThroughReload<T>(key: string, is: (v: unknown) => v is T, size: number): Map<string, T> {
  const map = new (class extends Map<string, T> {
    override set(k: string, v: T) {
      this.delete(k);
      return super.set(k, v);
    }
  })();
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (Array.isArray(kept)) for (const entry of kept) if (Array.isArray(entry) && isString(entry[0]) && is(entry[1])) map.set(entry[0], entry[1]);
  } catch {
    // Nothing kept, or storage refused: the map starts empty.
  }
  globalThis.addEventListener?.("pagehide", () => {
    try {
      sessionStorage.setItem(key, JSON.stringify([...map].slice(-size)));
    } catch {
      // Storage refused: the next load starts empty.
    }
  });
  return map;
}
