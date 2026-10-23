import { writtenEmbed, type CompletionItem, type EmbedInfo, type EmbedPick, type Plugin } from "../plugin-api.ts";
import { starting } from "./lib/match.ts";
import { lettering, outline, panel, sketch, words } from "./lib/sketch.ts";

/**
 * A block of markdown the menu writes on lines of its own. `at` is where in `insert` the cursor goes,
 * as after a heading's `# `; without it the cursor goes to the line after.
 */
interface Block {
  label: string;
  /** More words it is found by than its label, such as `h1`. */
  also?: string;
  description: string;
  picture: string;
  insert: string;
  at?: number;
  apart?: boolean;
}

/** A block that is a mark at the start of a line, with the cursor after it. */
const leading = (insert: string) => ({ insert, at: insert.length });

const rows = (draw: (y: number, i: number) => string) => [18, 38, 58].map(draw).join("");

const BLOCKS: readonly Block[] = [
  { label: "Heading 1", also: "h1", description: "A large title for a part of the note", picture: sketch(lettering(14, 38, 30, "Heading", 'font-weight="700"') + words(14, 52, 160) + words(14, 64, 120)), ...leading("# ") },
  { label: "Heading 2", also: "h2", description: "A medium title", picture: sketch(lettering(14, 34, 24, "Heading", 'font-weight="700"') + words(14, 48, 160) + words(14, 60, 120)), ...leading("## ") },
  { label: "Heading 3", also: "h3", description: "A small title", picture: sketch(lettering(14, 30, 19, "Heading", 'font-weight="700"') + words(14, 44, 160) + words(14, 56, 120) + words(14, 68, 140)), ...leading("### ") },
  { label: "Bulleted list", description: "A list with a dot before each item", picture: sketch(rows((y, i) => `<circle cx="20" cy="${y + 3}" r="3.5"/>${words(32, y, [140, 110, 125][i]!)}`)), ...leading("- ") },
  { label: "Numbered list", description: "A list counted 1, 2, 3", picture: sketch(rows((y, i) => lettering(14, y + 8, 12, `${i + 1}.`, 'font-weight="600"') + words(34, y, [136, 104, 120][i]!))), ...leading("1. ") },
  { label: "Task list", also: "todo checkbox", description: "Things to do, each with a box to check", picture: sketch(rows((y, i) => outline(14, y - 2, 10, 10, 2) + (i === 0 ? `<path d="M16 ${y + 3} l3 3 l5 -6" fill="none" stroke-width="2"/>` : "") + words(32, y, [130, 112, 140][i]!))), ...leading("- [ ] ") },
  {
    label: "Table",
    description: "Rows and columns, typed into cell by cell",
    picture: sketch(panel(10, 10, 180, 21, 0) + outline(10, 10, 180, 64) + `<path d="M10 31 H190 M10 52 H190 M70 10 V74 M130 10 V74" stroke-width="1.5"/>`),
    insert: "| Column | Column |\n| ------ | ------ |\n|        |        |",
    apart: true,
  },
  { label: "Code block", description: "Code in a fixed-width font, kept as it is typed", picture: sketch(panel(10, 8, 180, 68) + words(22, 18, 60) + words(36, 32, 96) + words(36, 46, 72) + words(22, 60, 28)), insert: "```\n\n```", at: 4 },
  { label: "Quote", description: "Words set apart as said by someone", picture: sketch(`<rect x="14" y="14" width="4" height="56" rx="2"/>` + words(28, 20, 150) + words(28, 34, 136) + words(28, 48, 150) + words(28, 62, 90)), ...leading("> ") },
  { label: "Divider", also: "rule line", description: "A line across the note between two parts", picture: sketch(words(14, 14, 160) + words(14, 26, 110) + `<rect x="14" y="41" width="172" height="2"/>` + words(14, 56, 150) + words(14, 68, 90)), insert: "***" },
];

const blockItem = ({ label, description, picture, insert, at, apart }: Block): CompletionItem => ({ kind: "block", label, description, preview: { image: picture }, insert, block: true, ...(at !== undefined && { select: [at, at] }), ...(apart && { apart }) });

/** One entry in the menu: an embed it writes, or one of the things an embed's `pick` does. */
interface Entry {
  embed: EmbedInfo;
  pick?: EmbedPick;
}

const entriesOf = (embed: EmbedInfo): Entry[] => (embed.pick === undefined ? [{ embed }] : ("insert" in embed.pick ? [embed.pick] : embed.pick).map((pick) => ({ embed, pick })));

/** How a new embed is written, with its config left selected when there is one to type over. */
function embedItem({ embed: { name, title, block, content, starts, description, preview }, pick }: Entry): CompletionItem {
  if (pick) {
    const said = pick.description ?? pick.detail;
    return { kind: "embed", label: pick.title, ...(said && { description: said }), ...(pick.preview && { preview: pick.preview }), insert: pick.insert };
  }
  const shown = { kind: "embed" as const, label: title, ...(description && { description }), ...(preview && { preview }) };
  const config = starts?.config ?? "";
  const opening = `/${name}(`.length;
  if (!block) return { ...shown, insert: writtenEmbed(name, config), select: config ? [opening, opening + config.length] : undefined };
  return { ...shown, insert: writtenEmbed(name, config, { kind: content ?? "markdown", body: starts?.body ?? "" }), block: true };
}

/** What an item is found by: its words and not "a" or "an", as in "Upload a file", so `N /A` is still just words. */
const found = (text: string) => text.replace(/\b(?:a|an|the)\b/gi, " ");

/**
 * The embeds the menu offers for what was typed after `/`, from `embeds`: those it writes, found by
 * title or name, then what it can only ask for, such as a file to upload, found by title alone, so
 * `file` finds "Upload a file" and not every way into the `file` embed.
 */
export function embedItems(embeds: readonly EmbedInfo[], typed: string): CompletionItem[] {
  const entries = embeds.flatMap(entriesOf).toSorted((a, b) => Number(!!a.pick) - Number(!!b.pick));
  return starting(entries, typed, (e) => found(e.pick ? e.pick.title : `${e.embed.title} ${e.embed.name}`)).map(embedItem);
}

/** What `/` offers for what was typed after it: the blocks of markdown that fit, then the embeds. */
export function slashItems(embeds: readonly EmbedInfo[], typed: string): CompletionItem[] {
  return [...starting(BLOCKS, typed, (b) => found(`${b.label} ${b.also ?? ""}`)).map(blockItem), ...embedItems(embeds, typed)];
}

/**
 * The insert menu. `/` in a note lists blocks of markdown, such as a heading, a list or a table, and
 * every embed a plugin has added, each with what it makes in words and a picture, and picking one
 * writes it, as `/name(args)`, with the content of one that holds some in a fence under it.
 */
export const embedMenu: Plugin = {
  id: "embed-menu",
  name: "Insert menu",
  description: "Type / in a note to pick a heading, a list, a table, a timer, a board or anything else to insert from a list.",
  icon: "slash",
  activate(host) {
    host.completions.register({ id: "embeds", trigger: "/", prose: true, items: (typed) => slashItems(host.embeds.list(), typed) });
  },
};
