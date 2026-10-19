import { opsAllowedBy, type Capability, type InstalledPlugin } from "../../core/plugins.ts";
import { Id, Op } from "../../core/protocol.ts";
import { MAX_STORED, MAX_STORED_KEYS, MAX_STORED_TOTAL, STORED_INDEX, read, type ErrorCode, type FromPlugin, type Watched } from "./protocol.ts";

/*
 * The one place a message from a plugin's frame becomes something the app does. A frame can send
 * anything, as often as it likes, so nothing it sends is acted on anywhere else.
 */

export const LIMITS = {
  /** How many messages a plugin may send at once. */
  burst: 30,
  /** How many more it may send each second after that. */
  perSecond: 15,
  /** How many operations it may have under way. */
  inFlight: 8,
  /** A plugin refused more than this many messages within `floodWindowMs` is stopped. */
  flood: 300,
  floodWindowMs: 5000,
  /** How many refusals a message that couldn't be read counts as: reading it is what costs the app. */
  unreadable: 10,
  /** The most characters of a notice, the plugin's name included. */
  notice: 200,
};

export type Decision =
  | { kind: "ready" }
  | { kind: "perform"; id: number; op: Op }
  | { kind: "notify"; id: number; message: string }
  | { kind: "open"; id: number; noteId: string; background?: true }
  | { kind: "watch"; id: number; what: Watched }
  | { kind: "stored"; id: number; key: string }
  | { kind: "store"; id: number; key: string; value: unknown }
  /** `from` is the plugin's name, for the dialog to say whose question it is. Null for one of the app's own, whose question is the app's. */
  | { kind: "prompt"; id: number; from: string | null; title: string; label: string; value: string; hint: string; error: string }
  /** How wide what a frame in the bar draws is now. Not answered. */
  | { kind: "fit"; width: number }
  /** A chord the frame gave back, for the app to run as its own key. Not answered. */
  | { kind: "key"; chord: string }
  /** Where this browser is. Answered with a latitude and longitude, or null. Only the app's own unchanged code may ask. `ask` is what shows the browser's prompt. */
  | { kind: "place"; id: number; ask: boolean }
  /** Answered, so the plugin's code hears why. */
  | { kind: "refuse"; id: number; error: { code: ErrorCode; message: string } }
  /** Not answered at all. */
  | { kind: "drop" }
  /** The plugin's frames are to be taken out. Said once. */
  | { kind: "stop"; reason: string };

/** What a plugin is permitted now. A permission that is off, or that the plugin's change voided, is told as `off`. */
export const granted = (plugin: InstalledPlugin): Capability[] => plugin.permissions.filter((p) => p.state === "allowed").map((p) => p.capability);

const plain = (text: string, most: number) => text.slice(0, most).replace(/[\p{Cc}\p{Cf}]+/gu, " ");

/**
 * Whether what runs is code the app itself came with, unchanged: one of Common Ink's own plugins
 * that run shut off, and not a member's copy of one, whose code has a name. Only its words stand
 * in the app unmarked.
 */
export const appsOwn = (plugin: InstalledPlugin): boolean => !plugin.thirdParty && plugin.codeHash === null;

/** A plugin's own words where they stand alone in the app: said to be a plugin's, and whose, unless they are the app's. */
const said = (plugin: InstalledPlugin, text: string) => (appsOwn(plugin) ? plain(text, LIMITS.notice) : `${plugin.manifest.name} plugin: ${plain(text, LIMITS.notice)}`.slice(0, LIMITS.notice));

/** What to do about one message from a frame of `plugin`, from what the record says of the plugin now. */
export function decide(plugin: InstalledPlugin, message: FromPlugin): Decision {
  if ("ready" in message) return { kind: "ready" };
  if ("fit" in message) return { kind: "fit", width: message.fit };
  if ("key" in message && !("call" in message)) return { kind: "key", chord: message.key };
  const { id } = message;
  const { name } = plugin.manifest;
  const refuse = (code: ErrorCode, why: string): Decision => ({ kind: "refuse", id, error: { code, message: why } });
  const has = granted(plugin);
  switch (message.call) {
    case "perform": {
      const { type } = message.op;
      if (!(opsAllowedBy(has) as ReadonlySet<string>).has(type)) return refuse("forbidden", `${name} isn't permitted to ${type}`);
      const op = Op.safeParse(message.op);
      return op.success ? { kind: "perform", id, op: op.data } : refuse("invalid", `That isn't how ${type} is written`);
    }
    case "notify":
      return { kind: "notify", id, message: said(plugin, message.message) };
    case "open":
      if (!has.includes("notes.read")) return refuse("forbidden", `${name} isn't permitted to open a note`);
      return Id.safeParse(message.noteId).success ? { kind: "open", id, noteId: message.noteId, ...(message.background && { background: true }) } : refuse("invalid", "That isn't a note's id");
    case "watch":
      return has.includes("notes.read") ? { kind: "watch", id, what: message.what } : refuse("forbidden", `${name} isn't permitted to read notes, so it isn't told of them`);
    case "storage.get":
      return message.key === STORED_INDEX ? refuse("invalid", `${STORED_INDEX} is the app's own key`) : { kind: "stored", id, key: message.key };
    case "storage.set":
      if (message.key === STORED_INDEX) return refuse("invalid", `${STORED_INDEX} is the app's own key`);
      return JSON.stringify(message.value).length <= MAX_STORED ? { kind: "store", id, key: message.key, value: message.value } : refuse("invalid", `What a plugin keeps under one key is at most ${MAX_STORED} characters as JSON`);
    case "place":
      return appsOwn(plugin) ? { kind: "place", id, ask: message.ask === true } : refuse("forbidden", `${name} isn't told where you are`);
    case "prompt":
      // Its title says whose question it is. The rest is the plugin's words, cut to a line each.
      return { kind: "prompt", id, from: appsOwn(plugin) ? null : name, title: said(plugin, message.title), label: plain(message.label ?? "", 80), value: (message.value ?? "").slice(0, 200), hint: plain(message.hint ?? "", LIMITS.notice), error: plain(message.error ?? "", LIMITS.notice) };
  }
}

/**
 * How much a plugin keeps under each key once `value` is kept under `key`, or why it can't be: it
 * would be more keys than a plugin keeps, or more in all. Null takes a key out. `index` is what the
 * app last wrote, read back from the browser, so anything in it that isn't a size counts for nothing.
 */
export function kept(index: unknown, key: string, value: unknown): { index: Record<string, number> } | { reason: string } {
  const sizes = Object.fromEntries(Object.entries(typeof index === "object" && index !== null ? index : {}).filter(([name, size]) => name !== key && typeof size === "number" && size > 0)) as Record<string, number>;
  if (value === null) return { index: sizes };
  // The key's own name is kept too, so it counts.
  const next = { ...sizes, [key]: key.length + JSON.stringify(value).length };
  if (Object.keys(next).length > MAX_STORED_KEYS) return { reason: `A plugin keeps at most ${MAX_STORED_KEYS} keys. Set one to null to take it out.` };
  if (Object.values(next).reduce((sum, size) => sum + size, 0) > MAX_STORED_TOTAL) return { reason: `A plugin keeps at most ${MAX_STORED_TOTAL} characters in all, as JSON. Set a key to null to take it out.` };
  return { index: next };
}

export interface Broker {
  /** What to do about whatever a frame of the plugin sent. */
  receive(data: unknown): Decision;
  /** Tells the broker an operation it let through has been answered. */
  settled(): void;
  /** Why the plugin was stopped, or null while it isn't. */
  stopped(): string | null;
}

/**
 * The broker for one running plugin, across all its frames. `plugin` is the plugin as the record has
 * it now, or null once it is installed no more: it is asked for each message, so a permission that
 * changed is in force for the next one.
 */
export function createBroker({ plugin, now }: { plugin: () => InstalledPlugin | null; now: () => number }): Broker {
  let tokens = LIMITS.burst;
  let filled = now();
  let inFlight = 0;
  let stopped: string | null = null;
  /** When each message was refused, within the window. */
  let refusals: number[] = [];

  /** Counts a refusal, or several for a message that couldn't be read, which nothing well meant sends. True when it is one too many. */
  const refused = (at: number, weight = 1) => {
    for (let i = 0; i < weight; i++) refusals.push(at);
    if (at - refusals[0]! > LIMITS.floodWindowMs) refusals = refusals.filter((t) => at - t <= LIMITS.floodWindowMs);
    if (refusals.length <= LIMITS.flood) return false;
    stopped = "it sent too many messages";
    refusals = [];
    return true;
  };

  return {
    receive(data) {
      if (stopped) return { kind: "drop" };
      const at = now();
      tokens = Math.min(LIMITS.burst, tokens + ((at - filled) / 1000) * LIMITS.perSecond);
      filled = at;
      const about = plugin();
      const name = about?.manifest.name ?? "This plugin";
      if (tokens < 1) {
        if (refused(at)) return { kind: "stop", reason: stopped! };
        // Read no further than whether there is a call to answer: reading it all is what a flood would cost.
        const id = typeof data === "object" && data !== null ? (data as { id?: unknown }).id : undefined;
        return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? { kind: "refuse", id, error: { code: "rate_limited", message: `${name} is sending too much. Try again in a moment.` } } : { kind: "drop" };
      }
      tokens -= 1;
      const message = read(data);
      if (!message) return refused(at, LIMITS.unreadable) ? { kind: "stop", reason: stopped! } : { kind: "drop" };
      if (!about) return "id" in message ? { kind: "refuse", id: message.id, error: { code: "forbidden", message: "This plugin isn't installed any more" } } : { kind: "drop" };
      const decision = decide(about, message);
      if (decision.kind !== "perform") return decision;
      if (inFlight >= LIMITS.inFlight) return { kind: "refuse", id: decision.id, error: { code: "rate_limited", message: `${name} has too many operations under way. Wait for one to finish.` } };
      inFlight += 1;
      return decision;
    },
    settled() {
      inFlight = Math.max(0, inFlight - 1);
    },
    stopped: () => stopped,
  };
}
