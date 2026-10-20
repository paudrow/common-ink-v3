// Run by node, where Info-ZIP's unzip and Python's zipfile can read what the writer wrote: a zip is
// right when readers that share none of its code take it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { crc32, zip, type ZipEntry, type ZipOptions } from "../../src/core/zip.ts";

const text = (s: string) => new TextEncoder().encode(s);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Bytes that are the same every run and don't repeat in any short stretch. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** `bytes` as a stream of chunks of the given lengths. */
const streamOf = (bytes: Uint8Array, cuts: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      for (const cut of [...cuts, bytes.length]) {
        controller.enqueue(bytes.slice(at, cut));
        at = cut;
      }
      controller.close();
    },
  });

const BIG = noise(300_000, 7);
const MODIFIED = Date.UTC(2026, 9, 19, 14, 30, 8);

const entries = (): ZipEntry[] => [
  { name: "Notes/Café ☕ plan.md", size: text("# Café\n\nüber 東京 🚀\n").length, modified: MODIFIED, body: text("# Café\n\nüber 東京 🚀\n") },
  { name: "Empty/", size: 0, modified: MODIFIED, body: new Uint8Array() },
  { name: "Empty/nothing.txt", size: 0, modified: MODIFIED, body: new Uint8Array() },
  { name: "Files/noise.bin", size: BIG.length, modified: MODIFIED, body: streamOf(BIG, [1, 9, 4096, 65_536, 65_537, 200_003]) },
];

/** Info-ZIP prints a name in UTF-8 only in a UTF-8 locale, and a time in the zone it is in. */
const UTF8 = { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", TZ: "UTC" } } as const;

/**
 * The rows `unzip -l` prints, as size, time of day and name. Info-ZIP builds differ in how they write
 * the date (`10-19-2026` on a Mac, `2026-10-19` on Ubuntu), so only the time of day is kept.
 */
function listing(path: string, zone = "UTC"): { size: number; time: string; name: string }[] {
  const listed = execFileSync("unzip", ["-l", path], { ...UTF8, env: { ...UTF8.env, TZ: zone } });
  return [...listed.matchAll(/^\s*(\d+)\s+(?:\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/gm)].map((m) => ({ size: Number(m[1]), time: m[2]!, name: m[3]! }));
}

async function archive(options: ZipOptions = {}): Promise<string> {
  const bytes = new Uint8Array(await new Response(zip(entries(), options)).arrayBuffer());
  const path = join(mkdtempSync(join(tmpdir(), "ink-zip-")), "test.zip");
  writeFileSync(path, bytes);
  return path;
}

/** What Python's zipfile reads of each entry: its name, size, CRC, the hash of its bytes, its time, and whether it is a directory. */
const PYTHON = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps([[i.filename, i.file_size, i.CRC, hashlib.sha256(z.read(i)).hexdigest(), list(i.date_time), i.is_dir()] for i in z.infolist()]))
`;

const expected = () => [
  ["Notes/Café ☕ plan.md", 27, nodeCrc32(text("# Café\n\nüber 東京 🚀\n")), sha(text("# Café\n\nüber 東京 🚀\n")), [2026, 10, 19, 14, 30, 8], false],
  ["Empty/", 0, 0, sha(new Uint8Array()), [2026, 10, 19, 14, 30, 8], true],
  ["Empty/nothing.txt", 0, 0, sha(new Uint8Array()), [2026, 10, 19, 14, 30, 8], false],
  ["Files/noise.bin", 300_000, nodeCrc32(BIG), sha(BIG), [2026, 10, 19, 14, 30, 8], false],
];

test("its CRC-32 is zlib's, whole and carried on across pieces of any length", () => {
  assert.equal(crc32(text("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32(BIG), nodeCrc32(BIG));
  let carried = 0;
  for (const [from, to] of [[0, 1], [1, 10], [10, 4097], [4097, 300_000]] as const) carried = crc32(BIG.subarray(from, to), carried);
  assert.equal(carried, nodeCrc32(BIG));
});

for (const [label, options] of [["plain", {}], ["with ZIP64 records forced", { zip64: "always" }]] as const) {
  test(`an archive ${label} is read back by Info-ZIP and by Python, with every name, byte and CRC`, async () => {
    const path = await archive(options);
    const tested = execFileSync("unzip", ["-t", path], UTF8);
    assert.match(tested, /No errors detected in compressed data/, tested);
    // Apple's unzip prints some bytes of a UTF-8 name as ?, so the names it read are checked by what it extracts, below.
    assert.equal(tested.match(/testing: .+\s+OK$/gm)?.length, 4, tested);
    for (const name of ["Empty/nothing.txt", "Files/noise.bin"]) assert.match(tested, new RegExp(`testing: ${name}\\s+OK`), `unzip -t tested ${name}`);
    // Apple's unzip prints part of a UTF-8 name as ?, so the first name is checked up to where it is plain.
    const rows = listing(path);
    assert.deepEqual(rows.map((r) => ({ ...r, name: r.name.slice(0, 10) })), [
      { size: 27, time: "14:30", name: "Notes/Café" },
      { size: 0, time: "14:30", name: "Empty/" },
      { size: 0, time: "14:30", name: "Empty/noth" },
      { size: 300_000, time: "14:30", name: "Files/nois" },
    ]);
    assert.deepEqual(rows.slice(1).map((r) => r.name), ["Empty/", "Empty/nothing.txt", "Files/noise.bin"]);
    const out = mkdtempSync(join(tmpdir(), "ink-unzipped-"));
    execFileSync("unzip", ["-q", path, "-d", out], UTF8);
    assert.equal(readFileSync(join(out, "Notes/Café ☕ plan.md"), "utf8"), "# Café\n\nüber 東京 🚀\n");
    assert.equal(sha(readFileSync(join(out, "Files/noise.bin"))), sha(BIG));
    assert.deepEqual(readdirSync(join(out, "Empty")), ["nothing.txt"]);
    const read = JSON.parse(execFileSync("python3", ["-I", "-c", PYTHON, path], { encoding: "utf8" }));
    assert.deepEqual(read, expected());
  });
}

test("ZIP64 records are written where a reader has to look for them when asked, and not otherwise", async () => {
  const endOf = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.length - 22);
    return { signature: view.getUint32(0, true), entries: view.getUint16(10, true), offset: view.getUint32(16, true), locator: new DataView(bytes.buffer, bytes.length - 42).getUint32(0, true) };
  };
  const forced = new Uint8Array(await new Response(zip(entries(), { zip64: "always" })).arrayBuffer());
  // Every count and offset in the last record says "see ZIP64", so readers that took the archive above found the ZIP64 records.
  assert.deepEqual(endOf(forced), { signature: 0x06054b50, entries: 0xffff, offset: 0xffffffff, locator: 0x07064b50 });
  const plain = new Uint8Array(await new Response(zip(entries())).arrayBuffer());
  assert.deepEqual({ ...endOf(plain), locator: undefined }, { signature: 0x06054b50, entries: 4, offset: plain.length - 22 - 4 * (46 + 9) - ["Notes/Café ☕ plan.md", "Empty/", "Empty/nothing.txt", "Files/noise.bin"].reduce((n, name) => n + text(name).length, 0), locator: undefined });
  const zipinfo = (bytes: Uint8Array) => {
    const path = join(mkdtempSync(join(tmpdir(), "ink-zip-")), "info.zip");
    writeFileSync(path, bytes);
    return execFileSync("zipinfo", ["-v", path], UTF8);
  };
  assert.equal(zipinfo(forced).match(/minimum software version required to extract:\s+4\.5/g)?.length, 4, "each forced entry needs ZIP64 to read");
  assert.equal(zipinfo(plain).match(/minimum software version required to extract:\s+2\.0/g)?.length, 4, "a small archive needs none");
});

test("a reader in another zone shows each file's time in its own zone", async () => {
  const path = await archive();
  assert.deepEqual(listing(path, "America/New_York").find((r) => r.name === "Files/noise.bin"), { size: 300_000, time: "10:30", name: "Files/noise.bin" });
  assert.deepEqual(listing(path, "Asia/Tokyo").find((r) => r.name === "Files/noise.bin"), { size: 300_000, time: "23:30", name: "Files/noise.bin" });
});

test("an entry whose body isn't the size it said errors the stream instead of writing a broken archive", async () => {
  const short = zip([{ name: "short.txt", size: 10, modified: MODIFIED, body: text("abc") }]);
  await assert.rejects(new Response(short).arrayBuffer(), /short\.txt is 3 bytes, not the 10 it said/);
  const long = zip([{ name: "long.txt", size: 2, modified: MODIFIED, body: streamOf(text("abcdef"), [1]) }]);
  await assert.rejects(new Response(long).arrayBuffer(), /long\.txt is longer than the 2 bytes it said/);
});

test("a path longer than a zip's name field holds errors the stream, and one just short of it is read back whole", async () => {
  const deep = (bytes: number) => `${"d/".repeat((bytes - 4) / 2)}é.t`;
  assert.equal(text(deep(65_536)).length, 65_536);
  await assert.rejects(new Response(zip([{ name: deep(65_536), size: 0, modified: MODIFIED, body: text("") }])).arrayBuffer(), /is a path of 65536 bytes, longer than a zip holds/);
  const fits = new Uint8Array(await new Response(zip([{ name: deep(65_534), size: 1, modified: MODIFIED, body: text("x") }])).arrayBuffer());
  const view = new DataView(fits.buffer);
  const central = fits.length - 22 - (46 + 65_534 + 9);
  assert.equal(view.getUint32(central, true), 0x02014b50, "the central record is where the end record says");
  assert.equal(view.getUint16(central + 28, true), 65_534);
  assert.equal(new TextDecoder().decode(fits.subarray(central + 46, central + 46 + 65_534)), deep(65_534));
});

test("cancelling the archive cancels the body it is reading", async () => {
  let cancelled = "";
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel(reason) {
      cancelled = String(reason ?? "cancelled");
    },
  });
  const reader = zip([{ name: "endless.bin", size: 1e9, modified: MODIFIED, body }]).getReader();
  await reader.read();
  await reader.read();
  await reader.cancel("stop");
  assert.equal(cancelled, "cancelled");
});
