import type { Crop } from "../../plugin-api.ts";

export interface Size {
  width: number;
  height: number;
}

/** What of a crop a press moves: a corner its two edges, an edge itself, and `move` all of it, at its size. */
export type Grip = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** The shapes a crop can be held to, as wide over tall. Free holds it to none. */
export const SHAPES = [
  { name: "Free", ratio: null },
  { name: "Square", ratio: 1 },
  { name: "4:3", ratio: 4 / 3 },
  { name: "16:9", ratio: 16 / 9 },
] as const;

/** The narrowest and shortest a crop is made, a twentieth of the picture's shorter side. */
export const leastOf = ({ width, height }: Size) => Math.max(1, Math.min(width, height) / 20);

/** How far one press of an arrow moves a crop's edge along a side `side` pixels long: a hundredth of it, or a tenth when `big`. */
export const stepOf = (side: number, big: boolean) => Math.max(1, side * (big ? 0.1 : 0.01));

const clamp = (n: number, least: number, most: number) => Math.min(most, Math.max(least, n));

/** A shape turned to stand as `crop` does: a wide one is tall for a crop taller than it is wide. */
export const oriented = (ratio: number, crop: Crop) => (crop.height > crop.width ? 1 / ratio : ratio);

/**
 * `start` with what `grip` holds moved `dx` and `dy` pixels of the picture, kept in the picture
 * `frame`, and no narrower or shorter than {@link leastOf} it across an edge that moved. Held to
 * `ratio`, a corner keeps its opposite corner where it was and an edge its opposite edge, centred
 * across it, and the crop is as large as the move makes it that fits.
 */
export function moved(start: Crop, frame: Size, grip: Grip, dx: number, dy: number, ratio: number | null): Crop {
  if (grip === "move") return { ...start, x: clamp(start.x + dx, 0, frame.width - start.width), y: clamp(start.y + dy, 0, frame.height - start.height) };
  const least = leastOf(frame);
  let [left, top, right, bottom] = [start.x, start.y, start.x + start.width, start.y + start.height];
  if (grip.includes("w")) left = clamp(left + dx, 0, right - least);
  if (grip.includes("e")) right = clamp(right + dx, left + least, frame.width);
  if (grip.includes("n")) top = clamp(top + dy, 0, bottom - least);
  if (grip.includes("s")) bottom = clamp(bottom + dy, top + least, frame.height);
  if (!ratio) return { x: left, y: top, width: right - left, height: bottom - top };

  const across = grip.includes("w") ? -1 : grip.includes("e") ? 1 : 0;
  const down = grip.includes("n") ? -1 : grip.includes("s") ? 1 : 0;
  let width = right - left;
  let height = bottom - top;
  if (across && down) [width, height] = width / height > ratio ? [width, width / ratio] : [height * ratio, height];
  else if (across) height = width / ratio;
  else width = height * ratio;
  const [fromX, fromY] = [across < 0 ? start.x + start.width : start.x, down < 0 ? start.y + start.height : start.y];
  const roomX = across > 0 ? frame.width - fromX : across < 0 ? fromX : frame.width;
  const roomY = down > 0 ? frame.height - fromY : down < 0 ? fromY : frame.height;
  if (width > roomX) [width, height] = [roomX, roomX / ratio];
  if (height > roomY) [width, height] = [roomY * ratio, roomY];
  const place = (by: number, from: number, size: number, centre: number, room: number) => (by > 0 ? from : by < 0 ? from - size : clamp(centre - size / 2, 0, room - size));
  return {
    x: place(across, fromX, width, start.x + start.width / 2, frame.width),
    y: place(down, fromY, height, start.y + start.height / 2, frame.height),
    width,
    height,
  };
}

/** The largest crop of `ratio` in the picture `frame`, centred where `around` is as near as it fits. */
export function ofShape(frame: Size, around: Crop, ratio: number): Crop {
  const width = Math.min(frame.width, frame.height * ratio);
  const height = width / ratio;
  return {
    x: clamp(around.x + around.width / 2 - width / 2, 0, frame.width - width),
    y: clamp(around.y + around.height / 2 - height / 2, 0, frame.height - height),
    width,
    height,
  };
}

/** Where a picture `size` large is drawn, in percents of its room, for `crop` of it to fill the room. */
export const placed = (crop: Crop, size: Size) => ({
  left: `${(-crop.x / crop.width) * 100}%`,
  top: `${(-crop.y / crop.height) * 100}%`,
  width: `${(size.width / crop.width) * 100}%`,
  height: `${(size.height / crop.height) * 100}%`,
});
