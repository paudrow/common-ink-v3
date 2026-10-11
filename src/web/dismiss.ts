import { useEffect, type RefObject } from "react";

/** Open menus and popovers, innermost last; Escape closes only the innermost. */
const open: (() => void)[] = [];
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open.length) {
    e.preventDefault();
    open.at(-1)!();
  }
});

/** Whether Escape has something to close. An editor that has its own use for Escape leaves the key alone while it does. */
export const dismissing = () => open.length > 0;

/** Calls `onDismiss` on Escape or a press outside every element in `inside`. Pass null while closed. */
export function useDismiss(onDismiss: (() => void) | null, ...inside: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!onDismiss) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!inside.some((ref) => ref.current?.contains(e.target as Node))) onDismiss();
    };
    open.push(onDismiss);
    addEventListener("pointerdown", onPointerDown, true);
    return () => {
      open.splice(open.indexOf(onDismiss), 1);
      removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onDismiss]);
}
