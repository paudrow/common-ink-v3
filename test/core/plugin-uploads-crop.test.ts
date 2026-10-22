import { describe, expect, it } from "vitest";
import { moved, ofShape, oriented, placed } from "../../src/web/plugins/uploads/cropping.ts";

const PICTURE = { width: 1200, height: 800 };
const WHOLE = { x: 0, y: 0, width: 1200, height: 800 };
const MIDDLE = { x: 300, y: 200, width: 600, height: 400 };

describe("a crop dragged by a corner, an edge or its inside", () => {
  it("moves the edges a corner or an edge holds, and only those", () => {
    expect(moved(WHOLE, PICTURE, "nw", 120, 40, null)).toEqual({ x: 120, y: 40, width: 1080, height: 760 });
    expect(moved(WHOLE, PICTURE, "se", -280, -160, null)).toEqual({ x: 0, y: 0, width: 920, height: 640 });
    expect(moved(MIDDLE, PICTURE, "e", 50, 999, null)).toEqual({ x: 300, y: 200, width: 650, height: 400 });
    expect(moved(MIDDLE, PICTURE, "n", 999, -50, null)).toEqual({ x: 300, y: 150, width: 600, height: 450 });
  });

  it("moves all of it from inside, at its size, and never out of the picture", () => {
    expect(moved(MIDDLE, PICTURE, "move", 100, -50, null)).toEqual({ x: 400, y: 150, width: 600, height: 400 });
    expect(moved(MIDDLE, PICTURE, "move", 5000, 5000, null)).toEqual({ x: 600, y: 400, width: 600, height: 400 });
    expect(moved(MIDDLE, PICTURE, "move", -5000, 0, null)).toEqual({ x: 0, y: 200, width: 600, height: 400 });
  });

  it("stops at the picture's edge and at a twentieth of its shorter side across", () => {
    expect(moved(MIDDLE, PICTURE, "nw", -5000, -5000, null)).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    expect(moved(MIDDLE, PICTURE, "w", 5000, 0, null)).toEqual({ x: 860, y: 200, width: 40, height: 400 });
    expect(moved(MIDDLE, PICTURE, "s", 0, -5000, null)).toEqual({ x: 300, y: 200, width: 600, height: 40 });
  });

  it("held to a shape, keeps the opposite corner, or the opposite edge centred, and grows only as far as fits", () => {
    expect(moved(MIDDLE, PICTURE, "se", 200, 0, 1)).toEqual({ x: 300, y: 200, width: 600, height: 600 });
    expect(moved(MIDDLE, PICTURE, "nw", -100, -100, 4 / 3)).toEqual({ x: 200, y: 75, width: 700, height: 525 });
    expect(moved(MIDDLE, PICTURE, "se", 5000, 5000, 1)).toEqual({ x: 300, y: 200, width: 600, height: 600 });
    expect(moved(MIDDLE, PICTURE, "e", 0, 0, 1)).toEqual({ x: 300, y: 100, width: 600, height: 600 });
    expect(moved(MIDDLE, PICTURE, "s", 0, 400, 3 / 2)).toEqual({ x: 150, y: 200, width: 900, height: 600 });
    expect(moved(MIDDLE, PICTURE, "s", 0, 400, 3)).toEqual({ x: 0, y: 200, width: 1200, height: 400 });
  });
});

describe("a shape picked for a crop", () => {
  it("is the largest crop of that shape in the picture, centred where the crop was as near as it fits", () => {
    expect(ofShape(PICTURE, WHOLE, 1)).toEqual({ x: 200, y: 0, width: 800, height: 800 });
    expect(ofShape(PICTURE, { x: 0, y: 0, width: 100, height: 100 }, 1)).toEqual({ x: 0, y: 0, width: 800, height: 800 });
    expect(ofShape(PICTURE, WHOLE, 16 / 9)).toEqual({ x: 0, y: 62.5, width: 1200, height: 675 });
  });

  it("stands as the crop does", () => {
    expect(oriented(4 / 3, MIDDLE)).toBe(4 / 3);
    expect(oriented(4 / 3, { x: 0, y: 0, width: 300, height: 800 })).toBe(3 / 4);
    expect(ofShape(PICTURE, { x: 0, y: 0, width: 300, height: 800 }, oriented(4 / 3, { x: 0, y: 0, width: 300, height: 800 }))).toEqual({ x: 0, y: 0, width: 600, height: 800 });
  });
});

describe("where a cropped picture is drawn in its room", () => {
  it("is larger than the room by as much as the crop is smaller than the picture, moved by where the crop starts", () => {
    expect(placed({ x: 300, y: 200, width: 600, height: 400 }, PICTURE)).toEqual({ left: "-50%", top: "-50%", width: "200%", height: "200%" });
    expect(placed({ x: 0, y: 0, width: 1200, height: 800 }, PICTURE)).toEqual({ left: "0%", top: "0%", width: "100%", height: "100%" });
    expect(placed({ x: 600, y: 0, width: 600, height: 800 }, PICTURE)).toEqual({ left: "-100%", top: "0%", width: "200%", height: "100%" });
  });
});
