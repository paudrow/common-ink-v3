/**
 * How a member has arranged their Dashboard: which panels it shows, in what order, and how big each
 * is. Panels flow into a grid of two columns in this order, one column in a narrow window. It is kept
 * as the Dashboard's remembered setting, a list of words such as `events small`, and read back
 * through {@link readLayout}, which is where anything written by hand or by an older version is made
 * sound.
 */

/** Each size as columns and rows of the grid. */
export const SIZES = {
  small: { cols: 1, rows: 1 },
  wide: { cols: 2, rows: 1 },
  tall: { cols: 1, rows: 2 },
  large: { cols: 2, rows: 2 },
} as const;

export type Size = keyof typeof SIZES;

export const SIZE_NAMES: Record<Size, string> = { small: "Small", wide: "Wide", tall: "Tall", large: "Large" };

export interface Placed {
  id: string;
  size: Size;
}

export type Layout = readonly Placed[];

export type Arrange =
  /** Takes a panel out of the order and puts it back at index `to` of what is left. */
  | { type: "move"; id: string; to: number }
  | { type: "resize"; id: string; size: Size }
  /** Puts a panel the Dashboard isn't showing at the end. */
  | { type: "add"; id: string; size: Size }
  | { type: "remove"; id: string };

const isSize = (word: string): word is Size => Object.hasOwn(SIZES, word);

export const sizeOf = (cols: number, rows: number): Size => (cols > 1 ? (rows > 1 ? "large" : "wide") : rows > 1 ? "tall" : "small");

/** The layout once `action` is done. One that names a panel not shown, or one shown already for `add`, changes nothing. */
export function arrange(layout: Layout, action: Arrange): Layout {
  const at = layout.findIndex((p) => p.id === action.id);
  if (action.type === "add") return at === -1 ? [...layout, { id: action.id, size: action.size }] : layout;
  if (at === -1) return layout;
  if (action.type === "remove") return layout.filter((p) => p.id !== action.id);
  if (action.type === "resize") return layout[at]!.size === action.size ? layout : layout.map((p) => (p.id === action.id ? { ...p, size: action.size } : p));
  const rest = layout.filter((p) => p.id !== action.id);
  const to = Math.max(0, Math.min(rest.length, Math.trunc(action.to)));
  if (to === at) return layout;
  return [...rest.slice(0, to), layout[at]!, ...rest.slice(to)];
}

/** The size one step on from `size` by an arrow key: right and left for its width, down and up for its height. */
export function stepSize(size: Size, key: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp"): Size {
  const { cols, rows } = SIZES[size];
  if (key === "ArrowRight" || key === "ArrowLeft") return sizeOf(key === "ArrowRight" ? 2 : 1, rows);
  return sizeOf(cols, key === "ArrowDown" ? 2 : 1);
}

/**
 * The layout the words say, given the panels there are and each one's own size. A word naming a
 * panel there isn't, as one whose plugin is off or gone, is left out, and the rest keep their order;
 * a panel named twice is shown once, where it is first named; a size that isn't one is the panel's own.
 */
export function readLayout(words: readonly string[], panels: ReadonlyMap<string, Size>): Layout {
  const layout: Placed[] = [];
  for (const word of words) {
    const [id = "", size = ""] = word.trim().split(/\s+/);
    const own = panels.get(id);
    if (!own || layout.some((p) => p.id === id)) continue;
    layout.push({ id, size: isSize(size) ? size : own });
  }
  return layout;
}

export const writeLayout = (layout: Layout): string[] => layout.map(({ id, size }) => `${id} ${size}`);
