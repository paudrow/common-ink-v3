import { useEffect, useState, useSyncExternalStore } from "react";
import { ON_SCREEN_HEIGHT, seen, type Device, type Keyboard } from "./device.ts";
import { readStored, writeStored } from "./stored.ts";

const TOUCH = "(pointer: coarse) and (not (any-pointer: fine))";
const PHONE = `(max-width: 600px) and ${TOUCH}`;
const KEYBOARD_KEY = "ink.keyboard";
const isKeyboard = (v: unknown): v is Keyboard => v === "unknown" || v === "attached" || v === "onScreen";

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    () => matchMedia(query).matches,
  );
}

const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox"));
};

/** How much of the page the on-screen keyboard covers now, in CSS pixels. Zoomed in, the visible part is smaller for the zoom and not for a keyboard, so none is told. */
function keyboardCovers(): number {
  const viewport = window.visualViewport;
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
}

const inEditor = () => !!document.activeElement?.closest(".cm-editor");

/**
 * This device, as it is now and as it changes: the width and pointer as the browser says, the
 * keyboard as last seen. `covered` is how much of the page the on-screen keyboard covers while a
 * note's editor has the cursor, and 0 otherwise.
 */
export function useDevice(): Device & { covered: number } {
  const phone = useMedia(PHONE);
  const touch = useMedia(TOUCH);
  const [keyboard, setKeyboard] = useState<Keyboard>(() => readStored(KEYBOARD_KEY, isKeyboard) ?? "unknown");
  const [covered, setCovered] = useState(0);
  useEffect(() => writeStored(KEYBOARD_KEY, keyboard), [keyboard]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setKeyboard((was) => seen(was, { kind: "key", key: e.key, chord: e.metaKey || e.ctrlKey || e.altKey }));
    const viewport = window.visualViewport;
    const onViewport = () => {
      const by = keyboardCovers();
      setCovered(by > ON_SCREEN_HEIGHT && inEditor() ? by : 0);
      setKeyboard((was) => seen(was, { kind: "viewport", shorterBy: by, typing: typing() }));
    };
    addEventListener("keydown", onKey, true);
    viewport?.addEventListener("resize", onViewport);
    viewport?.addEventListener("scroll", onViewport);
    addEventListener("focusout", onViewport);
    addEventListener("focusin", onViewport);
    return () => {
      removeEventListener("keydown", onKey, true);
      viewport?.removeEventListener("resize", onViewport);
      viewport?.removeEventListener("scroll", onViewport);
      removeEventListener("focusout", onViewport);
      removeEventListener("focusin", onViewport);
    };
  }, []);
  return { phone, touch, keyboard, covered };
}
