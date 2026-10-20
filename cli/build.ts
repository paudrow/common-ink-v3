// Bundles the ink command into cli/dist/ink.js, the one file the commonink package runs.
//
//   npm run cli:build
import { statSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const out = path.join(import.meta.dirname, "dist/ink.js");

await esbuild.build({
  entryPoints: [path.join(import.meta.dirname, "../scripts/ink.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});
console.log(`Wrote ${path.relative(process.cwd(), out)}, ${Math.round(statSync(out).size / 1024)} KB.`);
