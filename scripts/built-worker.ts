// The built app as a deploy runs it, on this machine: the Worker from wrangler.jsonc serving dist/,
// with its own local D1 and R2 under --state, migrated first, dev sign-in on as on a Preview, and the
// unpacked clipper's id allowed to sign in, as the dev server allows it. CI's
// browser tests run against it, one on each runner, so no test waits on a server another part shares.
//
//   npm run build && node scripts/built-worker.ts [--port 8787] [--state .wrangler/built]
//
// The session secret is made here for this run and kept nowhere. Nothing is read from .dev.vars: run
// it where there is none, as CI does.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { unpackedExtensionId } from "./extension-id.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, state: { type: "string", default: ".wrangler/built" } } });
const state = values.state!;

execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { stdio: "inherit", env: { ...process.env, CI: "1" } });
spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--local",
    "--port",
    values.port!,
    "--persist-to",
    state,
    "--var",
    "DEV_SIGN_IN:1",
    "--var",
    `SESSION_SECRET:${randomBytes(32).toString("hex")}`,
    "--var",
    `CLIPPER_EXTENSION_IDS:${unpackedExtensionId()}`,
    "--show-interactive-dev-session=false",
  ],
  // No Local Explorer: it answers raw SQL to anyone who reaches the server.
  { stdio: "inherit", env: { ...process.env, X_LOCAL_EXPLORER: "false" } },
).on("exit", (code) => process.exit(code ?? 0));
