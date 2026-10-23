import { describe, expect, it } from "vitest";
import { mentionIndex } from "../../src/core/mentions.ts";
import { linksConverted } from "../../src/core/oldLinks.ts";
import { referencesIn } from "../../src/core/references.ts";

const ADA = "aaaaaaaaaaaa";
const GONE = "zzzzzzzzzzzz";
const REF = "r1r1r1r1r1r1";
const MEMBERS = new Map([[ADA, "Ada  Lovelace"]]);
const converted = (text: string) => linksConverted(text, (id) => MEMBERS.get(id));

describe("converting what notes wrote before everything they open was a link", () => {
  it("writes a member by id alone where the name written is theirs now, and keeps a name that isn't as the link's words", () => {
    expect(converted(`Ask @[[${ADA}|Ada Lovelace]].`)).toBe(`Ask [[person:${ADA}]].`);
    expect(converted(`Ask @[[${ADA}|the Countess]].`)).toBe(`Ask [[person:${ADA}|the Countess]].`);
    expect(converted(`Ask @[[${ADA}|ada lovelace]].`)).toBe(`Ask [[person:${ADA}|ada lovelace]].`);
    expect(converted(`Ask @[[${ADA}]].`)).toBe(`Ask [[person:${ADA}]].`);
  });

  it("keeps the name of someone who is no longer a member, which is all that is left to show", () => {
    expect(converted(`Ask @[[${GONE}|Grace Hopper]] and @[[${GONE}]].`)).toBe(`Ask [[person:${GONE}|Grace Hopper]] and [[person:${GONE}]].`);
  });

  it("writes anyone else by name, with words of their own where they differ from the name", () => {
    expect(converted("Call @[[Sam Okafor]], @[[Sam Okafor|Sammy]] and @[[Sam Okafor|Sam Okafor]].")).toBe("Call [[person:Sam Okafor]], [[person:Sam Okafor|Sammy]] and [[person:Sam Okafor]].");
  });

  it("writes an event's reference as a link to it, dropping the title it was written with, and leaves one that names no reference", () => {
    expect(converted(`At ::event{${REF} Lunch with Sam} and ::event{${REF}}, not ::event{Lunch with Sam} or ::event{}.`)).toBe(
      `At [[event:${REF}]] and [[event:${REF}]], not ::event{Lunch with Sam} or ::event{}.`,
    );
  });

  it("leaves code, a link's address, an @ that starts no mention, and a contact's or an email's embed as written", () => {
    const text = [
      `Inline \`@[[Sam]] ::event{${REF} x}\` stays.`,
      "```",
      `@[[Sam]] ::event{${REF} x}`,
      "```",
      `[site](https://example.com/@[[Sam]]) mail@[[${ADA}]] a_@[[Plan]] @@[[Plan]] ::contact{${REF} Sam} ::email{${REF} Hi}`,
    ].join("\n");
    expect(converted(text)).toBe(text);
  });

  it("takes what is written inside another for the other's: a mention in an event's label, or an event in a mention's name", () => {
    const once = converted(`::event{${REF} see @[[Sam]]} and @[[Sam|::event{${REF} x}]]`);
    expect(once).toBe(`[[event:${REF}]] and [[person:Sam|::event{${REF} x}]]`);
    expect(converted(once)).toBe(once);
  });

  it("reads a name as a mention did: without characters that don't show, and nothing for a name of nothing else", () => {
    expect(converted("@[[‮Sam​ Okafor]] @[[​]] @[[ ]] @[[]]")).toBe("[[person:Sam Okafor]] @[[​]] @[[ ]] @[[]]");
  });

  it("converts inside a block embed too, as the index of mentions read them there, and keeps every other character", () => {
    const text = `# Board\n\n:::kanban{}\n## To do\n- Call @[[Sam]] at ::event{${REF} Lunch}\n:::\n\n- [ ] todo @[[${ADA}|Ada Lovelace]] due:2026-10-30 #home\n`;
    expect(converted(text)).toBe(`# Board\n\n:::kanban{}\n## To do\n- Call [[person:Sam]] at [[event:${REF}]]\n:::\n\n- [ ] todo [[person:${ADA}]] due:2026-10-30 #home\n`);
  });

  it("is read afterwards as the same people and events, and changes nothing run again", () => {
    const text = `- [ ] Ask @[[${ADA}|Ada Lovelace]] and @[[sam okafor]] about ::event{${REF} Lunch}\n- [ ] [[person:Lin Wei]] already`;
    const once = converted(text);
    expect(mentionIndex(once)).toEqual([
      [0, ADA, ""],
      [0, "sam okafor", "sam okafor"],
      [1, "lin wei", "Lin Wei"],
    ]);
    expect(referencesIn(once)).toEqual([{ kind: "event", ref: REF }]);
    expect(converted(once)).toBe(once);
    expect(converted("Nothing old [[person:Sam]] [[event:r1r1r1r1r1r1]]")).toBe("Nothing old [[person:Sam]] [[event:r1r1r1r1r1r1]]");
  });
});
