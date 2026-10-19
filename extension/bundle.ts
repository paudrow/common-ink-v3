import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import * as esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));

/** Every file of the clipper as Chrome loads it, by its path in the extension folder. */
export async function clipperFiles(): Promise<Map<string, Uint8Array>> {
  const built = await esbuild.build({
    entryPoints: {
      background: path.join(root, "src/background.ts"),
      content: path.join(root, "src/content.ts"),
      popup: path.join(root, "src/popup.ts"),
    },
    bundle: true,
    format: "iife",
    target: "chrome128",
    outdir: "out",
    write: false,
    legalComments: "none",
  });
  const files = new Map<string, Uint8Array>();
  for (const file of built.outputFiles) files.set(path.basename(file.path), file.contents);
  for (const name of ["manifest.json", "popup.html", "popup.css"]) files.set(name, await readFile(path.join(root, name)));
  for (const size of [16, 48, 128]) files.set(`icon-${size}.png`, icon(size));
  return files;
}

export async function clipperVersion(): Promise<string> {
  return (JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { version: string }).version;
}

/** A zip of the files at its top level, each deflated. */
export function zip(files: Map<string, Uint8Array>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const fileName = Buffer.from(name);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fileName.length, 26);
    local.push(head, fileName, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += head.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

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
    out.writeUInt32BE(crc32(body), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
