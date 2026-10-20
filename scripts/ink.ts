// The `ink` command for an agent's shell: `node scripts/ink.ts notes` (npm run ink -- notes). cli/ packages it for npm as `commonink`, not yet published.
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "./ink-cli.ts";

const stdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

// `wx` fails when the file is there, so the check and the write are one step.
const write = (path: string, bytes: Uint8Array, replace: boolean) =>
  mkdir(dirname(path), { recursive: true }).then(() =>
    writeFile(path, bytes, { flag: replace ? "w" : "wx" }).then(
      () => true,
      (err: NodeJS.ErrnoException) => (err.code === "EEXIST" ? false : Promise.reject(err)),
    ),
  );

/** `wx` as for write: the check that nothing is there and the write are one step. */
async function saveStream(path: string, body: ReadableStream<Uint8Array>, replace: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, replace ? "w" : "wx").catch((err: NodeJS.ErrnoException) => (err.code === "EEXIST" ? null : Promise.reject(err)));
  if (!file) return false;
  await pipeline(Readable.fromWeb(body as never), file.createWriteStream());
  return true;
}

async function readPart(path: string, offset: number, length: number) {
  const file = await open(path);
  try {
    const bytes = new Uint8Array(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    return bytes.subarray(0, bytesRead) as Uint8Array<ArrayBuffer>;
  } finally {
    await file.close();
  }
}

process.exitCode = await run(process.argv.slice(2), { fetch, env: process.env, stdin, out: (line) => console.log(line), readFile, sizeOf: async (path) => (await stat(path)).size, readPart, writeFile: write, saveStream });
