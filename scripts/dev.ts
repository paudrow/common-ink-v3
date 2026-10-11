// The app on this machine: local D1 migrated, then Vite with the Worker inside it and dev sign-in on.
//
//   npm run dev -- [--port 5173] [--host]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `SESSION_SECRET=${randomBytes(32).toString("hex")}\n`);
  console.log("Wrote .dev.vars with a session secret.");
}
// The key that seals Google tokens on this machine. It is only of use with a Google client in .dev.vars too.
if (!/^TOKEN_KEY=/m.test(readFileSync(".dev.vars", "utf8"))) {
  appendFileSync(".dev.vars", `${readFileSync(".dev.vars", "utf8").endsWith("\n") ? "" : "\n"}TOKEN_KEY=${randomBytes(32).toString("base64")}\n`);
  console.log("Added a token key to .dev.vars.");
}
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"], { stdio: "inherit", env: { ...process.env, CI: "1" } });
spawn("npx", ["vite", "dev", ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
