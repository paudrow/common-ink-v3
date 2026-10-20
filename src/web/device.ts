import type { Need } from "./plugin-api.ts";

/**
 * What this device can do, as far as the page can tell. It is about the device and not the member,
 * so it is kept in this browser and never in their settings.
 */
export interface Device {
  /** A phone: a touch screen a phone's width. The app shows one screen at a time. A narrow window on a computer is no phone. */
  phone: boolean;
  /** Touch is the only way to point: no mouse or trackpad. */
  touch: boolean;
  keyboard: Keyboard;
}

/**
 * The keyboard last seen. `attached` is a keyboard with keys no on-screen one has, such as one paired
 * over Bluetooth; `onScreen` is the one the device draws over the page. A device starts at `unknown`.
 */
export type Keyboard = "unknown" | "attached" | "onScreen";


/** Why a plugin whose switch is on is off on this device, as the Plugins page says it. */
export const lackingSaid = (need: Need) => (need === "keyboard" ? "Off on this device until a keyboard is connected. Keyboard plugins without a keyboard, in Settings under Editor, keeps it on." : "Off on a phone.");

/** The keyboard need is met by a keyboard that is attached, or by the member asking for it whatever the device. */
export function lacks(need: Need | undefined, device: Device, keepKeyboardPlugins: boolean): Need | null {
  switch (need) {
    case "room":
      return device.phone ? "room" : null;
    case "keyboard":
      return device.touch && device.keyboard !== "attached" && !keepKeyboardPlugins ? "keyboard" : null;
    case undefined:
      return null;
  }
}

/** What tells one keyboard from the other: a key pressed, or the page made shorter while the member types. */
export type Sign = { kind: "key"; key: string; chord: boolean } | { kind: "viewport"; shorterBy: number; typing: boolean };

/** Keys no on-screen keyboard sends. Letters prove nothing: both kinds send them. */
const ATTACHED_ONLY = new Set(["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** An on-screen keyboard takes far more than this of the page; the bar of shortcuts a phone shows over an attached one takes less. */
export const ON_SCREEN_HEIGHT = 150;

export function seen(was: Keyboard, sign: Sign): Keyboard {
  if (sign.kind === "key") return sign.chord || ATTACHED_ONLY.has(sign.key) ? "attached" : was;
  return sign.typing && sign.shorterBy > ON_SCREEN_HEIGHT ? "onScreen" : was;
}
