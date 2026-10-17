/**
 * Night shift's colors: the app's design tokens, in red light and nothing else.
 *
 * Every color here has no blue in it at all, and green only as far as the strength allows. Black is the
 * absence of light, so backgrounds are black, and everything that is drawn is a brightness of one hue:
 * red at the deep end, going to amber at the other as green is let in. A color is `tone(level, strength)`,
 * where `level` is how bright it is (0 black, 1 the brightest red) and the strength says how much green
 * may go with the red.
 */

/** From deep red to warm amber. */
export const STRENGTHS = ["deep red", "red", "ember", "amber"] as const;
export type Strength = (typeof STRENGTHS)[number];

/** The most green a color may have, as a share of its red. Deep red has none; amber is red with about 60% green, which reads as an orange amber. */
export const GREEN: Readonly<Record<Strength, number>> = { "deep red": 0, red: 0.1, ember: 0.32, amber: 0.6 };

type Rgb = readonly [number, number, number];

/** A color of this brightness: all red, and `share` of the green the strength allows. Never any blue. */
export function tone(level: number, strength: Strength, share = 1): Rgb {
  const red = Math.round(255 * level);
  return [red, Math.round(red * GREEN[strength] * share), 0];
}

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
const withAlpha = ([r, g, b]: Rgb, alpha: number) => `rgb(${r} ${g} ${b} / ${alpha})`;

/**
 * What a theme sets: each token of the stylesheet's `:root`, and the tokens night shift adds for what the
 * stylesheet colors by hand (a calendar's, a code block's, a column's swatch). The same names whatever the strength.
 */
export function nightTokens(strength: Strength): Readonly<Record<string, string>> {
  const t = (level: number, share = 1) => tone(level, strength, share);
  const ink = t(0.97);
  const muted = t(0.82);
  const accent = t(1);
  const arrow = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%23${hex(muted).slice(1)}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E")`;
  const ring = withAlpha(t(0.3), 0.5);
  return {
    "--bg": hex(t(0)),
    "--bg-elev": hex(t(0.07)),
    "--bg-side": hex(t(0.035)),
    "--ink": hex(ink),
    "--muted": hex(muted),
    "--faint": hex(t(0.52)),
    "--select-arrow": arrow,
    "--line": hex(t(0.17)),
    "--line-strong": hex(t(0.3)),
    "--hover": withAlpha(t(1), 0.1),
    "--accent": hex(accent),
    "--accent-soft": withAlpha(accent, 0.16),
    "--accent-ink": hex(t(1)),
    "--on-accent": hex(t(0)),
    "--selection": hex(t(0.16)),
    "--code-bg": withAlpha(t(1), 0.05),
    "--danger": hex(t(1)),
    "--added": hex(t(0.9)),
    "--added-soft": withAlpha(t(0.9), 0.16),
    "--removed-soft": withAlpha(t(0.45), 0.2),
    "--warn": hex(t(0.9)),
    "--warn-ink": hex(t(0.9)),
    "--cal-tint": "26%",
    "--shadow": `0 18px 48px -12px rgb(0 0 0 / 0.8), 0 0 0 1px ${ring}`,
    "--shadow-lg": `0 24px 60px -12px rgb(0 0 0 / 0.8), 0 0 0 1px ${ring}`,
    "--shadow-sm": "0 1px 2px rgb(0 0 0 / 0.5), 0 4px 14px -6px rgb(0 0 0 / 0.6)",
    // What code in a note is colored with. Only a brightness tells most of them apart, and the greens of a stronger strength tell the rest.
    "--tok-keyword": hex(t(1, 0)),
    "--tok-string": hex(t(0.85, 1)),
    "--tok-comment": hex(t(0.74, 0.5)),
    "--tok-number": hex(t(0.97, 1)),
    "--tok-type": hex(t(0.88, 0.6)),
    "--tok-property": hex(t(0.82, 0.25)),
    "--tok-invalid": hex(t(0.76, 0)),
    // What the stylesheet colors by name: a column's swatch, whose writing it, a person's initials.
    "--night-swatch-red": hex(t(1, 0)),
    "--night-swatch-orange": hex(t(0.9, 1)),
    "--night-swatch-yellow": hex(t(0.8, 1)),
    "--night-swatch-green": hex(t(0.7, 0.6)),
    "--night-swatch-blue": hex(t(0.6, 0.3)),
    "--night-swatch-purple": hex(t(0.5, 0.15)),
    "--night-swatch-pink": hex(t(0.4, 0)),
    "--night-swatch-gray": hex(t(0.3, 0.5)),
    // Laid over a frame the app can't reach inside, where it multiplies what shows through: a page keeps its brightness in red and the strength's green.
    "--night-overlay": hex(t(1)),
  };
}

/**
 * The matrix of the filter that tints a picture: its brightness becomes red, and the strength's green goes with it. Blue is
 * dropped whatever the picture holds. Rows are red, green, blue and alpha out, columns red, green, blue, alpha and an offset in.
 */
export function tintMatrix(strength: Strength): string {
  const [r, g, b] = [0.2126, 0.7152, 0.0722];
  const red = 0.95;
  const row = (scale: number) => [r, g, b].map((w) => (w * scale).toFixed(4)).join(" ") + " 0 0";
  return `${row(red)} ${row(red * GREEN[strength])} 0 0 0 0 0 0 0 0 1 0`;
}

/** The relative luminance of a color, as WCAG 2 has it. */
export function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** The contrast ratio of two colors, from 1 to 21. 4.5 is WCAG AA for body text. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colors a token's value holds, as it is written: `#rrggbb`, `%23rrggbb` in a picture's address, or `rgb(r g b / a)`. */
export function colorsIn(value: string): Rgb[] {
  const found: Rgb[] = [];
  for (const m of value.matchAll(/(?:#|%23)([0-9a-f]{6})\b/gi)) found.push([0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as unknown as Rgb);
  for (const m of value.matchAll(/rgb\((\d+) (\d+) (\d+)/g)) found.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  return found;
}

/** A token's value as one solid color, for the ones that are one. */
export function solid(value: string): Rgb {
  const [color] = colorsIn(value);
  if (!color) throw new Error(`${value} is not a color`);
  return color;
}
