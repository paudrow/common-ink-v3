// The app on this machine: the site's pages written from site/*.md, local D1 migrated, then Vite with the Worker inside it and dev sign-in on.
//
//   npm run dev -- [--port 5173] [--host] [--state .wrangler/state]
//
// --state keeps the local D1 and R2 in a directory of their own, as the browser tests do theirs.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `SESSION_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  console.log("Wrote .dev.vars with a session secret.");
}
// The key that seals Google tokens on this machine. It is only of use with a Google client in .dev.vars too.
if (!/^TOKEN_KEY=/m.test(readFileSync(".dev.vars", "utf8"))) {
  appendFileSync(".dev.vars", `${readFileSync(".dev.vars", "utf8").endsWith("\n") ? "" : "\n"}TOKEN_KEY=${randomBytes(32).toString("base64")}\n`);
  console.log("Added a token key to .dev.vars.");
}
// It holds secrets, so only its owner reads it, however it was made.
chmodSync(".dev.vars", 0o600);
const args = process.argv.slice(2);
const at = args.indexOf("--state");
const state = at === -1 ? ".wrangler/state" : args.splice(at, 2)[1];
if (!state || state.startsWith("--")) throw new Error("--state takes a directory: --state .wrangler/test-state");
execFileSync("node", ["scripts/site.ts"], { stdio: "inherit" });
// A page of the site that is being written is seen as it is saved. One that doesn't make a page says why and leaves the last one.
for (const source of ["site", "docs/legal"]) if (existsSync(source)) watch(source, () => spawnSync("node", ["scripts/site.ts"], { stdio: "inherit" }));
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { stdio: "inherit", env: { ...process.env, CI: "1" } });
// Miniflare's Local Explorer answers raw SQL on the bucket and database to anyone who reaches the server, with no sign-in.
spawn("npx", ["vite", "dev", ...args], { stdio: "inherit", env: { ...process.env, X_LOCAL_EXPLORER: "false", INK_STATE: state } }).on("exit", (code) => process.exit(code ?? 0));
