import { describe, expect, it } from "vitest";
import { ChipWidget, type Chip, type Token } from "../../src/web/plugins/lib/chips.ts";

interface Link extends Token {
  noteId: string;
}

describe("a chip", () => {
  const titles = new Map([["n1", "Plans"]]);
  const link: Chip<Link> = { id: "link", find: () => [], draw: () => {}, key: (token) => titles.get(token.noteId) ?? "" };
  const plain: Chip<Link> = { id: "plain", find: () => [], draw: () => {} };
  const token: Link = { from: 0, to: 6, noteId: "n1" };
  const drawn = (chip: Chip<Link>, written = "[[n1]]", readOnly = false) => new ChipWidget(chip, token, written, readOnly);

  it("is kept as it is drawn while the note writes its token the same way", () => {
    expect(drawn(plain).eq(drawn(plain))).toBe(true);
    expect(drawn(link).eq(drawn(link))).toBe(true);
  });

  it("is drawn again when its token is written another way, or the member can no longer change it", () => {
    expect(drawn(plain).eq(drawn(plain, "[[n2]]"))).toBe(false);
    expect(drawn(plain).eq(drawn(plain, "[[n1]]", true))).toBe(false);
  });

  it("is drawn again when what its key reads outside the note changes, though the note says the same", () => {
    const before = drawn(link);
    titles.set("n1", "Plans for May");

    expect(before.eq(drawn(link))).toBe(false);
    expect(drawn(link).eq(drawn(link))).toBe(true);
  });
});
