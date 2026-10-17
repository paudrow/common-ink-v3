// The `ink` command for an agent's shell: `node scripts/ink.ts notes` (npm run ink -- notes).
import { open, stat, writeFile } from "node:fs/promises";
import { run } from "./ink-cli.ts";

const stdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

// `wx` fails when the file is there, so the check and the write are one step.
const write = (path: string, bytes: Uint8Array, replace: boolean) =>
  writeFile(path, bytes, { flag: replace ? "w" : "wx" }).then(
    () => true,
    (err: NodeJS.ErrnoException) => (err.code === "EEXIST" ? false : Promise.reject(err)),
  );

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

process.exitCode = await run(process.argv.slice(2), { fetch, env: process.env, stdin, out: (line) => console.log(line), sizeOf: async (path) => (await stat(path)).size, readPart, writeFile: write });
