import { describe, expect, it } from "vitest";
import type { EmbedInfo } from "../../src/web/plugin-api.ts";
import { embedItems, slashItems } from "../../src/web/plugins/embedMenu.ts";

const upload = () => Promise.resolve("");
const EMBEDS: EmbedInfo[] = [
  { name: "timer", title: "Timer", starts: { config: "5m" }, description: "A countdown" },
  { name: "kanban", title: "Kanban board", block: true, starts: { body: "## To do\n" } },
  { name: "file", title: "File", pick: [{ title: "Upload an image", insert: upload }, { title: "Upload a file", detail: "any file", insert: upload }] },
];
const shown = (items: ReturnType<typeof slashItems>) => items.map((i) => `${i.kind} ${i.label}: ${typeof i.insert === "string" ? JSON.stringify(i.insert) : "made when picked"}${i.description ? ` (${i.description})` : ""}`);

describe("the insert menu", () => {
  it("offers on / the blocks that fit what was typed and then the embeds, each said in words and never as syntax", () => {
    expect(shown(slashItems(EMBEDS, "ta"))).toEqual(['block Task list: "- [ ] " (Things to do, each with a box to check)', 'block Table: "| Column | Column |\\n| ------ | ------ |\\n|        |        |" (Rows and columns, typed into cell by cell)']);
    expect(shown(slashItems(EMBEDS, "b"))).toEqual(['block Bulleted list: "- " (A list with a dot before each item)', 'block Code block: "```\\n\\n```" (Code in a fixed-width font, kept as it is typed)', 'embed Kanban board: "/kanban()\\n```markdown\\n## To do\\n```"']);
    expect(slashItems(EMBEDS, "").map((i) => `${i.label}${i.detail ?? ""}`)).toEqual(["Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Task list", "Table", "Code block", "Quote", "Divider", "Timer", "Kanban board", "Upload an image", "Upload a file"]);
  });

  it("offers the embeds on their own, as / writes each", () => {
    expect(shown(embedItems(EMBEDS, ""))).toEqual(['embed Timer: "/timer(5m)" (A countdown)', 'embed Kanban board: "/kanban()\\n```markdown\\n## To do\\n```"', "embed Upload an image: made when picked", 'embed Upload a file: made when picked (any file)']);
    expect(shown(embedItems(EMBEDS, "kan"))).toEqual(['embed Kanban board: "/kanban()\\n```markdown\\n## To do\\n```"']);
    expect(embedItems(EMBEDS, "kan")).toEqual(slashItems(EMBEDS, "kan"));
    expect(embedItems(EMBEDS, "ti")[0]).toMatchObject({ insert: "/timer(5m)", select: [7, 9] });
  });

  it("finds what an embed's pick does by its title alone, and not by the name of the embed it writes", () => {
    expect(embedItems(EMBEDS, "file").map((i) => i.label)).toEqual(["Upload a file"]);
    expect(embedItems(EMBEDS, "upl").map((i) => i.label)).toEqual(["Upload an image", "Upload a file"]);
  });

  it("offers nothing for an embed written by hand past its name, or for an ordinary word", () => {
    expect([embedItems(EMBEDS, "timer{"), embedItems(EMBEDS, "image{"), slashItems(EMBEDS, "or"), slashItems(EMBEDS, "no"), slashItems(EMBEDS, "hr"), slashItems(EMBEDS, "A")].map((items) => items.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
