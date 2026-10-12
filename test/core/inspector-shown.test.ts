import { describe, expect, it } from "vitest";
import { pickView } from "../../src/web/inspectorPick.ts";

const history = { id: "history", label: "History", badge: () => "Changes you haven't seen" };
const backlinks = { id: "backlinks", label: "Backlinks" };
const info = { id: "info", label: "Info" };
const folderInfo = { id: "folder-info", label: "Info" };
const all = [history, backlinks, info, folderInfo];

describe("the inspector's tab", () => {
  it("is the one picked, or the one of the same name, and Info with nothing picked", () => {
    expect(pickView(all, [history, backlinks, info], "backlinks")).toBe(backlinks);
    expect(pickView(all, [history, folderInfo], "info")).toBe(folderInfo);
    expect(pickView(all, [history, backlinks, info], null)).toBe(info);
  });

  it("is the first with no badge when the one asked for isn't there, never History ahead of it", () => {
    expect(pickView(all, [history, backlinks], null)).toBe(backlinks);
    expect(pickView(all, [history, backlinks], "info")).toBe(backlinks);
  });

  it("is History when History was picked, or is all there is", () => {
    expect(pickView(all, [history, backlinks], "history")).toBe(history);
    expect(pickView(all, [history], null)).toBe(history);
  });
});
