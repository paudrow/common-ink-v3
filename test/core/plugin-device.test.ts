import { describe, expect, it } from "vitest";
import { lacks, seen, type Device } from "../../src/web/device.ts";

const phone: Device = { phone: true, touch: true, keyboard: "unknown" };
const laptop: Device = { phone: false, touch: false, keyboard: "unknown" };

describe("the keyboard a device has", () => {
  it("is attached once a key arrives that no on-screen keyboard sends", () => {
    expect(seen("unknown", { kind: "key", key: "a", chord: false })).toBe("unknown");
    expect(seen("unknown", { kind: "key", key: "Enter", chord: false })).toBe("unknown");
    expect(seen("unknown", { kind: "key", key: "Escape", chord: false })).toBe("attached");
    expect(seen("onScreen", { kind: "key", key: "ArrowDown", chord: false })).toBe("attached");
    expect(seen("onScreen", { kind: "key", key: "Tab", chord: false })).toBe("attached");
    expect(seen("unknown", { kind: "key", key: "k", chord: true })).toBe("attached");
  });

  it("is on screen once the page gets a keyboard's height shorter while the member types", () => {
    expect(seen("attached", { kind: "viewport", shorterBy: 336, typing: true })).toBe("onScreen");
    expect(seen("attached", { kind: "viewport", shorterBy: 336, typing: false }), "the page scrolled, with nothing typed in").toBe("attached");
    expect(seen("attached", { kind: "viewport", shorterBy: 55, typing: true }), "the bar of shortcuts over an attached keyboard").toBe("attached");
  });
});

describe("what a device lacks", () => {
  it("lacks a keyboard on a touch screen until one is attached, unless the member keeps those plugins on", () => {
    expect(lacks("keyboard", phone, false)).toBe("keyboard");
    expect(lacks("keyboard", { ...phone, keyboard: "onScreen" }, false)).toBe("keyboard");
    expect(lacks("keyboard", { ...phone, keyboard: "attached" }, false)).toBe(null);
    expect(lacks("keyboard", phone, true)).toBe(null);
    expect(lacks("keyboard", laptop, false), "a computer has a keyboard whether or not one was seen").toBe(null);
  });

  it("lacks room at a phone's width, whatever is plugged in", () => {
    expect(lacks("room", { ...phone, keyboard: "attached" }, true)).toBe("room");
    expect(lacks("room", laptop, false)).toBe(null);
    expect(lacks(undefined, phone, false)).toBe(null);
  });
});
