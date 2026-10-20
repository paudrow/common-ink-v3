// A zip archive written as it is read, a file at a time, so neither a whole file nor the whole
// archive is ever held in memory. Files are stored as they are, not compressed. Each one's CRC-32 is
// worked out as its bytes pass and written after them, in a data descriptor. It knows nothing of
// what the files are.

/** One file in an archive. */
export interface ZipEntry {
  /** Its path in the archive, with `/` between directories. One that ends in `/` is a directory, of size 0. */
  name: string;
  /** How many bytes `body` holds. An entry whose body holds more or fewer breaks the archive off. */
  size: number;
  /** When it last changed, in milliseconds since 1970. */
  modified: number;
  body: Uint8Array | ReadableStream<Uint8Array>;
}

export interface ZipOptions {
  /** Writes ZIP64 records for every entry and the end, as a file over 4 GiB needs, so a small archive can show they are read. */
  zip64?: "always";
}

/** The largest value a 32-bit field of a zip holds. A larger one is written in a ZIP64 record, and the field says so with this. */
const LIMIT = 0xffffffff;
const MOST_ENTRIES = 0xffff;
/** A name's length is a 16-bit field. */
const MOST_NAME_BYTES = 0xffff;
/** Data descriptor, and names in UTF-8. */
const FLAGS = 0x0008 | 0x0800;
/** 2.0 for a file, 4.5 for one with ZIP64 records. */
const PLAIN = 20;
const WIDE = 45;
/** Made by Unix, so a reader takes the permissions below. */
const MADE_BY = (3 << 8) | WIDE;
const FILE_MODE = 0o100644 << 16;
const DIR_MODE = ((0o40755 << 16) | 0x10) >>> 0;

/** The eight tables of slice-by-8: the first is the byte-at-a-time table, and each next one is a byte further on. */
const TABLES = (() => {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n]! >>> 8) ^ t[t[(k - 1) * 256 + n]! & 0xff]!;
  return t;
})();

/** The CRC-32 of `bytes`, carried on from `crc`, the CRC-32 of what came before them. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const end = bytes.length - (bytes.length % 8);
  while (i < end) {
    const a = (c ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24))) >>> 0;
    c = t[1792 + (a & 0xff)]! ^ t[1536 + ((a >>> 8) & 0xff)]! ^ t[1280 + ((a >>> 16) & 0xff)]! ^ t[1024 + (a >>> 24)]! ^ t[768 + bytes[i + 4]!]! ^ t[512 + bytes[i + 5]!]! ^ t[256 + bytes[i + 6]!]! ^ t[bytes[i + 7]!]!;
    i += 8;
  }
  while (i < bytes.length) c = t[(c ^ bytes[i++]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** A record of fixed fields, little-endian, as every number in a zip is. */
class Fields {
  readonly bytes: Uint8Array;
  private view: DataView;
  private at = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(value: number) {
    this.view.setUint8(this.at, value);
    this.at += 1;
    return this;
  }
  u16(value: number) {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }
  u32(value: number) {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(value: number) {
    this.view.setUint32(this.at, value % 2 ** 32, true);
    this.view.setUint32(this.at + 4, Math.floor(value / 2 ** 32), true);
    this.at += 8;
    return this;
  }
  raw(bytes: Uint8Array) {
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
    return this;
  }
}

/** A time as MS-DOS keeps it, which is what a zip has room for: to two seconds, from 1980 to 2107, in UTC. */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Math.min(Math.max(ms, Date.UTC(1980, 0, 1)), Date.UTC(2107, 11, 31, 23, 59, 58)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * The time again in Info-ZIP's extended timestamp, seconds since 1970 in UTC, which readers that know
 * it show in their own zone. The MS-DOS time beside it has no zone, so it is written in UTC.
 */
const STAMP = 9;
const stamp = (fields: Fields, seconds: number) => fields.u16(0x5455).u16(5).u8(1).u32(seconds);

interface Written {
  name: Uint8Array;
  dir: boolean;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  seconds: number;
  /** Whether its local header and data descriptor have ZIP64 sizes. */
  wide: boolean;
}

const utf8 = new TextEncoder();

/** The bytes of `body`, as they come. A stream is let go of, or cancelled when it is left before its end. */
async function* chunksOf(body: ZipEntry["body"]): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        done = true;
        return;
      }
      yield read.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* written(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, options: ZipOptions): AsyncGenerator<Uint8Array> {
  const forced = options.zip64 === "always";
  const files: Written[] = [];
  let offset = 0;
  for await (const entry of entries) {
    const name = utf8.encode(entry.name);
    if (name.length > MOST_NAME_BYTES) throw new Error(`${entry.name.slice(0, 100)}… is a path of ${name.length} bytes, longer than a zip holds`);
    const dir = entry.name.endsWith("/");
    // Whether the data descriptor has 8-byte sizes is read from the local header, so it is decided before the bytes, by the size the entry says it is.
    const wide = forced || entry.size >= LIMIT;
    const { time, date } = dosTime(entry.modified);
    const seconds = Math.max(0, Math.floor(entry.modified / 1000));
    const local = new Fields(30 + name.length + STAMP + (wide ? 20 : 0))
      .u32(0x04034b50)
      .u16(wide ? WIDE : PLAIN)
      .u16(FLAGS)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(0)
      .u32(wide ? LIMIT : 0)
      .u32(wide ? LIMIT : 0)
      .u16(name.length)
      .u16(STAMP + (wide ? 20 : 0))
      .raw(name);
    stamp(local, seconds);
    if (wide) local.u16(0x0001).u16(16).u64(0).u64(0);
    yield local.bytes;
    let crc = 0;
    let size = 0;
    for await (const chunk of chunksOf(entry.body)) {
      if (!chunk.length) continue;
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (size > entry.size) throw new Error(`${entry.name} is longer than the ${entry.size} bytes it said`);
      yield chunk;
    }
    if (size !== entry.size) throw new Error(`${entry.name} is ${size} bytes, not the ${entry.size} it said`);
    yield wide ? new Fields(24).u32(0x08074b50).u32(crc).u64(size).u64(size).bytes : new Fields(16).u32(0x08074b50).u32(crc).u32(size).u32(size).bytes;
    files.push({ name, dir, crc, size, offset, time, date, seconds, wide });
    offset += local.bytes.length + size + (wide ? 24 : 16);
  }

  const start = offset;
  for (const file of files) {
    const wide = forced || file.wide || file.offset >= LIMIT;
    const central = new Fields(46 + file.name.length + STAMP + (wide ? 28 : 0))
      .u32(0x02014b50)
      .u16(MADE_BY)
      .u16(wide ? WIDE : PLAIN)
      .u16(FLAGS)
      .u16(0)
      .u16(file.time)
      .u16(file.date)
      .u32(file.crc)
      .u32(wide ? LIMIT : file.size)
      .u32(wide ? LIMIT : file.size)
      .u16(file.name.length)
      .u16(STAMP + (wide ? 28 : 0))
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(file.dir ? DIR_MODE : FILE_MODE)
      .u32(wide ? LIMIT : file.offset)
      .raw(file.name);
    stamp(central, file.seconds);
    if (wide) central.u16(0x0001).u16(24).u64(file.size).u64(file.size).u64(file.offset);
    yield central.bytes;
    offset += central.bytes.length;
  }
  const size = offset - start;
  const wide = forced || files.length >= MOST_ENTRIES || start >= LIMIT || size >= LIMIT;
  if (wide) {
    yield new Fields(56).u32(0x06064b50).u64(44).u16(MADE_BY).u16(WIDE).u32(0).u32(0).u64(files.length).u64(files.length).u64(size).u64(start).bytes;
    yield new Fields(20).u32(0x07064b50).u32(0).u64(offset).u32(1).bytes;
  }
  const count = wide ? MOST_ENTRIES : files.length;
  yield new Fields(22)
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(count)
    .u16(count)
    .u32(wide ? LIMIT : size)
    .u32(wide ? LIMIT : start)
    .u16(0).bytes;
}

/** The archive of `entries`, written as it is read. A body that breaks off, or isn't the size its entry said, errors the stream. */
export function zip(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, options: ZipOptions = {}): ReadableStream<Uint8Array> {
  const chunks = written(entries, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
