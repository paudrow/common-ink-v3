import { describe, expect, it } from "vitest";
import { deletedTags, tagsIn } from "../../src/core/todos.ts";

describe("a tag deleted from a note's text", () => {
  it("in a sentence keeps its word, the last part of a nested tag's name, as it was typed", () => {
    expect(deletedTags("Water the #garden today", "garden")).toBe("Water the garden today");
    expect(deletedTags("Plan the #projects/garden this week", "projects")).toBe("Plan the garden this week");
    expect(deletedTags("Plan the #Projects/Garden/Beds first", "projects/garden")).toBe("Plan the Beds first");
    expect(deletedTags("Plan the #garden/ today", "garden")).toBe("Plan the garden today");
    expect(deletedTags("#Garden is green, (see #garden) #garden.", "GARDEN")).toBe("Garden is green, (see garden) garden.");
  });

  it("at the end of a line goes, with the space before it, from the run of tags there", () => {
    expect(deletedTags("- [ ] Call the bank #money #errands", "money")).toBe("- [ ] Call the bank #errands");
    expect(deletedTags("- [ ] Call the bank #money #errands", "errands")).toBe("- [ ] Call the bank #money");
    expect(deletedTags("- [ ] Call the bank #money  #errands  ", "money/x")).toBe("- [ ] Call the bank #money  #errands  ");
    expect(deletedTags("- [ ] Call the bank  #money\t#Money/fees  \n- [ ] Pay rent #money", "money")).toBe("- [ ] Call the bank\n- [ ] Pay rent");
    expect(deletedTags("- [ ] Dig the beds #garden due:2026-10-14", "garden")).toBe("- [ ] Dig the beds due:2026-10-14");
    expect(deletedTags("- [ ] ! Water #garden every:1w [[person:Ada]] #home done:2026-10-10x2", "garden")).toBe("- [ ] ! Water every:1w [[person:Ada]] #home done:2026-10-10x2");
    expect(deletedTags("Not a todo #garden due:2026-10-14", "garden")).toBe("Not a todo garden due:2026-10-14");
  });

  it("in a sentence and in the run on one line is each where it is, every time it is written", () => {
    expect(deletedTags("Water the #garden and the #Garden/pots, then #garden #home", "garden")).toBe("Water the garden and the pots, then #home");
  });

  it("takes away a line of nothing but tags once it has none, and a blank line that would make two", () => {
    expect(deletedTags("# Seeds\n\n#garden\n\nOrder seeds", "garden")).toBe("# Seeds\n\nOrder seeds");
    expect(deletedTags("#garden #Garden/beds\n# Seeds\n", "garden")).toBe("# Seeds\n");
    expect(deletedTags("# Seeds\n\n#garden", "garden")).toBe("# Seeds\n");
    expect(deletedTags("Tags:\n  - #garden\n> #garden\n- #garden #home", "garden")).toBe("Tags:\n- #home");
    expect(deletedTags("#garden", "garden")).toBe("");
    expect(deletedTags("1. #garden\n2) #garden\n## #garden\nNext", "garden")).toBe("Next");
  });

  it("keeps a line of tags that has others left, and a line that had words besides", () => {
    expect(deletedTags("#garden #home", "garden")).toBe("#home");
    expect(deletedTags("  - #garden  #home", "garden")).toBe("  - #home");
    expect(deletedTags("- [ ] #garden", "garden")).toBe("- [ ]");
    expect(deletedTags("Para\n\n\n#garden\n\nNext", "garden")).toBe("Para\n\n\nNext");
  });

  it("is only a tag where one is read: not in code, a link's address or an embed's parentheses, and not a longer tag", () => {
    const text = "`#garden` [beds](https://example.com/#garden) /x-poll(question #garden today) #garden-2 #gardening a#garden\n```\n#garden\n```\n/kanban(#garden x)\n```markdown\n```";
    expect(deletedTags(text, "garden")).toBe(text);
    expect(deletedTags("Weed `#garden` #garden", "garden")).toBe("Weed `#garden`");
    expect(deletedTags("No tags here.", "garden")).toBe("No tags here.");
  });

  it("matches the tags the note is indexed by, so a tag in an embed's parentheses was never the note's", () => {
    expect(tagsIn("/x-poll(question #garden today) /email(aaaaaaaaaaaa Sam #home) #yard")).toEqual(["yard"]);
  });
});
