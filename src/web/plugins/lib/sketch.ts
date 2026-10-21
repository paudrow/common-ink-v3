/** The gray a sketch is drawn in, which reads on a light page and a dark one alike. */
const INK = "#8b8f98";

/**
 * A small picture of what a menu item makes, for its preview: SVG shapes on a canvas 200 wide and
 * 84 tall, as wide for its height as the preview pane draws a picture. Shapes are drawn in gray
 * unless they say otherwise.
 */
export const sketch = (shapes: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 84" fill="${INK}" stroke="${INK}" stroke-width="0" font-family="system-ui, sans-serif">${shapes}</svg>`)}`;

/** A line of text in a sketch, standing for words: a rounded bar. */
export const words = (x: number, y: number, width: number, height = 6) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" opacity="0.45"/>`;

/** Writing in a sketch, as a heading or a clock reads. */
export const lettering = (x: number, y: number, size: number, text: string, more = "") => `<text x="${x}" y="${y}" font-size="${size}" ${more}>${text}</text>`;

/** A box drawn in outline. */
export const outline = (x: number, y: number, width: number, height: number, radius = 3) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="none" stroke-width="2"/>`;

/** A box filled lightly, as a card or a code block is. */
export const panel = (x: number, y: number, width: number, height: number, radius = 4) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" opacity="0.18"/>`;
