// The `ink` command for an agent's shell: `node scripts/ink.ts notes` (npm run ink -- notes).
import { readFile, writeFile } from "node:fs/promises";
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

process.exitCode = await run(process.argv.slice(2), { fetch, env: process.env, stdin, out: (line) => console.log(line), readFile, writeFile: write });
