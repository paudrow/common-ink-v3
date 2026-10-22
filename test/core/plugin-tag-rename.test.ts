import { describe, expect, it } from "vitest";
import type { RenamedTag } from "../../src/core/protocol.ts";
import { confirmation, renamedWords } from "../../src/web/plugins/tags/renaming.ts";

const grown = (toDescribed: boolean) => [{ name: "garden", to: "plants", description: "Anything we grow", toDescribed, describedTo: !toDescribed }];

const plan = (over: Partial<RenamedTag> = {}): RenamedTag => ({
  name: "garden",
  to: "plants",
  merged: false,
  renamed: [
    { noteId: "aaaaaaaaaaaa", noteTitle: "Seeds", revision: 2 },
    { noteId: "bbbbbbbbbbbb", noteTitle: "Beds", revision: 4 },
  ],
  skipped: 0,
  failed: 0,
  under: [],
  descriptions: [],
  ...over,
});

describe("what renaming a tag asks first", () => {
  it("says how many notes change, and that Undo puts them back", () => {
    expect(confirmation(plan())).toBe("Rename #garden to #plants in 2 notes? Each note's history has the change, and Undo puts them all back.");
  });

  it("says when the two become one, and whose description stays", () => {
    expect(confirmation(plan({ merged: true, descriptions: grown(true) }))).toBe(
      "Rename #garden to #plants in 2 notes? #plants is already a tag, so the two become one. #plants keeps its own description. Each note's history has the change, and Undo puts them all back.",
    );
    expect(confirmation(plan({ merged: true, descriptions: grown(false) }))).toBe(
      "Rename #garden to #plants in 2 notes? #plants is already a tag, so the two become one. Its description goes with it. Each note's history has the change, and Undo puts them all back.",
    );
  });

  it("counts the notes the member can't change, which keep the tag, and says when none would change", () => {
    expect(confirmation(plan({ renamed: plan().renamed.slice(0, 1), skipped: 1 }))).toBe(
      "Rename #garden to #plants in 1 note? 1 note you can't change keeps #garden. Each note's history has the change, and Undo puts them all back.",
    );
    expect(confirmation(plan({ renamed: [], skipped: 3, descriptions: grown(false) }))).toBe("No note you can change has #garden. 3 notes you can't change keep #garden.");
  });

  it("says which tags under it go with it", () => {
    expect(confirmation(plan({ under: ["garden/beds"] }))).toBe("Rename #garden to #plants in 2 notes? #garden/beds goes with it. Each note's history has the change, and Undo puts them all back.");
    expect(confirmation(plan({ under: ["garden/beds", "garden/pots"] }))).toBe("Rename #garden to #plants in 2 notes? The 2 tags under it go with it. Each note's history has the change, and Undo puts them all back.");
  });

  it("says nothing of descriptions in a change of case alone", () => {
    expect(confirmation(plan({ to: "Garden", descriptions: [{ name: "garden", to: "Garden", description: "Anything we grow", toDescribed: false, describedTo: false }] }))).toBe("Rename #garden to #Garden in 2 notes? Each note's history has the change, and Undo puts them all back.");
  });
});

describe("what the notice after a rename says", () => {
  it("is how many notes changed, and how many couldn't be", () => {
    expect(renamedWords(plan())).toBe("Renamed #garden to #plants in 2 notes.");
    expect(renamedWords(plan({ failed: 1 }))).toBe("Renamed #garden to #plants in 2 notes. 1 note couldn't be changed and keeps #garden.");
  });
});
