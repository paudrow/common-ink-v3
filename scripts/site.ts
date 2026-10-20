// Writes src/worker/site/pages.gen.ts from site/*.md: each file is a page of the site at /<its name>.
// Its first line, a `# ` heading, is the page's title, and its first paragraph is its description.
// The Worker gets the pages as data and never sees marked.
//
//   node scripts/site.ts            write the pages
//   node scripts/site.ts --check    fail when the written pages are not what site/*.md makes
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Marked, type Token, type Tokens } from "marked";

const SOURCE = "site";
const OUT = "src/worker/site/pages.gen.ts";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 160;

interface Prose {
  title: string;
  description: string;
  html: string;
}

/** The words of inline markdown, without its marks: what a heading's id and a page's description are made from. */
function plain(tokens: Token[]): string {
  return tokens.map((t) => ("tokens" in t && t.tokens ? plain(t.tokens) : t.type === "br" ? " " : "text" in t ? t.text : "")).join("");
}

const slugged = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
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

function prose(file: string, markdown: string): Prose {
  const tokens = new Marked().lexer(markdown);
  const first = tokens.findIndex((t) => t.type !== "space");
  const heading = tokens[first];
  if (heading?.type !== "heading" || (heading as Tokens.Heading).depth !== 1) throw new Error(`${file} must start with a "# " heading, its title.`);
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
    },
  });
  const body = tokens.filter((_, i) => i !== first);
  return { title: plain((heading as Tokens.Heading).tokens), description: described(plain(paragraph.tokens)), html: marked.parser(body) };
}

function generated(): string {
  const pages: Record<string, Prose> = {};
  for (const file of readdirSync(SOURCE).filter((f) => f.endsWith(".md")).sort()) {
    const slug = file.slice(0, -".md".length);
    if (!SLUG.test(slug)) throw new Error(`${SOURCE}/${file}: a page's file name is its address, so it may have only lowercase letters, digits and single hyphens.`);
    pages[slug] = prose(`${SOURCE}/${file}`, readFileSync(`${SOURCE}/${file}`, "utf8"));
  }
  return `// Written by scripts/site.ts from site/*.md. Edit those and run \`node scripts/site.ts\`.\n\nexport const PROSE = ${JSON.stringify(pages, null, 2)} as const;\n`;
}

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const want = generated();
let have: string | null = null;
try {
  have = readFileSync(OUT, "utf8");
} catch {}
if (values.check) {
  if (have !== want) {
    console.error(`${OUT} is not what site/*.md makes. Run \`node scripts/site.ts\` and commit what it writes.`);
    process.exit(1);
  }
} else if (have !== want) {
  // Written only when it changes, so the dev server reloads the Worker only for a change.
  writeFileSync(OUT, want);
  console.log(`Wrote ${OUT}.`);
}
