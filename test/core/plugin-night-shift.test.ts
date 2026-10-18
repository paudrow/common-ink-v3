import { describe, expect, it } from "vitest";
import { nightShift } from "../../src/web/plugins/nightShift/index.ts";
import { isNight, sunTimes } from "../../src/web/plugins/nightShift/sun.ts";
import { GREEN, STRENGTHS, colorsIn, contrast, nightTokens, solid, tintMatrix, tone } from "../../src/web/plugins/nightShift/theme.ts";

describe("night shift's colors", () => {
  it("has no blue in any token, and no more green than the strength lets in", () => {
    for (const strength of STRENGTHS) {
      const colors = Object.entries(nightTokens(strength)).flatMap(([token, value]) => colorsIn(value).map((color) => ({ token, color })));
      expect(colors.length).toBeGreaterThan(30);
      for (const { token, color: [red, green, blue] } of colors) {
        expect(blue, `${token} at ${strength}`).toBe(0);
        // Green is a share of the red beside it, which is how amber is red with some green. Black has neither.
        expect(green, `${token} at ${strength}`).toBeLessThanOrEqual(Math.round(red * GREEN[strength]));
      }
      if (strength === "deep red") expect(colors.every(({ color: [, green] }) => green === 0)).toBe(true);
    }
  });

  it("lets in more green as the strength goes from deep red to amber, and tops out at amber", () => {
    const greenest = STRENGTHS.map((strength) => Math.max(...Object.values(nightTokens(strength)).flatMap((v) => colorsIn(v).map(([r, g]) => (r >= 100 ? g / r : 0)))));
    expect(greenest[0]).toBe(0);
    expect(greenest).toEqual([...greenest].sort((a, b) => a - b));
    expect(new Set(greenest).size).toBe(STRENGTHS.length);
    expect(greenest.at(-1)!).toBeLessThan(0.61); // A little over 0.6 is a byte rounded up.
  });

  it("makes a color of any brightness out of red alone at the deep end", () => {
    expect(tone(1, "deep red")).toEqual([255, 0, 0]);
    expect(tone(0, "amber")).toEqual([0, 0, 0]);
    expect(tone(1, "amber")).toEqual([255, 153, 0]);
  });

  // That it sets every color token the stylesheet's :root has is checked in a browser, in test/browser/night-shift.spec.ts: the stylesheet is not something these tests can read.
  it("sets the same tokens at every strength", () => {
    const names = Object.keys(nightTokens("red")).sort();
    for (const strength of STRENGTHS) expect(Object.keys(nightTokens(strength)).sort()).toEqual(names);
  });

  it("keeps body text readable on every background it is on: WCAG AA, 4.5 to 1", () => {
    for (const strength of STRENGTHS) {
      const t = nightTokens(strength);
      const on = (text: string, background: string) => contrast(solid(t[text]!), solid(t[background]!));
      for (const background of ["--bg", "--bg-elev", "--bg-side", "--selection"]) expect(on("--ink", background), `ink on ${background} at ${strength}`).toBeGreaterThanOrEqual(4.5);
      for (const background of ["--bg", "--bg-elev", "--bg-side"]) expect(on("--accent", background), `accent on ${background} at ${strength}`).toBeGreaterThanOrEqual(4.5);
      // A button: the ink on it, on the accent.
      expect(on("--on-accent", "--accent"), `button at ${strength}`).toBeGreaterThanOrEqual(4.5);
      // Secondary text, which red light alone can't make both AA and dimmer than the body at the deep end, is for large text there: 3 to 1.
      expect(on("--muted", "--bg"), `muted at ${strength}`).toBeGreaterThanOrEqual(3);
      expect(on("--danger", "--bg"), `danger at ${strength}`).toBeGreaterThanOrEqual(4.5);
      for (const token of Object.keys(t).filter((k) => k.startsWith("--tok-"))) expect(on(token, "--bg"), `${token} at ${strength}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("is black behind everything, with its backgrounds darker than the text on them by a wide margin", () => {
    for (const strength of STRENGTHS) {
      const t = nightTokens(strength);
      expect(solid(t["--bg"]!)).toEqual([0, 0, 0]);
      for (const background of ["--bg-elev", "--bg-side", "--selection"]) expect(Math.max(...solid(t[background]!))).toBeLessThanOrEqual(60);
    }
  });

  it("tints a picture to red with no blue in it, the more green the stronger the strength", () => {
    for (const strength of STRENGTHS) {
      const rows = tintMatrix(strength).split(" ").map(Number);
      expect(rows).toHaveLength(20);
      // Red, green, blue and alpha out. Blue out is nothing, whatever came in; alpha is kept.
      expect(rows.slice(10, 15)).toEqual([0, 0, 0, 0, 0]);
      expect(rows.slice(15)).toEqual([0, 0, 0, 1, 0]);
      expect(rows.slice(5, 8).every((w, i) => Math.abs(w - rows[i]! * GREEN[strength]) < 0.001)).toBe(true);
    }
  });
});

describe("the Night shift plugin", () => {
  it("is off until it is turned on, and has a toggle, a strength and a tint, which starts off", () => {
    expect(nightShift.enabledByDefault).toBe(false);
    expect(nightShift.settings!.strength).toMatchObject({ type: "string", enum: STRENGTHS });
    expect(nightShift.settings!.tint).toMatchObject({ type: "boolean", default: false });
    expect(nightShift.settings!.on).toMatchObject({ remembered: true });
    expect(nightShift.settings!.follow).toMatchObject({ type: "boolean", default: false, remembered: true });
    expect(nightShift.settings!.place).toMatchObject({ type: "string", default: "", remembered: true });
  });
});

describe("sunset and sunrise", () => {
  it("puts sunrise near 06:00 and sunset near 18:00 on the equator at the March equinox", () => {
    const times = sunTimes(0, 0, new Date("2026-03-20T12:00:00Z"));
    expect(times).not.toBe("day");
    expect(times).not.toBe("night");
    if (times === "day" || times === "night") return;
    const hour = (ms: number) => new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60;
    expect(hour(times.rise)).toBeGreaterThan(5.5);
    expect(hour(times.rise)).toBeLessThan(6.5);
    expect(hour(times.set)).toBeGreaterThan(17.5);
    expect(hour(times.set)).toBeLessThan(18.5);
    expect(isNight(0, 0, new Date(times.rise - 60_000))).toBe(true);
    expect(isNight(0, 0, new Date(times.rise + 60_000))).toBe(false);
    expect(isNight(0, 0, new Date(times.set + 60_000))).toBe(true);
  });

  it("is night through a polar winter and day through a polar summer", () => {
    expect(sunTimes(78, 15, new Date("2026-12-21T12:00:00Z"))).toBe("night");
    expect(sunTimes(78, 15, new Date("2026-06-21T12:00:00Z"))).toBe("day");
    expect(isNight(78, 15, new Date("2026-12-21T12:00:00Z"))).toBe(true);
    expect(isNight(78, 15, new Date("2026-06-21T12:00:00Z"))).toBe(false);
  });
});
