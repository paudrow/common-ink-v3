import { useEffect, type RefObject } from "react";

/** Open menus and popovers, innermost last; Escape closes only the innermost. */
const open: (() => void)[] = [];
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open.length) {
    e.preventDefault();
    open.at(-1)!();
  }
});

/** Calls `onDismiss` on Escape or a press outside every element `inside` gives, until what it returns is called. */
export function dismissOn(onDismiss: () => void, inside: () => readonly (HTMLElement | null | undefined)[]): () => void {
  const onPointerDown = (e: PointerEvent) => {
    if (!inside().some((el) => el?.contains(e.target as Node))) onDismiss();
  };
  open.push(onDismiss);
  addEventListener("pointerdown", onPointerDown, true);
  return () => {
    open.splice(open.indexOf(onDismiss), 1);
    removeEventListener("pointerdown", onPointerDown, true);
  };
}

/** Calls `onDismiss` on Escape or a press outside every element in `inside`. Pass null while closed. */
export function useDismiss(onDismiss: (() => void) | null, ...inside: RefObject<HTMLElement | null>[]) {
  useEffect(() => (onDismiss ? dismissOn(onDismiss, () => inside.map((ref) => ref.current)) : undefined), [onDismiss]);
}
