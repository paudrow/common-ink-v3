import { describe, expect, it } from "vitest";
import { isReadOnlyOp } from "../../src/core/operations.ts";
import { ADDITIVE, OPEN_WORLD, toolList, TOOLS } from "../../src/worker/mcp/tools.ts";

const listed = (name: string) => toolList().find((tool) => tool.name === name)!;

describe("what tools/list tells a client of each tool", () => {
  it("marks a tool read-only by the rule a read-only token is refused by, and destructive when it writes more than it adds", () => {
    for (const tool of TOOLS) {
      const { annotations } = listed(tool.name);
      const readOnly = tool.op ? isReadOnlyOp(tool.op) : tool.name !== "upload_file";
      expect(annotations.readOnlyHint, tool.name).toBe(readOnly);
      expect(annotations.destructiveHint, tool.name).toBe(!readOnly && !ADDITIVE.has(tool.name));
      expect(annotations.openWorldHint, tool.name).toBe(OPEN_WORLD.has(tool.name));
    }
    const names = TOOLS.map((tool) => tool.name);
    expect([...ADDITIVE].filter((name) => !names.includes(name) || listed(name).annotations.readOnlyHint), "an additive tool that is no tool, or writes nothing").toEqual([]);
    expect([...OPEN_WORLD].filter((name) => !names.includes(name)), "an open-world tool that is no tool").toEqual([]);
  });

  it("says of a few tools what a client would guess of them", () => {
    expect(listed("read_note")).toMatchObject({ title: "Read note", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
    expect(listed("trash_note")).toMatchObject({ title: "Trash note", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } });
    expect(listed("create_note")).toMatchObject({ title: "Create note", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } });
    expect(listed("create_event")).toMatchObject({ title: "Create event", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } });
    expect(listed("list_todos")).toMatchObject({ title: "List todos", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
    expect(listed("query_syntax").annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(listed("upload_file").annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(listed("pin_note").annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  // 120,000 until Email's two tools, which take about 1,200 at their tersest.
  it("stays small enough to send an agent at the start of every session", () => {
    expect(JSON.stringify({ tools: toolList() }).length, "tools/list is read by every agent's model before its first call: describe a tool in fewer words, or move what is long behind a tool such as query_syntax").toBeLessThan(121_000);
  });
});
