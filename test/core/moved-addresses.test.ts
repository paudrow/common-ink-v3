import { describe, expect, it } from "vitest";
import { movedTo } from "../../src/web/moved.ts";

describe("an address that moved", () => {
  it("is where it is now, with its query and fragment kept", () => {
    expect(movedTo("/settings/json")).toBe("/settings.json");
    expect(movedTo("/settings/json?from=bookmark#top")).toBe("/settings.json?from=bookmark#top");
  });

  it("leaves every other address as it is, a category of Settings among them", () => {
    expect(movedTo("/settings/keyboard")).toBe("/settings/keyboard");
    expect(movedTo("/settings/json/more")).toBe("/settings/json/more");
    expect(movedTo("/note/plan-k3j5h8d9f0a1")).toBe("/note/plan-k3j5h8d9f0a1");
  });
});
