import { describe, expect, it } from "vitest";
import { noteOf, quoted } from "../../src/web/plugins/email/quoting.ts";

describe("a reply's quoted text", () => {
  it("is folded from the attribution, on one line or two, or from the first quoted line, when only quote follows", () => {
    expect(quoted("Thursday works.\n\nOn Thu, 22 Oct 2026 at 12:00, Ada <ada@example.com> wrote:\n> Shall we meet?\n>\n> Ada")).toEqual({ said: "Thursday works.", quote: "On Thu, 22 Oct 2026 at 12:00, Ada <ada@example.com> wrote:\n> Shall we meet?\n>\n> Ada" });
    expect(quoted("Yes.\n\nOn Thu, 22 Oct 2026 at 12:00, Ada Lovelace\n<ada@example.com> wrote:\n\n> Shall we?")).toEqual({ said: "Yes.", quote: "On Thu, 22 Oct 2026 at 12:00, Ada Lovelace\n<ada@example.com> wrote:\n\n> Shall we?" });
    expect(quoted("See you at ten.\n\n> Thursday works.\n> \n")).toEqual({ said: "See you at ten.", quote: "> Thursday works.\n>" });
    expect(quoted("Fine by me.\n\n-----Original Message-----\nFrom: Grace\nSent: Monday\n\nHello")).toEqual({ said: "Fine by me.", quote: "-----Original Message-----\nFrom: Grace\nSent: Monday\n\nHello" });
  });

  it("isn't folded where a reply is written between quoted lines, where nothing is quoted, or where the message is all quote", () => {
    for (const text of ["> Shall we?\nYes.\n> And Friday?\nNo.", "Just a note.\nOn reflection, I wrote: nothing.", "> Only a quote\n> of something", ""]) expect(quoted(text)).toEqual({ said: text, quote: null });
  });
});

describe("a note made from a thread", () => {
  it("is titled by the subject, links to the thread, and quotes each message's own words under who sent it and when", () => {
    const thread = {
      subject: "Engine\n plans",
      messages: [
        { from: { name: "Ada", address: "ada@example.com" }, sentAt: 1, text: "Shall we meet?\n\nAt ten?" },
        { from: { name: "", address: "grace@example.com" }, sentAt: 2, text: "Yes.\n\n> Shall we meet?" },
      ],
    };
    expect(noteOf(thread, "[[email:aaaaaaaaaaaa]]", (t) => `day ${t}`)).toBe("# Engine plans\n\n[[email:aaaaaaaaaaaa]]\n\n> **Ada** · day 1\n>\n> Shall we meet?\n>\n> At ten?\n\n> **grace@example.com** · day 2\n>\n> Yes.\n");
  });

  it("quotes a long thread from its start until there is no more room", () => {
    const long = { subject: "Long", messages: [1, 2, 3].map((n) => ({ from: { name: `P${n}`, address: "p@x" }, sentAt: n, text: "x".repeat(9_000) })) };
    const text = noteOf(long, "[[email:aaaaaaaaaaaa]]", String);
    expect(text.match(/x/g)!.length).toBe(20_000);
    expect(text).toContain("**P3**");
  });
});
