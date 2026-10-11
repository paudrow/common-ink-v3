import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { readOnly } from "../../src/web/readOnly.ts";

describe("the editor of a note the member can't change", () => {
  const state = EditorState.create({ doc: "# Plan\n::timer{5m}", extensions: readOnly });

  it("says it is read-only and isn't typed in", () => {
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
    expect(EditorState.create({ doc: "x" }).readOnly).toBe(false);
  });

  it("lets no change through, whatever makes it, but still moves the selection", () => {
    const typed = state.update({ changes: { from: 0, insert: "typed " }, userEvent: "input.type" });
    const embedded = state.update({ changes: { from: 16, to: 18, insert: "5m since=2026-10-10T12:00:00.000Z" }, userEvent: "input.embed" });
    const moved = state.update({ selection: { anchor: 3 } });

    expect([typed.docChanged, typed.state.doc.toString()]).toEqual([false, "# Plan\n::timer{5m}"]);
    expect(embedded.state.doc.toString()).toBe("# Plan\n::timer{5m}");
    expect(moved.state.selection.main.head).toBe(3);
  });

  it("takes a change from the server, which says it isn't to be filtered", () => {
    expect(state.update({ changes: { from: 6, insert: " B" }, filter: false }).state.doc.toString()).toBe("# Plan B\n::timer{5m}");
  });
});
