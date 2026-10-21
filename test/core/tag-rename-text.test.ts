import { describe, expect, it } from "vitest";
import { renamedTags } from "../../src/core/todos.ts";

describe("a tag renamed in a note's text", () => {
  it("is written as typed wherever the tag is, whatever case it had", () => {
    expect(renamedTags("# Seeds\n\nOrder #garden seeds and #Garden beds\n- [ ] Dig #GARDEN due:2026-10-14\n", "garden", "Plants")).toBe(
      "# Seeds\n\nOrder #Plants seeds and #Plants beds\n- [ ] Dig #Plants due:2026-10-14\n",
    );
  });

  it("leaves code alone: inline, fenced, and a link's address", () => {
    const text = "#garden and `#garden` and [beds](https://example.com/#garden)\n\n```\n#garden\n```\n\n~~~md\n#garden\n~~~\n#garden";
    expect(renamedTags(text, "garden", "plants")).toBe("#plants and `#garden` and [beds](https://example.com/#garden)\n\n```\n#garden\n```\n\n~~~md\n#garden\n~~~\n#plants");
  });

  it("is the whole tag: punctuation after it ends it, and a longer tag or a word that runs into it is another", () => {
    expect(renamedTags("#garden. #garden, #garden; #garden: #garden! #garden? (see #garden)", "garden", "plants")).toBe("#plants. #plants, #plants; #plants: #plants! #plants? (see #plants)");
    expect(renamedTags("#garden-2 #gardening #garden_x a#garden (#garden) #garden", "garden", "plants")).toBe("#garden-2 #gardening #garden_x a#garden (#garden) #plants");
  });

  it("takes the tags under it along, each keeping the case it has below the tag, which moves a tag under another or to the top", () => {
    expect(renamedTags("#garden/beds #Garden/Pots/Clay #gardens/x #garden", "garden", "Yard")).toBe("#Yard/beds #Yard/Pots/Clay #gardens/x #Yard");
    expect(renamedTags("#project/alpha #project/alpha/notes #project/beta", "project/alpha", "work/alpha")).toBe("#work/alpha #work/alpha/notes #project/beta");
    expect(renamedTags("#project/alpha/notes", "project/alpha", "alpha")).toBe("#alpha/notes");
  });

  it("renames a tag with a slash as a whole name, and leaves a note without it as it was", () => {
    expect(renamedTags("#work/2026-q4 #work #Work/2026-Q4", "work/2026-q4", "work/q4")).toBe("#work/q4 #work #work/q4");
    expect(renamedTags("No tags here.", "garden", "plants")).toBe("No tags here.");
  });

  it("merges into a tag the note already has, leaving both written", () => {
    expect(renamedTags("#garden and #plants", "garden", "plants")).toBe("#plants and #plants");
  });
});
