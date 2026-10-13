// The small files scripts/try-note.ts uploads for a walkthrough that names one, such as
// ::image{sample.png}. Each is made here from nothing, so the script reads no file of anyone's.

type Bytes = Uint8Array<ArrayBuffer>;
import { linesOutsideCode } from "../src/core/lines.ts";
import { UPLOAD_EMBEDS, type UploadEmbed } from "../src/core/uploadRefs.ts";

const ascii = (text: string): Bytes => Uint8Array.from(new TextEncoder().encode(text));

function joined(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function crc32(bytes: Bytes): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

const deflated = async (bytes: Bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());

function chunk(type: string, data: Bytes): Bytes {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A picture of hills under a sun, 640 by 360. */
async function png(): Promise<Bytes> {
  const [width, height] = [640, 360];
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3) + 1;
    for (let x = 0; x < width; x++) {
      const sky = [118 + y / 4, 170 + y / 6, 232];
      const sun = Math.hypot(x - 500, y - 90) < 44 ? [252, 214, 96] : null;
      const far = y > 230 + 34 * Math.sin(x / 70) ? [96, 150, 120] : null;
      const near = y > 280 + 26 * Math.sin(x / 45 + 2) ? [58, 112, 92] : null;
      rows.set((near ?? far ?? sun ?? sky).map(Math.round), row + x * 3);
    }
  }
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  head.set([8, 2, 0, 0, 0], 8);
  return joined([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", head), chunk("IDAT", await deflated(rows)), chunk("IEND", new Uint8Array(0))]);
}

/** One page that says what it is. */
function pdf(): Bytes {
  const words = "BT /F1 24 Tf 72 720 Td (A sample file from Try in this PR) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${words.length} >>\nstream\n${words}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return ascii(out);
}

/** Two seconds of three rising notes. */
function wav(): Bytes {
  const rate = 8000;
  const samples = new Uint8Array(rate * 2);
  for (let i = 0; i < samples.length; i++) {
    const note = [440, 554, 659][Math.min(2, Math.floor((3 * i) / samples.length))]!;
    const fade = Math.min(1, (samples.length - i) / 2000);
    samples[i] = 128 + Math.round(60 * fade * Math.sin((2 * Math.PI * note * i) / rate));
  }
  const out = new Uint8Array(44 + samples.length);
  const view = new DataView(out.buffer);
  out.set(ascii("RIFF"), 0);
  view.setUint32(4, 36 + samples.length, true);
  out.set(ascii("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  out.set(ascii("data"), 36);
  view.setUint32(40, samples.length, true);
  out.set(samples, 44);
  return out;
}

const SAMPLES: Record<string, () => Bytes | Promise<Bytes>> = { "sample.png": png, "sample.pdf": pdf, "sample.wav": wav };

/** The bytes of the sample file of that name, or null when there is none. */
export const sampleFile = async (name: string): Promise<Bytes | null> => (await SAMPLES[name.toLowerCase()]?.()) ?? null;

const NAMED = new RegExp(`(?<!:)::(${UPLOAD_EMBEDS.join("|")})\\{([^{}\\n]*\\.[A-Za-z0-9]+)\\}`, "g");

/**
 * Where a text names a file by its name and holds no upload's id, as `::image{sample.png}` does,
 * outside code. An id has no dot in it, so a name with an ending is never taken for one.
 */
export function namedUploads(text: string): { embed: UploadEmbed; name: string; from: number; to: number }[] {
  const named = [];
  for (const { line, from } of linesOutsideCode(text)) {
    for (const found of line.matchAll(NAMED)) {
      const inCode = (line.slice(0, found.index).match(/`/g) ?? []).length % 2 === 1;
      if (!inCode) named.push({ embed: found[1] as UploadEmbed, name: found[2]!.trim(), from: from + found.index, to: from + found.index + found[0].length });
    }
  }
  return named;
}
