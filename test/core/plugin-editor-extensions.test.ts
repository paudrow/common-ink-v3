import { EditorState, Facet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { forEditor, usable } from "../../src/web/editorExtensions.ts";
import type { EditorExtension } from "../../src/web/plugin-api.ts";

const noteOf = Facet.define<string, string>({ combine: (values) => values.join() });
const noteIn = (extensions: ReturnType<ReturnType<typeof forEditor>>["extensions"]) => EditorState.create({ extensions }).facet(noteOf);

describe("an editor extension given as a function of its editor", () => {
  it("is called for each editor with that editor's note, after the values before it and before those after", () => {
    const added: EditorExtension[] = [
      { id: "first", extension: noteOf.of("first") },
      { id: "per-note", extension: ({ noteId }) => noteOf.of(noteId) },
      { id: "last", extension: noteOf.of("last") },
    ];

    expect(usable(added)).toEqual({ taken: added, refused: [] });
    expect(noteIn(forEditor({ noteId: "plan" })(added).extensions)).toBe("first,plan,last");
    expect(noteIn(forEditor({ noteId: "trip" })(added).extensions)).toBe("first,trip,last");
  });

  it("is called once for an editor however often its extensions are read, so what it built stays", () => {
    const calls: string[] = [];
    const perNote: EditorExtension = { id: "per-note", extension: ({ noteId }) => (calls.push(noteId), noteOf.of(noteId)) };
    const read = forEditor({ noteId: "plan" });

    const first = read([perNote]).extensions;
    const again = read([perNote, { id: "later", extension: [] }]).extensions;

    expect(calls).toEqual(["plan"]);
    expect(again[0]).toBe(first[0]);
  });

  it("is left out of the one editor when it throws or makes what CodeMirror won't take, and named with why", () => {
    const throws: EditorExtension = {
      id: "throws",
      extension: ({ noteId }) => {
        if (noteId === "plan") throw new Error("No extension for plan");
        return noteOf.of(noteId);
      },
    };
    const wrong: EditorExtension = { id: "wrong", extension: () => ({ not: "an extension" }) };
    const fine: EditorExtension = { id: "fine", extension: noteOf.of("fine") };
    const added = [throws, wrong, fine];
    const read = forEditor({ noteId: "plan" });

    const plan = read(added);
    const trip = forEditor({ noteId: "trip" })(added);

    expect(noteIn(plan.extensions)).toBe("fine");
    expect(plan.refused.map(([one, error]) => [one, (error as Error).message])).toEqual([
      [throws, "No extension for plan"],
      [wrong, expect.stringContaining("Unrecognized extension value")],
    ]);
    expect(noteIn(trip.extensions)).toBe("trip,fine");
    expect(trip.refused.map(([one]) => one)).toEqual([wrong]);
    expect(read(added).refused.map(([one]) => one)).toEqual([throws, wrong]);
  });

  it("is kept when the values are checked, where a value CodeMirror won't take is left out", () => {
    const perNote: EditorExtension = { id: "per-note", extension: () => ({ not: "an extension" }) };
    const wrong: EditorExtension = { id: "wrong", extension: { not: "an extension" } };

    const { taken, refused } = usable([wrong, perNote]);

    expect(taken).toEqual([perNote]);
    expect(refused.map(([one, error]) => [one, (error as Error).message])).toEqual([[wrong, expect.stringContaining("Unrecognized extension value")]]);
  });
});
