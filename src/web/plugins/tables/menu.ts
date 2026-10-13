export interface MenuItem {
  label: string;
  /** Left out of reach, and shown so, when there is nothing for it to do here. */
  disabled: boolean;
  run: () => void;
}

let closeOpen: (() => void) | undefined;

/**
 * A menu at a point of the window, as a right-click opens. The arrow keys, Home and End move
 * through it, Enter or a click picks, and Escape, Tab or a press anywhere else closes it. `closed`
 * is told when it goes without anything picked, so the keyboard can be handed back.
 */
export function openMenu(label: string, { x, y }: { x: number; y: number }, items: readonly MenuItem[], closed: () => void) {
  closeOpen?.();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  let open = true;
  const close = () => {
    // Taking the menu out takes the keyboard from it, which would close it again.
    if (!open) return;
    open = false;
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    closeOpen = undefined;
  };
  const outside = (event: MouseEvent) => {
    if (menu.contains(event.target as Node)) return;
    close();
    closed();
  };
  closeOpen = close;
  for (const { label, disabled, run } of items) {
    const item = menu.appendChild(document.createElement("button"));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.disabled = disabled;
    item.addEventListener("click", () => {
      close();
      run();
    });
  }
  menu.addEventListener("keydown", (event) => {
    const within = [...menu.querySelectorAll<HTMLButtonElement>("button:enabled")];
    const at = within.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: within.length - 1 }[event.key];
    if (to !== undefined) within[(to + within.length) % within.length]?.focus();
    else if (event.key === "Escape" || event.key === "Tab") {
      close();
      closed();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  // The keyboard taken elsewhere, by the palette or another pane, closes it, and is left where it went.
  menu.addEventListener("focusout", (event) => {
    if (!menu.contains(event.relatedTarget as Node | null)) close();
  });
  document.body.append(menu);
  // Kept inside the window: a menu opened near its right or bottom edge opens back from it.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
  document.addEventListener("mousedown", outside, true);
  menu.querySelector<HTMLButtonElement>("button:enabled")?.focus();
}
