import { describe, expect, it } from "vitest";
import { stacked, type Told } from "../../src/web/notices.ts";

const told = (id: number, message: string): Told => ({ id, notice: { message } });
const shown = (stack: readonly Told[]) => stack.map((t) => `${t.id} ${t.notice.message}`);

describe("the stack of notices", () => {
  it("puts a new notice at its foot", () => {
    expect(shown(stacked([told(1, "Archived")], told(2, "Task completed")))).toEqual(["1 Archived", "2 Task completed"]);
  });

  it("puts a notice saying what a shown one says in that one's place", () => {
    expect(shown(stacked([told(1, "Task completed"), told(2, "Archived")], told(3, "Task completed")))).toEqual(["3 Task completed", "2 Archived"]);
  });

  it("shows three at most, sending the oldest away", () => {
    const three = [told(1, "Archived"), told(2, "Moved to Trash"), told(3, "Task completed")];
    expect(shown(stacked(three, told(4, "Restored from Trash.")))).toEqual(["2 Moved to Trash", "3 Task completed", "4 Restored from Trash."]);
  });
});
