// The app on this machine: local D1 migrated, then Vite with the Worker inside it and dev sign-in on.
//
//   npm run dev -- [--port 5173] [--host]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `SESSION_SECRET=${randomBytes(32).toString("hex")}\n`);
  console.log("Wrote .dev.vars with a session secret.");
}
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"], { stdio: "inherit", env: { ...process.env, CI: "1" } });
spawn("npx", ["vite", "dev", ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
