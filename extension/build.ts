import { mkdir, writeFile } from "node:fs/promises";
import { clipperFiles } from "./bundle.ts";

const out = "extension/dist";
await mkdir(out, { recursive: true });
for (const [name, data] of await clipperFiles()) await writeFile(`${out}/${name}`, data);
