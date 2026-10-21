// Writes src/worker/site/pages.gen.ts from site/*.md, docs/legal/*.md and site/docs/*.md: each file is a page of the
// site at /<its name>, and each doc at /docs/<its name>, with index.md at /docs, in the order and groups of
// site/docs/nav.json. The legal drafts are read where they are kept, so the site never shows a copy that has fallen
// behind. A page's first `# ` heading is its title, and its first paragraph is its description.
// A line `<!-- generated:NAME -->` is written from the code it is about, so a reference can't fall behind it.
// The Worker gets the pages as data and never sees marked. The file is not committed: dev, build, typecheck, the
// unit tests and a Preview each write it first.
//
//   npm run site    write the pages
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import { syntaxDocs } from "../src/core/query.ts";
import { USAGE } from "./ink-cli.ts";

const SOURCE = "site";
const LEGAL = "docs/legal";
const DOCS = `${SOURCE}/docs`;
const NAV = `${DOCS}/nav.json`;
const OUT = "src/worker/site/pages.gen.ts";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 160;

interface Prose {
  title: string;
  description: string;
  html: string;
}

interface DocsGroup {
  group: string;
  pages: Array<Prose & { slug: string }>;
}

/** The words of inline markdown, without its marks: what a heading's id and a page's description are made from. */
function plain(tokens: Token[]): string {
  return tokens.map((t) => ("tokens" in t && t.tokens ? plain(t.tokens) : t.type === "br" ? " " : "text" in t ? t.text : "")).join("");
}

const slugged = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");

/** The first paragraph's whole sentences that fit a search result, or its first words when one sentence is too long. */
function described(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > MAX_DESCRIPTION) break;
    out = next;
  }
  if (out) return out;
  return `${text.slice(0, MAX_DESCRIPTION - 1).replace(/\s+\S*$/, "")}…`;
}

/** Text that is to be read as it is written, in markdown: every mark escaped, and each line kept a line. `indent` keeps a paragraph after the first inside a list item. */
const literal = (text: string, indent = "") =>
  text
    .trim()
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => paragraph.split("\n").map((line) => line.replace(/[!-/:-@[-`{-~]/g, "\\$&")).join(`\\\n${indent}`))
    .join(`\n\n${indent}`);

/** A code block that no backticks in `text` can close. */
const fenced = (text: string, lang = "") => {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
};

interface Schema {
  type?: string | string[];
  enum?: unknown[];
  oneOf?: Schema[];
  items?: Schema;
  description?: string;
  default?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
}

const typeOf = (schema: Schema): string => {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.oneOf) return [...new Set(schema.oneOf.map(typeOf))].join(" | ");
  if (schema.type === "array") {
    const item = schema.items ? typeOf(schema.items) : "any";
    return item.includes(" ") ? `(${item})[]` : `${item}[]`;
  }
  return [schema.type ?? "any"].flat().join(" | ");
};

interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  example: Record<string, unknown>;
}

// The Worker's code is typed by the Worker's tsconfig, so it is imported by a name tsc doesn't follow, and taken as only what the docs read of it.
const TOOLS_MODULE = "../src/worker/mcp/tools.ts";
const { TOOLS }: { TOOLS: Tool[] } = await import(TOOLS_MODULE);

function toolDocs(tool: Tool): string {
  const schema = tool.inputSchema;
  const params = Object.entries(schema.properties ?? {}).map(([name, param]) => {
    const facts = [`\`${typeOf(param)}\``, ...(schema.required?.includes(name) ? ["required"] : []), ...("default" in param ? [`default \`${JSON.stringify(param.default)}\``] : [])];
    return `- \`${name}\` · ${facts.join(" · ")}${param.description ? `\\\n  ${literal(param.description, "  ")}` : ""}`;
  });
  return [`### \`${tool.name}\``, literal(tool.description), params.length ? params.join("\n") : "Takes no arguments.", `Example:\n\n${fenced(JSON.stringify(tool.example, null, 2), "json")}`].join("\n\n");
}

/** What each `<!-- generated:NAME -->` line is written as. */
const GENERATED = new Map<string, () => string>([
  ["cli-usage", () => fenced(USAGE)],
  ["mcp-tools", () => TOOLS.map(toolDocs).join("\n\n")],
  ["search-syntax", syntaxDocs],
]);

function filledIn(file: string, markdown: string): string {
  const filled = markdown.replace(/^[ \t]*<!--\s*generated:(.*?)\s*-->[ \t]*\r?$/gm, (_, name: string) => {
    const make = GENERATED.get(name);
    if (!make) throw new Error(`${file}: no generated section is named "${name}". There are ${[...GENERATED.keys()].join(", ")}.`);
    return `\n${make()}\n`;
  });
  if (/<!--\s*generated:/.test(filled)) throw new Error(`${file}: a <!-- generated:NAME --> is filled in only on a line of its own.`);
  return filled;
}

function prose(file: string): Prose {
  const tokens = new Marked().lexer(filledIn(file, readFileSync(file, "utf8")));
  const first = tokens.findIndex((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1);
  const heading = tokens[first];
  if (!heading) throw new Error(`${file} needs a "# " heading, its title.`);
  const paragraph = tokens.find((t): t is Tokens.Paragraph => t.type === "paragraph");
  if (!paragraph) throw new Error(`${file} needs a paragraph, its description.`);
  const ids = new Map<string, number>();
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const base = slugged(plain(tokens)) || "section";
        const seen = ids.get(base) ?? 0;
        ids.set(base, seen + 1);
        return `<h${depth} id="${seen ? `${base}-${seen + 1}` : base}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      // A wide table scrolls in its own box, so a phone never scrolls the page sideways.
      table(token) {
        return `<div class="table-scroll">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
    },
  });
  const body = tokens.filter((_, i) => i !== first);
  return { title: plain((heading as Tokens.Heading).tokens), description: described(plain(paragraph.tokens)), html: marked.parser(body) };
}

/** The slugs of the markdown files in `dir`, each checked to be fit for an address. */
const slugsIn = (dir: string) =>
  (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const slug = file.slice(0, -".md".length);
      if (!SLUG.test(slug)) throw new Error(`${dir}/${file}: a page's file name is its address, so it may have only lowercase letters, digits and single hyphens.`);
      return slug;
    });

function navOf(text: string): Array<{ group: string; pages: string[] }> {
  const nav: unknown = JSON.parse(text);
  const fits = Array.isArray(nav) && nav.every((g) => typeof g?.group === "string" && Array.isArray(g.pages) && g.pages.every((p: unknown) => typeof p === "string"));
  if (!fits) throw new Error(`${NAV} is a list of { "group": "A heading", "pages": ["a-slug", ...] }.`);
  return nav;
}

function docs(): DocsGroup[] {
  const nav = navOf(readFileSync(NAV, "utf8"));
  const files = slugsIn(DOCS);
  const named = nav.flatMap((g) => g.pages);
  const twice = named.filter((slug, i) => named.indexOf(slug) !== i);
  if (twice.length) throw new Error(`${NAV} names ${twice.join(", ")} more than once.`);
  const missing = named.filter((slug) => !files.includes(slug));
  if (missing.length) throw new Error(`${NAV} names ${missing.map((slug) => `${slug}.md`).join(", ")}, which ${DOCS}/ doesn't have.`);
  const unlisted = files.filter((slug) => !named.includes(slug));
  if (unlisted.length) throw new Error(`${unlisted.map((slug) => `${DOCS}/${slug}.md`).join(", ")} is in no group of ${NAV}, so nobody would find it there.`);
  if (!files.includes("index")) throw new Error(`${DOCS}/ needs index.md, the page at /docs.`);
  return nav.map(({ group, pages }) => ({ group, pages: pages.map((slug) => ({ slug, ...prose(`${DOCS}/${slug}.md`) })) }));
}

function generated(): string {
  const pages: Record<string, Prose> = {};
  for (const dir of [SOURCE, LEGAL]) {
    for (const slug of slugsIn(dir)) {
      if (slug in pages) throw new Error(`${dir}/${slug}.md: another page is at /${slug} already.`);
      pages[slug] = prose(`${dir}/${slug}.md`);
    }
  }
  return `// Written by scripts/site.ts from site/ and docs/legal/. Edit those and run \`npm run site\`.\n\nexport const PROSE = ${JSON.stringify(pages, null, 2)} as const;\n\nexport const DOCS = ${JSON.stringify(docs(), null, 2)};\n`;
}

const want = generated();
let have: string | null = null;
try {
  have = readFileSync(OUT, "utf8");
} catch {}
if (have !== want) {
  // Written only when it changes, so the dev server reloads the Worker only for a change.
  writeFileSync(OUT, want);
  console.log(`Wrote ${OUT}.`);
}
