import { describe, expect, it } from "vitest";
import { ASK_NOTE_SYNTAX, NOTE_SYNTAX, syntaxDescription, syntaxText } from "../../src/core/noteSyntax.ts";
import { callTool, TOOLS } from "../../src/worker/mcp/tools.ts";

describe("note_syntax", () => {
  it("names each thing a note can hold, and create_note and write_note point at it", () => {
    const named = syntaxDescription().split(": ")[1]!.replace(/\.$/, "").split(", ");
    expect(named).toEqual(NOTE_SYNTAX.map((row) => row.called));
    const tool = TOOLS.find((t) => t.name === "note_syntax")!;
    expect(tool.description).toBe(syntaxDescription());
    expect(tool.op).toBeUndefined();
    for (const name of ["create_note", "write_note"]) expect(TOOLS.find((t) => t.name === name)!.description.startsWith(ASK_NOTE_SYNTAX), name).toBe(true);
  });

  it("answers with the examples and refuses any other argument", async () => {
    const answer = await callTool(null as never, { personId: "p" } as never, "note_syntax", {});
    expect(answer?.isError).toBeUndefined();
    expect(answer?.content[0]?.text).toBe(syntaxText());
    for (const row of NOTE_SYNTAX) expect(answer?.content[0]?.text, row.called).toContain(row.example);
    const refused = await callTool(null as never, { personId: "p" } as never, "note_syntax", { form: true });
    expect(refused?.isError).toBe(true);
    expect(refused?.content[0]?.text).toContain('takes no "form"');
  });
});
