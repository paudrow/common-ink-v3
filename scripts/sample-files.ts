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

/** A table with a quoted cell that holds a comma, one that holds a line break, and a doubled quote. */
const csv = () =>
  ascii(['city,country,note', 'Lisbon,Portugal,"Hills, trams and tiles"', 'Kyoto,Japan,"Temples', 'and gardens"', 'Reykjavík,Iceland,"The ""world\'s northernmost"" capital"', "Nairobi,Kenya,Green city in the sun", ""].join("\r\n"));

const txt = () => ascii("A plain text file, uploaded by Try in this PR.\n\nIt opens in the app to be read, and Copy into a new note makes a note of it.\n");

const md = () => ascii("# A markdown file\n\nIt is drawn as a note is: **bold**, a [link](https://example.com), and a task.\n\n- [ ] read it\n- [x] upload it\n");

/**
 * Twenty seconds of a white box moving over blue, 320 by 180, as VP8 in WebM: the fixture
 * test/browser/fixtures/moving-box.webm, kept here as text so the script reads no file.
 */
const WEBM = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAABxjEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEmTbuMU6uEHFO7a1Osghw67AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiEDTiAAAAAAAFlSua8muAQAAAAAAAEDXgQFzxYjmiDUDlBsj5JyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgkbCCAUC6gbSagQJVsIRVuYEBElTDZ/xzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMnNz1mPAi2PFiOaINQOUGyPkZ8ihRaOHRU5DT0RFUkSHlExhdmM2Mi4yOC4xMDIgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDoyMC4wMDAwMDAwMDAAH0O2dUdN54EAo0EtgQAAgBAUAJ0BKkABtAAARwiFhYiFhIgCAgJ11eP6r+IHKVPX419IDZJf6r7f+4Z70B/VeoBDmYyNOcghrqznIIa6s5yCGurOcghrqznIIa6s5yCGurOcghrqznIIa6s5yAowWVHXCdEHdWc5BDXVnZtrOjLy/PXoy4AWCmFRET+FsL89ejLy/PXoy8vz16MvL89ejLy/PXoy8vz16MvL89ejLy/PXoy8vz16MuAA/vYSrnFEdRH/9kTu/WS9m//ep//3J0//9kL1BSzP/z3iKSEH6jmQ30NErqwdg/3+A6Xd3Wk3wD2kdCv23/9m4m1AXSKEVnWs4O/7aLNvQ//3OI5/9mOAAAo5n/53tnMUgAAX7n2WgAAF5fp/JF6UdjPBdR5WBAAACrW4nNS6oKOdgQBkALECAAYQ2AAYABhYL/QACIAEM1+tck+VgACjrYEAyADxAgAGEBAAGAAYcC/0AAzAAYQAQCL2ydH8AAAdAAAAAAAAAAAAAAAdAKOdgQEsALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEBkACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BAfQAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQJYALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnIECvACRAgAGEBAUYABhYL/QACIAEM1+tck+VgCjnYEDIACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BA4QAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQPoALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEETACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBLAAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQUUALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEFeACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBdwAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQZAALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEGpACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo5yBBwgAkQIABhAQFGAAYWC/0AAiABDNfrXJPlYAo52BB2wAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQfQALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEINACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCJgAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQj8ALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEJYACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCcQAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQooALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEKjACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCvAAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOcgQtUAJECAAYQEBRgAGFgv9AAIgAQzX61yT5WAKOdgQu4ALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEMHACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDIAAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQzkALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYENSACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDawAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQ4QALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEOdACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDtgAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQ88ALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnIEPoACRAgAGEBAUYABhYL/QACIAEM1+tck+VgCjnYEQBACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEGgAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRDMALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYERMACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEZQAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRH4ALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYESXACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEsAAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRMkALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYETiACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAH0O2dUdR54IT7KOcgQAAAJECAAYQEBRgAGFgv9AAIgAQzX61yT5WAKOdgQBkALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEAyACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BASwAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQGQALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEB9ACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BAlgAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQK8ALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnYEDIACxAgAGEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BA4QAsQIABhAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQPoALECAAYQEAAYABhYL/QACIAEM1+tck+VgACjnIEE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9AAIgAQzX61yT5WAAKOdgQOEALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYED6ACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBEwAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQSwALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEFFACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBXgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQXcALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnIEGQACRAgABEBAUYABhYL/QACIAEM1+tck+VgCjnYEGpACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBwgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQdsALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEH0ACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCDQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQiYALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEI/ACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCWAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQnEALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEKKACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo5yBCowAkQIAARAQFGAAYWC/0AAiABDNfrXJPlYAo52BCvAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQtUALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYELuACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDBwAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQyAALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEM5ACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDUgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQ2sALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEOEACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDnQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOcgQ7YAJECAAEQEBRgAGFgv9AAIgAQzX61yT5WAKOdgQ88ALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEPoACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEAQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRBoALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEQzACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BETAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRGUALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYER+ACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BElwAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRLAALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnIETJACRAgABEBAUYABhYL/QACIAEM1+tck+VgCjnYETiACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAH0O2dUWx54I7xKOdgQAAALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEAZACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BAMgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQEsALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEBkACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BAfQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQJYALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYECvACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BAyAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOcgQOEAJECAAEQEBRgAGFgv9AAIgAQzX61yT5WAKOdgQPoALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEETACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBLAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQUUALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEFeACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBdwAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQZAALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEGpACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BBwgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQdsALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnIEH0ACRAgABEBAUYABhYL/QACIAEM1+tck+VgCjnYEINACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCJgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQj8ALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEJYACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCcQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQooALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEKjACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BCvAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQtUALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYELuACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo5yBDBwAkQIAARAQFGAAYWC/0AAiABDNfrXJPlYAo52BDIAAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQzkALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYENSACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDawAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQ4QALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEOdACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BDtgAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgQ88ALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYEPoACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEAQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOcgRBoAJECAAEQEBRgAGFgv9AAIgAQzX61yT5WAKOdgRDMALECAAEQEAAYABhYL/QACIAEM1+tck+VgACjnYERMACxAgABEBAAGAAYWC/0AAiABDNfrXJPlYAAo52BEZQAsQIAARAQABgAGFgv9AAIgAQzX61yT5WAAKOdgRH4ALECAAEQEAAYABhYL/QACIAEM1+tck+VgAAcU7trpLuPs4EAt4r3gQHxggGn8IEDu5GzgicQt4v3gQHxggj68IIF7g==";
const webm = () => Uint8Array.from(atob(WEBM), (c) => c.charCodeAt(0));

const SAMPLES: Record<string, () => Bytes | Promise<Bytes>> = { "sample.png": png, "sample.pdf": pdf, "sample.wav": wav, "sample.webm": webm, "sample.csv": csv, "sample.txt": txt, "sample.md": md };

/** The bytes of the sample file of that name, or null when there is none. */
export const sampleFile = async (name: string): Promise<Bytes | null> => (await SAMPLES[name.toLowerCase()]?.()) ?? null;

/** How wide and tall a sample video is, which the server doesn't read from its bytes: a note keeps that much room for it. */
export const sampleSize = (name: string): { width: number; height: number } | null => (name.toLowerCase() === "sample.webm" ? { width: 320, height: 180 } : null);

const WORD = String.raw`(?:small|medium|large|\d{1,3}%|crop=\d+,\d+,\d+,\d+)`;
const NAMED = new RegExp(`(?<!:)::(${UPLOAD_EMBEDS.join("|")})\\{([^{}\\n]*?\\.[A-Za-z0-9]+)((?:[ \\t]+${WORD})*)\\}`, "g");

/**
 * Where a text names a file by its name and holds no upload's id, as `::image{sample.png}` does,
 * outside code, with the words after it that size or crop it, if it has any (`::image{sample.png medium}`, `::image{sample.png 42% crop=0,220,640,140}`). An id has no
 * dot in it, so a name with an ending is never taken for one.
 */
export function namedUploads(text: string): { embed: UploadEmbed; name: string; words?: string; from: number; to: number }[] {
  const named = [];
  for (const { line, from } of linesOutsideCode(text)) {
    for (const found of line.matchAll(NAMED)) {
      const inCode = (line.slice(0, found.index).match(/`/g) ?? []).length % 2 === 1;
      if (!inCode) named.push({ embed: found[1] as UploadEmbed, name: found[2]!.trim(), ...(found[3]?.trim() ? { words: found[3].trim().split(/[ \t]+/).join(" ") } : {}), from: from + found.index, to: from + found.index + found[0].length });
    }
  }
  return named;
}
