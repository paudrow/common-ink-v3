// The Chrome Web Store takes these pictures only at exactly these sizes. `npm run store:assets` makes them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STORE = join(import.meta.dirname, "../../extension/store");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, which always comes first. */
function size(file: string): { width: number; height: number } {
  const png = readFileSync(join(STORE, file));
  assert.deepEqual(png.subarray(0, 8), SIGNATURE, `${file} is not a PNG`);
  assert.equal(png.toString("latin1", 12, 16), "IHDR", `${file} has no IHDR first`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

for (const [file, width, height] of [
  ["screenshot-1-clip.png", 1280, 800],
  ["screenshot-2-note.png", 1280, 800],
  ["screenshot-3-selection.png", 1280, 800],
  ["promo-small-440x280.png", 440, 280],
  ["promo-marquee-1400x560.png", 1400, 560],
] as const) {
  test(`${file} is ${width}x${height}`, () => assert.deepEqual(size(file), { width, height }));
}
