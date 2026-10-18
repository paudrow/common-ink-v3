import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import * as esbuild from "esbuild";

const out = "extension/dist";
await mkdir(out, { recursive: true });

await esbuild.build({
  entryPoints: {
    background: "extension/src/background.ts",
    content: "extension/src/content.ts",
    popup: "extension/src/popup.ts",
  },
  bundle: true,
  format: "iife",
  target: "chrome128",
  outdir: out,
  legalComments: "none",
});

await copyFile("extension/manifest.json", `${out}/manifest.json`);
await copyFile("extension/popup.html", `${out}/popup.html`);
await copyFile("extension/popup.css", `${out}/popup.css`);
await writeFile(`${out}/icon-16.png`, icon(16));
await writeFile(`${out}/icon-48.png`, icon(48));
await writeFile(`${out}/icon-128.png`, icon(128));

function icon(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const ink = [91, 91, 214, 255];
  const paper = [251, 250, 248, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5;
      const dy = y - size / 2 + 0.5;
      const radius = size * 0.36;
      const inside = dx * dx + dy * dy <= radius * radius;
      const color = inside ? ink : paper;
      pixels.set(color, (y * size + x) * 4);
    }
  }
  return png(size, size, pixels);
}

function png(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length - 4, 0);
    body.copy(out, 4);
    out.writeInt32BE(crc(body), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c;
}
