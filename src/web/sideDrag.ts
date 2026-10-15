/** A side of the window that folds: how narrow and how wide it is dragged while open, and how wide the bar is that it folds to. */
export interface Folds {
  min: number;
  max: number;
  folded: number;
}

/**
 * A side while its edge is dragged. `follows` is whether its width is where the pointer is: one
 * opened by the drag is as wide as it was kept until the pointer is out that far.
 */
export interface Dragged {
  open: boolean;
  width: number;
  follows: boolean;
}

/** How far past the place a side folds at the pointer goes before it does, either way, so a hand held there doesn't fold and open it over and over. */
const SLACK = 12;

/** The width asked for at which a side folds or opens: half way between its bar and its least width. */
export const foldsAt = ({ min, folded }: Folds) => (folded + min) / 2;

export const grabbed = (open: boolean, width: number): Dragged => ({ open, width, follows: open });

/**
 * The side once the pointer asks for it to be `asked` wide. `kept` is how wide it was when the drag
 * began, which is what it is again when it folds, so opening it later brings that width back.
 */
export function draggedTo(side: Folds, kept: number, was: Dragged, asked: number): Dragged {
  const fold = foldsAt(side);
  if (was.open ? asked < fold - SLACK : asked <= fold + SLACK) return { open: false, width: kept, follows: false };
  const follows = was.follows || asked >= kept;
  return { open: true, width: follows ? Math.min(side.max, Math.max(side.min, asked)) : kept, follows };
}
