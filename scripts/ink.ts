// The `ink` command for an agent's shell: `node scripts/ink.ts notes` (npm run ink -- notes).
import { run } from "./ink-cli.ts";

const stdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

process.exitCode = await run(process.argv.slice(2), { fetch, env: process.env, stdin, out: (line) => console.log(line) });
