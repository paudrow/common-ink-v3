import { describe, expect, it } from "vitest";
import { chordOf, onPlatform } from "../../src/web/keybindings.ts";
import { KEYS } from "../../src/web/plugins/vim/keys.ts";
import { land, toward, type Box } from "../../src/web/plugins/vim/moving.ts";

describe("moving through a list", () => {
  it("steps a row at a time and stops at the ends", () => {
    expect(land("down", 0, 5, 0, 2)).toBe(1);
    expect(land("down", 4, 5, 0, 2)).toBe(4);
    expect(land("up", 3, 5, 0, 2)).toBe(2);
    expect(land("up", 0, 5, 0, 2)).toBe(0);
  });

  it("goes to the first and the last row from anywhere, and from outside the list", () => {
    expect(land("first", 3, 5, 2, 2)).toBe(0);
    expect(land("last", 1, 5, 2, 2)).toBe(4);
    expect(land("first", -1, 5, 2, 2)).toBe(0);
    expect(land("last", -1, 5, 2, 2)).toBe(4);
  });

  it("moves half a page at a time, and no further than the ends", () => {
    expect(land("halfDown", 1, 30, 0, 7)).toBe(8);
    expect(land("halfDown", 26, 30, 0, 7)).toBe(29);
    expect(land("halfUp", 10, 30, 0, 7)).toBe(3);
    expect(land("halfUp", 4, 30, 0, 7)).toBe(0);
  });

  it("goes into a list on the row it was left on, whichever way the first step is", () => {
    expect(land("down", -1, 5, 3, 2)).toBe(3);
    expect(land("up", -1, 5, 3, 2)).toBe(3);
    expect(land("halfDown", -1, 5, 0, 2)).toBe(0);
    // The row it was left on is gone, and the list is shorter now.
    expect(land("down", -1, 2, 7, 2)).toBe(1);
  });

  it("goes nowhere in a list with no rows", () => {
    expect(land("down", -1, 0, 0, 1)).toBe(-1);
    expect(land("last", -1, 0, 0, 1)).toBe(-1);
  });
});

describe("moving between regions of the window", () => {
  const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
  // A sidebar, two sides of a split, and an inspector, left to right.
  const row = [box(0, 0, 200, 700), box(200, 0, 600, 700), box(600, 0, 1000, 700), box(1000, 0, 1280, 700)];

  it("goes to the region right beside the one the keys are in, and not past it", () => {
    expect(toward(row, 1, "left")).toBe(0);
    expect(toward(row, 1, "right")).toBe(2);
    expect(toward(row, 2, "right")).toBe(3);
    expect(toward(row, 3, "left")).toBe(2);
    expect(toward(row, 0, "right")).toBe(1);
  });

  it("goes from a panel lying over the page to the part of the page under it, on the side the page reaches past it", () => {
    // A sidebar, the page, and a panel over the page's right end, beside the bar.
    const over = [box(0, 0, 200, 700), box(200, 0, 1236, 700), box(980, 0, 1236, 700)];
    expect(toward(over, 2, "left")).toBe(1);
    expect(toward(over, 2, "right")).toBe(-1);
    expect(toward(over, 1, "left")).toBe(0);
  });

  it("stays where it is when nothing is on that side", () => {
    expect(toward(row, 0, "left")).toBe(-1);
    expect(toward(row, 3, "right")).toBe(-1);
    expect(toward(row, 1, "up")).toBe(-1);
    expect(toward(row, 1, "down")).toBe(-1);
  });

  it("goes up and down a stack, and of two regions as near takes the one that shares more of the edge", () => {
    const stacked = [box(0, 0, 200, 700), box(200, 0, 1000, 300), box(200, 300, 560, 700), box(560, 300, 1000, 700)];

    expect(toward(stacked, 1, "down")).toBe(3);
    expect(toward(stacked, 2, "up")).toBe(1);
    expect(toward(stacked, 3, "left")).toBe(2);
    expect(toward(stacked, 0, "right")).toBe(2);
  });
});

describe("vim's keys outside a note", () => {
  const typed = (keys: string) => keys.split(" ").every((chord) => !/(mod|ctrl|alt)\+/.test(chord) && chord !== "escape");

  it("has no letter on a surface where letters are typed", () => {
    const typedInto = KEYS.filter((k) => k.surface === "field" || k.surface === "fieldOfList" || k.surface === "window");

    expect(typedInto.flatMap((k) => k.keys.filter(typed))).toEqual([]);
  });

  it("gives each key to one command, on a Mac and off one", () => {
    for (const mac of [true, false]) {
      const keys = KEYS.flatMap((k) => k.keys.map((key) => onPlatform(key, mac)));
      expect(keys.filter((key, i) => keys.indexOf(key) !== i), mac ? "on a Mac" : "off a Mac").toEqual([]);
    }
  });

  it("goes to the search box with / on a keyboard that types it with Shift, as a German one does with Shift and 7", () => {
    const pressed = chordOf({ key: "/", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, true);

    expect(KEYS.find((k) => k.id === "search")!.keys).toContain(pressed);
  });

  it("begins no sequence with a key that runs a command by itself, which would never wait for the rest", () => {
    const keys = KEYS.flatMap((k) => k.keys);

    expect(keys.filter((key) => keys.some((other) => other.startsWith(`${key} `)))).toEqual([]);
  });
});
