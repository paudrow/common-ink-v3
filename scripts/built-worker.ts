// The built app as a deploy runs it, on this machine: the Worker from wrangler.jsonc serving dist/,
// with its own local D1 and R2 under --state, migrated first, dev sign-in on as on a Preview, and the
// unpacked clipper's id allowed to sign in, as the dev server allows it. CI's
// browser tests run against it, one on each runner, so no test waits on a server another part shares.
//
//   npm run build && node scripts/built-worker.ts [--port 8787] [--state .wrangler/built] [--https]
//
// --https serves it on https with a certificate wrangler makes for this machine, as WebKit keeps the
// session cookie, which is Secure, only from https, even on localhost.
//
// The session secret is made here for this run and kept nowhere. Nothing is read from .dev.vars: run
// it where there is none, as CI does.
//
// It runs from wrangler.jsonc less Workers AI, written to wrangler.built.json: Workers AI always runs
// on Cloudflare, paid for, and dev sign-in here counts nobody's requests. Transcribing says it isn't set up.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "jsonc-parser";
import { unpackedExtensionId } from "./extension-id.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, state: { type: "string", default: ".wrangler/built" }, https: { type: "boolean", default: false } } });
const state = values.state!;
const CONFIG = "wrangler.built.json";
const { ai: _, ...config } = parse(readFileSync("wrangler.jsonc", "utf8"));
writeFileSync(CONFIG, JSON.stringify(config, null, 2));

execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "-c", CONFIG], { stdio: "inherit", env: { ...process.env, CI: "1" } });
spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "-c",
    CONFIG,
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
    ...(values.https ? ["--local-protocol", "https"] : []),
  ],
  // No Local Explorer: it answers raw SQL to anyone who reaches the server.
  { stdio: "inherit", env: { ...process.env, X_LOCAL_EXPLORER: "false" } },
).on("exit", (code) => process.exit(code ?? 0));
