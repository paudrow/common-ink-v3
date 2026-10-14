/**
 * The inspector's side of the window: which panel the member last used, whether it is showing, and
 * whether it is pinned beside the page or lies over it until they go elsewhere. A panel is named
 * by its view's id. Nothing here depends on what the editor area has in front.
 */
export interface Side {
  /** The panel last used, or null before any was. */
  panel: string | null;
  open: boolean;
  pinned: boolean;
}

export type SideAction =
  /** An icon in the bar, or a panel's own command: shows that panel, or closes it if it is the one showing. */
  | { type: "pick"; panel: string }
  /** Toggle inspector: closes what is showing, or shows the panel last used. */
  | { type: "toggle" }
  /** A press outside it, or Escape. Only a panel that is not pinned goes. */
  | { type: "dismiss" }
  | { type: "pin" }
  /** The inspector's edge dragged in to its bar, or out of it: out is a panel beside the page. */
  | { type: "fold"; folded: boolean };

export const CLOSED: Side = { panel: null, open: false, pinned: false };

/** The panel that shows, of the ones there are: none while it is closed, or while the one last used is a plugin's that is off. */
export const showing = (side: Side, panels: readonly string[]) => (side.open && side.panel !== null && panels.includes(side.panel) ? side.panel : null);

/** How the panel that shows is laid out. */
export const layoutOf = (side: Side, panels: readonly string[]) => (showing(side, panels) === null ? "closed" : side.pinned ? "pinned" : "temporary");

export function reduce(side: Side, action: SideAction, panels: readonly string[]): Side {
  const shown = showing(side, panels);
  /** The panel last used, or the first there is for a member who has used none or whose last one is gone. */
  const last = side.panel !== null && panels.includes(side.panel) ? side.panel : (panels[0] ?? null);
  const close = { ...side, open: false };
  switch (action.type) {
    case "pick":
      if (!panels.includes(action.panel)) return side;
      return shown === action.panel ? close : { ...side, panel: action.panel, open: true };
    case "toggle":
      return shown !== null ? close : last === null ? side : { ...side, panel: last, open: true };
    case "dismiss":
      return shown !== null && !side.pinned ? close : side;
    case "pin":
      return { ...side, pinned: !side.pinned };
    case "fold":
      if (action.folded) return shown !== null ? close : side;
      return last === null ? side : { panel: last, open: true, pinned: true };
  }
}

/**
 * What was kept in the browser, as a side to begin from. A panel that lay over the page is not
 * there after a reload; a pinned one is. With nothing kept, or something else kept under its name,
 * it begins as `fresh`.
 */
export function restored(kept: unknown, fresh: Side): Side {
  if (typeof kept !== "object" || kept === null) return fresh;
  const { panel, open, pinned } = kept as Record<string, unknown>;
  if ((panel !== null && typeof panel !== "string") || typeof open !== "boolean" || typeof pinned !== "boolean") return fresh;
  return { panel, pinned, open: open && pinned && panel !== null };
}
