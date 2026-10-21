import { describe, expect, it } from "vitest";
import { grouped } from "../../src/web/completionGroups.ts";

type Item = { label: string; kind?: string };
const shown = (items: Item[]) => grouped(items, (item) => item.kind).map(({ item, group }) => (group ? `${group.heading} ${group.rank}: ${item.label}` : item.label));

describe("the groups of a list at the cursor", () => {
  it("are by kind, people then dates then notes then uploads then events, each kind's items in the order given", () => {
    const items = [
      { label: "Standup", kind: "event" },
      { label: "Road map", kind: "note" },
      { label: "harbour.png", kind: "upload" },
      { label: "Ada", kind: "person" },
      { label: "Roadmap draft", kind: "note" },
      { label: "Grace", kind: "person" },
      { label: "Tomorrow", kind: "date" },
    ];
    expect(shown(items)).toEqual(["People 0: Ada", "People 0: Grace", "Dates 1: Tomorrow", "Notes 2: Road map", "Notes 2: Roadmap draft", "Uploads 3: harbour.png", "Events 4: Standup"]);
  });

  it("are headed only where the list holds more than one kind", () => {
    expect(shown([{ label: "Ada", kind: "person" }, { label: "Grace", kind: "person" }])).toEqual(["Ada", "Grace"]);
  });

  it("come after the items of no kind, which keep their order under no heading, as does a kind that isn't one", () => {
    const items = [{ label: "Standup", kind: "event" }, { label: "Timer" }, { label: "Plan", kind: "note" }, { label: "Odd", kind: "weather" }, { label: "Board" }];
    expect(shown(items)).toEqual(["Timer", "Odd", "Board", "Notes 2: Plan", "Events 4: Standup"]);
  });
});
