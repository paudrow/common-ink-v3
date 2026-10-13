import { z } from "zod";
import type { Capability } from "../../core/plugins.ts";
import type { OpErrorCode } from "../../core/protocol.ts";
import type { SettingValue } from "../plugin-api.ts";

/*
 * What goes between the app and a frame that runs a third-party plugin's code, over the one port the
 * app made for that frame. The port is who the frame is: nothing in a message says, and a message
 * that tries is dropped. Everything a frame sends is read here before anything is done with it.
 */

export const VERSION = 1;
/** The most characters a message from a frame may be, written as JSON. */
export const MAX_MESSAGE = 600_000;

const v = z.literal(VERSION);
const CallId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WATCHED = ["note", "items"] as const;
export type Watched = (typeof WATCHED)[number];
const StorageKey = z.string().min(1).max(100);
/** The most characters one thing a plugin keeps may be, written as JSON. */
export const MAX_STORED = 20_000;
/** As many keys as one plugin keeps, and the most characters all of them together may be. */
export const MAX_STORED_KEYS = 50;
export const MAX_STORED_TOTAL = 100_000;
/** Where the app keeps how much a plugin has under each key. No plugin reads or sets it. */
export const STORED_INDEX = "ink:stored";

const FromPlugin = z.union([
  /** Sent once, when the frame has its port. It is answered with `init`. */
  z.strictObject({ v, ready: z.literal(true) }),
  /** From a frame in the bar: how wide what it draws is now, in pixels. The app makes the frame that wide, up to what the manifest gives it. */
  z.strictObject({ v, fit: z.number().int().min(0).max(10_000) }),
  /** The operation is read against the operations there are once it is known the plugin may perform it. */
  z.strictObject({ v, id: CallId, call: z.literal("perform"), op: z.looseObject({ type: z.string().max(60) }) }),
  z.strictObject({ v, id: CallId, call: z.literal("notify"), message: z.string() }),
  z.strictObject({ v, id: CallId, call: z.literal("open"), noteId: z.string().max(100), background: z.boolean().optional() }),
  /** Asks to be told, from now on, of the note in front as it is typed, or that the notes the member can see have changed. */
  z.strictObject({ v, id: CallId, call: z.literal("watch"), what: z.enum(WATCHED) }),
  /** What the plugin keeps in this browser, for this member in this workspace. Other plugins can't see it. */
  z.strictObject({ v, id: CallId, call: z.literal("storage.get"), key: StorageKey }),
  z.strictObject({ v, id: CallId, call: z.literal("storage.set"), key: StorageKey, value: z.json() }),
  /** Asks the member for one line of text, in a dialog the app draws. */
  z.strictObject({ v, id: CallId, call: z.literal("prompt"), title: z.string(), label: z.string().optional(), value: z.string().optional(), hint: z.string().optional(), error: z.string().optional() }),
]);
export type FromPlugin = z.output<typeof FromPlugin>;

/** Where a frame is drawn, and what it is drawn for. Nothing of the member is in it. */
export type Context =
  | { kind: "background" }
  /** `noteId` is the open note, for a plugin that may read notes, and null for any other. */
  | { kind: "view"; id: string; slot: "inspector" | "page" | "bar"; noteId: string | null }
  | { kind: "embed"; name: string; config: string; body: string; readOnly: true };

export type ErrorCode = OpErrorCode | "rate_limited" | "signed_out" | "unknown";

export type ToPlugin =
  | { v: 1; init: { context: Context; settings: Record<string, SettingValue>; granted: Capability[]; plugin: { name: string; version: string } } }
  | { v: 1; reply: number; ok: true; result: unknown }
  | { v: 1; reply: number; ok: false; error: { code: ErrorCode; message: string } }
  | { v: 1; event: "command"; id: string }
  | { v: 1; event: "settings"; settings: Record<string, SettingValue> }
  /** The note in front, its text as its editor has it now and what is selected in it, or null when no note is open in an editor. Sent to a frame that watches `note`. */
  | { v: 1; event: "note"; note: { id: string; text: string; selected: string } | null }
  /** The notes the member can see have changed. Sent to a frame that watches `items`. */
  | { v: 1; event: "items" }
  /** Something the plugin keeps was set, by any of its frames. */
  | { v: 1; event: "storage"; key: string; value: unknown };

/** Whether `value` is plain data small enough to be worth writing out: no more than `MAX_MESSAGE` of strings and nodes, counted without building anything. */
function small(value: unknown): boolean {
  let left = MAX_MESSAGE;
  const walk = (v: unknown, depth: number): boolean => {
    if (--left < 0 || depth > 50) return false;
    if (typeof v === "string") return (left -= v.length) >= 0;
    if (typeof v !== "object" || v === null) return typeof v !== "bigint" && typeof v !== "function" && typeof v !== "symbol";
    if (Array.isArray(v)) return v.length <= left && v.every((item) => walk(item, depth + 1));
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(v).every((key) => (left -= key.length) >= 0 && walk((v as Record<string, unknown>)[key], depth + 1));
  };
  return walk(value, 0);
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** Whether no object in `value` has a key that names a prototype. `value` is what JSON.parse made, so it has no cycles. */
function safe(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every(safe);
  return Object.keys(value).every((key) => !UNSAFE.has(key) && safe((value as Record<string, unknown>)[key]));
}

/**
 * What a frame sent, as one of the messages there are, or null for anything else: another version,
 * a key the message doesn't have, a wrong type, more than `MAX_MESSAGE`, or a key that names a
 * prototype. What is read is plain data, made again from its JSON, so nothing of the object that
 * arrived is handed on.
 */
export function read(data: unknown): FromPlugin | null {
  if (!small(data)) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  if (json === undefined || json.length > MAX_MESSAGE) return null;
  const plain: unknown = JSON.parse(json);
  if (!safe(plain)) return null;
  const parsed = FromPlugin.safeParse(plain);
  return parsed.success ? parsed.data : null;
}
