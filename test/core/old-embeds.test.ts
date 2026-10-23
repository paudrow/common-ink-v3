import { describe, expect, it } from "vitest";
import { blocksIn, inlineIn } from "../../src/core/embedSyntax.ts";
import { embedsConverted, holdsOldEmbeds, oldEmbedLines } from "../../src/core/oldEmbeds.ts";

const ID = "u2p9l4d8a3c7";
const REF = "k3j5h8d9f0a1";

describe("converting embeds written the old way", () => {
  it("writes every inline embed in use as /name(config), each read back as the embed it was", () => {
    const cases: [string, string][] = [
      ["::timer{5m}", "/timer(5m)"],
      ["::timer{5m since=2026-10-16T09:30:00.000Z}", "/timer(5m since=2026-10-16T09:30:00.000Z)"],
      ["::stopwatch{}", "/stopwatch()"],
      ["::stopwatch{at=1m30s}", "/stopwatch(at=1m30s)"],
      [`::email{${REF} Invoice for October}`, `/email(${REF} Invoice for October)`],
      [`::image{${ID} 640x480 42% crop=120,40,800,600}`, `/image(${ID} 640x480 42% crop=120,40,800,600)`],
      [`::video{${ID} 640x360 medium}`, `/video(${ID} 640x360 medium)`],
      [`::audio{${ID}}`, `/audio(${ID})`],
      [`::file{${ID}}`, `/file(${ID})`],
      [`::drawing{${ID} 820x460}`, `/drawing(${ID} 820x460)`],
      ["::drawing{}", "/drawing()"],
      ['::x-poll{question="Lunch?" votes=3}', '/x-poll(question="Lunch?" votes=3)'],
    ];
    for (const [old, now] of cases) {
      expect(embedsConverted(`Before ${old} after`), old).toBe(`Before ${now} after`);
      const [read] = inlineIn(now);
      expect(read?.config, old).toBe(old.slice(old.indexOf("{") + 1, -1));
    }
  });

  it("writes every block in use as /name(config) with its content in a fence tagged with what it is", () => {
    const text = [
      "# Plan",
      ":::kanban{}",
      "## To do",
      "- [ ] Draft ::timer{5m}",
      ":::",
      ":::html{height=480}",
      "<style>a::before{content:'::timer{1m}'}</style>",
      ":::",
      ":::form{}",
      '{ "answers": {}, "questions": [] }',
      ":::",
      ":::x-board{}",
      "a card",
      ":::",
      "after",
    ].join("\n");
    const now = embedsConverted(text);

    expect(now).toBe(
      [
        "# Plan",
        "/kanban()",
        "```markdown",
        "## To do",
        "- [ ] Draft /timer(5m)",
        "```",
        "/html(height=480)",
        "```html",
        "<style>a::before{content:'::timer{1m}'}</style>",
        "```",
        "/form()",
        "```json",
        '{ "answers": {}, "questions": [] }',
        "```",
        "/x-board()",
        "```markdown",
        "a card",
        "```",
        "after",
      ].join("\n"),
    );
    expect(blocksIn(now).map((b) => [b.name, b.content, b.body])).toEqual([
      ["kanban", "markdown", "## To do\n- [ ] Draft /timer(5m)\n"],
      ["html", "html", "<style>a::before{content:'::timer{1m}'}</style>\n"],
      ["form", "json", '{ "answers": {}, "questions": [] }\n'],
    ]);
  });

  it("writes an empty block with an empty fence, and a body holding a fence in a longer one", () => {
    expect(embedsConverted(":::kanban{}\n:::")).toBe("/kanban()\n```markdown\n```");
    expect(embedsConverted(":::kanban{}\n```\n## not a column\n```\n:::")).toBe("/kanban()\n````markdown\n```\n## not a column\n```\n````");
  });

  it("leaves an event to the conversion of links, which writes it as [[event:ref]]", () => {
    expect(embedsConverted(`Lunch ::event{${REF} Lunch with Sam} and ::timer{5m}`)).toBe(`Lunch ::event{${REF} Lunch with Sam} and /timer(5m)`);
  });

  it("leaves code, inline code, a block never closed and a name that was never an embed's as written", () => {
    for (const text of ["```\n::timer{5m}\n:::kanban{}\n:::\n```", "`::timer{5m}` here", ":::kanban{}\n## To do\n", "::sundial{9} and ::before{x}", "say ::kanban{} here", "std::vector{} and fe80::1"]) {
      expect(embedsConverted(text), text).toBe(text);
      expect(holdsOldEmbeds(text), text).toBe(false);
    }
  });

  it("puts a space before an embed that followed a word, so it is still one, and leaves one inside other marks as written", () => {
    expect(embedsConverted("Steep::timer{5m} and 2::timer{1m}")).toBe("Steep /timer(5m) and 2 /timer(1m)");
    for (const text of ["**::timer{5m}**", `[::image{${ID}}](https://example.com)`, `https://example.com/::image{${ID}}`]) expect(embedsConverted(text), text).toBe(text);
  });

  it("writes a config the parentheses can't hold without what stops them, so a label with a ) or a quote in it is still its embed", () => {
    expect(embedsConverted(`::email{${REF} Lunch (work)}`)).toBe(`/email(${REF} Lunch (work))`);
    expect(embedsConverted(`::email{${REF} Thanks :)}`)).toBe(`/email(${REF} Thanks :)`);
    expect(embedsConverted(`::email{${REF} A 5" tv}`)).toBe(`/email(${REF} A 5 tv)`);
    expect(embedsConverted(`:::kanban{a)}\n- x\n:::`)).toBe("/kanban(a)\n```markdown\n- x\n```");
  });

  it("writes a contact as a mention of them by their name, as @ writes one, wherever it is outside code, and leaves one with no name", () => {
    expect(embedsConverted(`Ask ::contact{${REF} Ada Lovelace} and ::contact{${REF} Sam (work)}.`)).toBe("Ask [[person:Ada Lovelace]] and [[person:Sam (work)]].");
    expect(embedsConverted(`**::contact{${REF} Ada}**`)).toBe("**[[person:Ada]]**");
    for (const text of [`::contact{${REF}}`, `\`::contact{${REF} Ada}\``]) expect(embedsConverted(text), text).toBe(text);
  });

  it("changes nothing in a note already converted", () => {
    const text = embedsConverted(":::kanban{}\n- a\n:::\n::timer{5m}");
    expect(embedsConverted(text)).toBe(text);
    expect(holdsOldEmbeds(text)).toBe(false);
    expect(holdsOldEmbeds("::timer{5m}")).toBe(true);
  });

  it("names each line an agent wrote the old way, with what to write instead", () => {
    expect(oldEmbedLines("# Plan\n::timer{5m} and\n:::kanban{}\n- a\n:::\n`::timer{1m}`")).toEqual([
      { line: 2, written: "::timer{5m} and", now: "/timer(5m) and", forms: ["::timer{5m}"] },
      { line: 3, written: ":::kanban{}", now: "/kanban() with its content in a fence under it", forms: [":::kanban{}"] },
    ]);
  });
});
