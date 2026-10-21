import { describe, expect, it } from "vitest";
import { ASK_NOTE_SYNTAX, NOTE_SYNTAX, syntaxDescription } from "../../src/core/noteSyntax.ts";
import { linksIn } from "../../src/core/links.ts";
import { mentionsIn } from "../../src/core/mentions.ts";
import { todosIn } from "../../src/core/todos.ts";
import { uploadIn } from "../../src/core/uploadRefs.ts";
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

  it("answers with a form, a link, a mention, a todo and an upload, and takes no arguments", async () => {
    const answer = await callTool(null as never, { personId: "p" } as never, "note_syntax", {});
    const text = answer?.content[0]?.text ?? "";
    expect(answer?.isError).toBeUndefined();
    expect(text).toContain(':::form{}\n{\n  "answers": {}');
    expect(text).toContain("::image{u2p9l4d8a3c7 640x480}");
    expect(text).toContain("::video{u2p9l4d8a3c7 640x360}");
    expect(text).toContain("::audio{u2p9l4d8a3c7}");
    expect(text).toContain("::file{u2p9l4d8a3c7}");
    expect(text).toContain("See [[k3f9q2m8x1ab|Budget]].");
    expect(text).toContain("Ask @[[Ada Lovelace]].");
    expect(text).toContain("- [ ] !! Call the bank due:2026-10-14 every:1w");
    expect(linksIn("See [[k3f9q2m8x1ab|Budget]].")).toEqual([{ from: 4, to: 27, target: "k3f9q2m8x1ab", display: "Budget" }]);
    expect(mentionsIn("Ask @[[Ada Lovelace]].")).toEqual([{ from: 4, to: 21, target: "Ada Lovelace", label: null }]);
    expect(todosIn("- [ ] !! Call the bank due:2026-10-14 every:1w")).toMatchObject([{ state: "open", importance: 2, due: { date: "2026-10-14" }, every: { written: "1w" } }]);
    expect(uploadIn("u2p9l4d8a3c7 640x480")).toBe("u2p9l4d8a3c7");
    const refused = await callTool(null as never, { personId: "p" } as never, "note_syntax", { form: true });
    expect(refused).toEqual({ content: [{ type: "text", text: 'invalid: note_syntax takes no "form". It takes no arguments.' }], isError: true });
    const workspace = await callTool(null as never, { personId: "p" } as never, "note_syntax", { workspaceId: "w4k8s2p6c1e9" });
    expect(workspace).toEqual({ content: [{ type: "text", text: 'invalid: note_syntax takes no "workspaceId". It takes no arguments.' }], isError: true });
  });
});
