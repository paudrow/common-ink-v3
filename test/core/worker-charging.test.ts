import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../../src/worker/**/*.ts", { query: "?raw", import: "default", eager: true });

/**
 * Calls that may leave billing out, each with why. A link's holder stands by the link alone
 * (`standingByLink`), never as a member of a workspace that could be read-only, and every operation
 * a link may ask only reads.
 */
const ALLOWED: { file: string; call: string; why: string }[] = [
  { file: "src/worker/index.ts", call: 'perform(env.DB, { kind: "visitor", token, personId } satisfies Visitor, op)', why: "a share link's shared.open and shared.read, which only read" },
  { file: "src/worker/files.ts", call: 'perform(env.DB, { kind: "visitor", token, personId } satisfies Visitor, { type: "shared.upload", id }', why: "a share link's shared.upload, which only reads" },
];

/** The arguments of the call whose `(` is at `open`, split at its top-level commas. */
function argsAt(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) {
      args.push(text.slice(start, i));
      return args.map((a) => a.trim()).filter(Boolean);
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error(`No end to the call at ${open}`);
}

/** Every `perform(` call in the Worker whose seventh argument names no charging, as `file:line`. */
function forgetful(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const file = path.replace(/^(\.\.\/)+/, "");
    for (const m of text.matchAll(/\bperform\(/g)) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      if (/^\s*(\/\/|\*)/.test(text.slice(lineStart, m.index))) continue;
      if (/charging/i.test(argsAt(text, m.index + "perform".length)[6] ?? "")) continue;
      if (ALLOWED.some((a) => a.file === file && text.startsWith(a.call, m.index))) continue;
      found.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  return found;
}

describe("every call the Worker makes into the core", () => {
  it("says whether billing is on, but for a share link's reads", () => {
    expect(forgetful(sources)).toEqual([]);
  });

  it("is caught, by file and line, when it leaves billing out", () => {
    const files = {
      "../../src/worker/a.ts": 'const x = 1;\nawait perform(env.DB, actor, { type: "note.create", text: f(a, b) }, Date.now(), undefined, { bucket: env.FILES });\n',
      "../../src/worker/b.ts": "perform(env.DB, actor, op, now, sources, files, null);\n// perform(env.DB, actor, op);\nperform(env.DB, actor, op, now, sources, files, chargingOf(env));\nconst u = \"https://x\"; perform(env.DB, actor, op, now, sources, files, false);\n",
    };
    expect(forgetful(files)).toEqual(["src/worker/a.ts:2", "src/worker/b.ts:1", "src/worker/b.ts:4"]);
  });

  it("allows only calls that are still there", () => {
    for (const { file, call } of ALLOWED) expect(sources[`../../${file}`]?.includes(call), `${file} no longer has ${call}`).toBe(true);
  });
});
