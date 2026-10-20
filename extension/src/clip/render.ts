import { writtenUpload } from "../../../src/core/uploadRefs.ts";
import type { Block, Clip, ClipImage, Inline, ListItem, PlacedMap } from "./types.ts";
import { imageBox, placeId } from "./images.ts";

export function clipToMarkdown(clip: Clip, title: string, placed: PlacedMap): string {
  const heading = title.replace(/\s+/g, " ").trim() || "Untitled";
  const pageTitle = clip.source.pageTitle.replace(/\s+/g, " ").trim() || clip.source.pageUrl;
  const lines = [`# ${heading}`, "", `[${linkLabel(pageTitle)}](${clip.source.pageUrl}) · ${clip.source.clippedOn}`];
  let skipped = false;
  const body: string[] = [];
  for (const block of clip.blocks) {
    if (!skipped && block.type === "heading" && plainInlines(block.inlines) === heading) {
      skipped = true;
      continue;
    }
    skipped = true;
    const rendered = renderBlock(block, placed, "");
    if (rendered) body.push(rendered);
  }
  const file = clip.file ? placed.document : undefined;
  if (file) body.push(writtenUpload("file", file.id));
  const head = lines.join("\n");
  return body.length ? `${head}\n\n${body.join("\n\n")}\n` : `${head}\n`;
}

export function excerpt(clip: Clip, limit: number): string {
  const parts: string[] = [];
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph" || block.type === "heading") parts.push(plainInlines(block.inlines));
      else if (block.type === "list") for (const item of block.items) walk(item.blocks);
      else if (block.type === "quote") walk(block.blocks);
    }
  };
  walk(clip.blocks);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

export function blockImages(clip: Clip): readonly ClipImage[] {
  const out: ClipImage[] = [];
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === "image") out.push(block.image);
      else if (block.type === "list") for (const item of block.items) walk(item.blocks);
      else if (block.type === "quote") walk(block.blocks);
    }
  };
  walk(clip.blocks);
  return out;
}

function renderBlock(block: Block, placed: PlacedMap, indent: string): string {
  switch (block.type) {
    case "heading":
      return `${indent}${"#".repeat(block.level)} ${renderInlines(block.inlines)}`;
    case "paragraph": {
      const bare = bareEmbed(block.inlines);
      return `${indent}${bare ?? renderInlines(block.inlines)}`;
    }
    case "rule":
      return `${indent}---`;
    case "code":
      return renderCode(block.lang, block.text, indent);
    case "quote":
      return renderBlocks(block.blocks, placed, "")
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    case "image":
      return `${indent}${renderImage(block.image, placed)}`;
    case "list":
      return renderList(block, placed, indent);
    case "table":
      return renderTable(block.rows);
  }
}

function renderBlocks(blocks: readonly Block[], placed: PlacedMap, indent: string): string {
  return blocks.map((block) => renderBlock(block, placed, indent)).filter(Boolean).join("\n\n");
}

function renderList(block: Extract<Block, { type: "list" }>, placed: PlacedMap, indent: string): string {
  return block.items.map((item, index) => renderItem(item, marker(block.ordered, block.start, index, item), placed, indent)).join("\n");
}

function marker(ordered: boolean, start: number, index: number, _item: ListItem): string {
  return ordered ? `${start + index}.` : "-";
}

function renderItem(item: ListItem, mark: string, placed: PlacedMap, indent: string): string {
  const [first, ...rest] = item.blocks;
  if (!first) return `${indent}${mark}`;
  const head = first.type === "paragraph" ? renderInlines(first.inlines) : renderBlock(first, placed, "");
  const lines = [`${indent}${mark} ${head}`.trimEnd()];
  for (const block of rest) {
    const rendered = renderBlock(block, placed, `${indent}  `);
    if (rendered) lines.push(rendered);
  }
  return lines.join("\n");
}

function renderCode(lang: string | null, text: string, indent: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text) + 1));
  return `${indent}${fence}${lang ?? ""}\n${text}\n${indent}${fence}`;
}

function longestRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function renderTable(rows: readonly (readonly (readonly Inline[])[])[]): string {
  const header = rows[0];
  if (!header?.length) return "";
  const cell = (inlines: readonly Inline[]) => renderInlines(inlines).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells: readonly (readonly Inline[])[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function renderImage(image: ClipImage, placed: PlacedMap): string {
  const id = placeId(image);
  const upload = id ? placed[id] : undefined;
  if (upload) return writtenUpload("image", upload.id, imageBox(upload, image));
  if (image.source.kind === "remote") return `[${linkLabel(image.alt || "image")}](${image.source.url})`;
  return image.alt.trim() || "(image)";
}

function renderInlines(inlines: readonly Inline[]): string {
  return inlines.map(renderInline).join("");
}

function renderInline(inline: Inline): string {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "link":
      return `[${linkLabel(renderInlines(inline.inlines))}](${inline.href})`;
    case "code": {
      const fence = "`".repeat(Math.max(1, longestRun(inline.text) + 1));
      return `${fence}${inline.text}${fence}`;
    }
    case "strong":
      return `**${renderInlines(inline.inlines)}**`;
    case "em":
      return `*${renderInlines(inline.inlines)}*`;
    case "strike":
      return `~~${renderInlines(inline.inlines)}~~`;
  }
}

function bareEmbed(inlines: readonly Inline[]): string | null {
  const only = inlines.length === 1 ? inlines[0] : undefined;
  if (!only || only.type !== "link") return null;
  const text = only.inlines.length === 1 ? only.inlines[0] : undefined;
  const label = text?.type === "text" ? text.text.trim() : "";
  return label === only.href && embeddable(only.href) ? only.href : null;
}

function embeddable(href: string): boolean {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return true;
    if ((host === "x.com" || host === "twitter.com") && /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(url.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

function linkLabel(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function plainInlines(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => (inline.type === "text" || inline.type === "code" ? inline.text : plainInlines(inline.type === "link" ? inline.inlines : inline.inlines)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
