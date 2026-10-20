// The smoke test in Firefox and WebKit on this machine, as CI runs it: against the built Worker on https,
// since WebKit keeps the Secure session cookie only from https. Run `npm run build` first, or `npm run test:browser:others`.
//
//   node scripts/smoke-browsers.ts [--port 8790]
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "8790" } } });
const url = `https://localhost:${values.port}`;

const worker = spawn("node", ["scripts/built-worker.ts", "--port", values.port!, "--state", ".wrangler/smoke", "--https"], { stdio: "ignore", detached: true });
const stop = () => process.kill(-worker.pid!);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(`${url}/health`).then((res) => res.ok, () => false);
  if (!up) await new Promise((wait) => setTimeout(wait, 1000));
}
if (!up) {
  stop();
  throw new Error(`The built Worker didn't answer at ${url}`);
}

const run = spawn("npx", ["playwright", "test", "--project=firefox", "--project=webkit"], { stdio: "inherit", env: { ...process.env, BASE_URL: url, NODE_TLS_REJECT_UNAUTHORIZED: undefined } });
run.on("exit", (code) => {
  stop();
  process.exit(code ?? 1);
});
