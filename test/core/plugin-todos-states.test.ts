import { describe, expect, it } from "vitest";
import { stateOf, withState } from "../../src/web/plugins/todos/states.ts";

describe("choosing todos by state", () => {
  it("writes the choice at the end of what was typed, as typed", () => {
    expect(withState("", "done")).toBe("is:done");
    expect(withState("call #home due:<today", "backlog")).toBe("call #home due:<today is:backlog");
    expect(withState("  #home  ", "open")).toBe("#home is:open");
    expect(withState("#home", "all")).toBe("#home (is:open OR is:backlog OR is:done OR is:abandoned)");
  });

  it("replaces the states the bar named", () => {
    expect(withState("is:done #home", "open")).toBe("#home is:open");
    expect(withState("#home (is:open OR is:done) sort:priority-desc", "abandoned")).toBe("#home sort:priority-desc is:abandoned");
    expect(withState("#home (is:open OR is:backlog OR is:done OR is:abandoned)", "done")).toBe("#home is:done");
    expect(withState("is:open OR is:done", "backlog")).toBe("is:backlog");
  });

  it("keeps what isn't a todo's state", () => {
    expect(withState("is:archived is:done", "open")).toBe("is:archived is:open");
  });

  it("asks for the choice beside a bar that asks for one thing or another", () => {
    expect(withState("#a OR #b", "done")).toBe("(tag:a OR tag:b) is:done");
    expect(withState("(#a is:done) OR (#b is:done)", "open")).toBe("(tag:a OR tag:b) is:open");
    expect(withState("(#a OR #b) is:done", "open")).toBe("(#a OR #b) is:open");
  });

  it("keeps what was typed in a bar that can't be read, its order with it", () => {
    expect(withState("#home (call", "done")).toBe("#home (call is:done");
    expect(withState("sort:priority-desc (call is:backlog", "done")).toBe("sort:priority-desc (call is:done");
  });

  it("takes out a state typed in capitals", () => {
    expect(withState("IS:DONE #home", "open")).toBe("#home is:open");
  });
});

describe("the state choice the bar shows", () => {
  it("is Open when the bar names no state", () => {
    expect(stateOf("")).toBe("open");
    expect(stateOf("call #home due:<today")).toBe("open");
    expect(stateOf("is:archived")).toBe("open");
  });

  it("is the state the bar asks for beside everything else", () => {
    expect(stateOf("is:open")).toBe("open");
    expect(stateOf("#home is:backlog")).toBe("backlog");
    expect(stateOf("is:done sort:updated-desc")).toBe("done");
    expect(stateOf("call is:abandoned")).toBe("abandoned");
    expect(stateOf("(is:done OR is:open OR is:abandoned OR is:backlog) #home")).toBe("all");
  });

  it("is none for states no choice is, or named another way", () => {
    expect(stateOf("is:open OR is:done")).toBeNull();
    expect(stateOf("-is:done")).toBeNull();
    expect(stateOf("is:done is:open")).toBeNull();
    expect(stateOf("is:done OR #home")).toBeNull();
    expect(stateOf("(call")).toBeNull();
  });

  it("reads back each choice it writes", () => {
    for (const choice of ["open", "backlog", "done", "abandoned", "all"] as const)
      for (const bar of ["", "#home is:done", "#a OR #b", "call (is:open OR is:done) sort:due-desc"]) expect(stateOf(withState(bar, choice))).toBe(choice);
  });
});
