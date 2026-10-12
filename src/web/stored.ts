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
