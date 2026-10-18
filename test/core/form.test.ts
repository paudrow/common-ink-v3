import { describe, expect, it } from "vitest";
import { castVote, parseForm, replaceQuestions, serializeForm, setAnswer, setOther, showsOther, type AnonymousForm, type NamedForm } from "../../src/web/plugins/forms/form.ts";

const one = (over: Partial<NamedForm> = {}): NamedForm => ({
  questions: [{ id: "q", type: "one", prompt: "Pick", options: ["A", "B"] }],
  answers: {},
  ...over,
});

describe("a named form", () => {
  it("stores a member's choice and leaves another member's where it was", () => {
    const ada = setAnswer(one(), "ada", "q", "A");
    const both = setAnswer(ada, "grace", "q", "B");

    expect(both.answers).toEqual({ ada: { q: "A" }, grace: { q: "B" } });
  });

  it("clears a choice that is clicked again", () => {
    const picked = setAnswer(one(), "ada", "q", "A");

    expect(setAnswer(picked, "ada", "q", "A").answers).toEqual({});
  });

  it("keeps only the latest member when the form takes one answer", () => {
    const form = one({
      mode: "one",
      questions: [
        { id: "q", type: "one", prompt: "Pick", options: ["A", "B"] },
        { id: "r", type: "one", prompt: "Also", options: ["A", "B"] },
      ],
    });
    const ada = setAnswer(setAnswer(form, "ada", "q", "A"), "ada", "r", "B");

    expect(ada.answers).toEqual({ ada: { q: "A", r: "B" } });
    expect(setAnswer(ada, "grace", "q", "B").answers).toEqual({ grace: { q: "B", r: "B" } });
  });

  it("keeps an Other line with the choice, and drops it when the form or the question says so", () => {
    const ada = setOther(setAnswer(one(), "ada", "q", "A"), "ada", "q", "the date moved");
    expect(ada.other).toEqual({ ada: { q: "the date moved" } });
    expect(ada.answers).toEqual({ ada: { q: "A" } });

    const shared = setAnswer(one({ mode: "one", other: { ada: { q: "because" } }, answers: { ada: { q: "A" } } }), "grace", "q", "B");
    expect(shared.answers).toEqual({ grace: { q: "B" } });
    expect(shared.other).toEqual({ grace: { q: "because" } });

    expect(setOther(one({ explain: false }), "ada", "q", "no")).toEqual(one({ explain: false }));
    const hidden: NamedForm = { questions: [{ id: "q", type: "one", prompt: "Pick", options: ["A", "B"], explain: false }], answers: {} };
    expect(setOther(hidden, "ada", "q", "no")).toBe(hidden);
    const forced = one({ explain: false, questions: [{ id: "q", type: "one", prompt: "Pick", options: ["A", "B"], explain: true }] });
    expect(showsOther(forced, forced.questions[0]!)).toBe(true);
    expect(setOther(forced, "ada", "q", "yes").other).toEqual({ ada: { q: "yes" } });
    expect(setOther(ada, "ada", "q", "").other).toBeUndefined();
  });

  it("refuses a member who was not asked, and takes one who was", () => {
    const form = one({ ask: ["ada"] });

    expect(setAnswer(form, "grace", "q", "A")).toBe(form);
    expect(setAnswer(form, "ada", "q", "A").answers).toEqual({ ada: { q: "A" } });
  });

  it("refuses everyone once the form is closed", () => {
    const form = one({ closed: true });

    expect(setAnswer(form, "ada", "q", "A")).toBe(form);
  });

  it("clears one entry of several, a scale point, a grid row, an image, and a text field emptied", () => {
    const several: NamedForm = { questions: [{ id: "q", type: "several", prompt: "Pick", options: ["A", "B"] }], answers: {} };
    const picked = setAnswer(setAnswer(several, "ada", "q", "A"), "ada", "q", "B");
    expect(picked.answers).toEqual({ ada: { q: ["A", "B"] } });
    expect(setAnswer(picked, "ada", "q", "A").answers).toEqual({ ada: { q: ["B"] } });

    const scale: NamedForm = { questions: [{ id: "q", type: "scale", prompt: "How" }], answers: {} };
    expect(setAnswer(setAnswer(scale, "ada", "q", 4), "ada", "q", 4).answers).toEqual({});

    const grid: NamedForm = {
      questions: [
        {
          id: "q",
          type: "grid",
          prompt: "Grid",
          rows: [
            { id: "r1", label: "R1" },
            { id: "r2", label: "R2" },
          ],
          cols: [
            { id: "c1", label: "C1" },
            { id: "c2", label: "C2" },
          ],
        },
      ],
      answers: {},
    };
    const cells = setAnswer(setAnswer(grid, "ada", "q", { r1: "c1" }), "ada", "q", { r2: "c2" });
    expect(cells.answers).toEqual({ ada: { q: { r1: "c1", r2: "c2" } } });
    expect(setAnswer(cells, "ada", "q", { r1: "c1" }).answers).toEqual({ ada: { q: { r2: "c2" } } });

    const image: NamedForm = { questions: [{ id: "q", type: "image", prompt: "Pic", options: [{ id: "cat", label: "Cat" }] }], answers: {} };
    expect(setAnswer(setAnswer(image, "ada", "q", "cat"), "ada", "q", "cat").answers).toEqual({});

    const text: NamedForm = { questions: [{ id: "q", type: "short", prompt: "Why" }], answers: {} };
    expect(setAnswer(setAnswer(text, "ada", "q", "because"), "ada", "q", "").answers).toEqual({});
  });

  it("leaves an illegal choice and a missing question untouched", () => {
    const form = one();

    expect(setAnswer(form, "ada", "q", "Z")).toBe(form);
    expect(setAnswer(form, "ada", "missing", "A")).toBe(form);
  });
});

describe("reading and writing the form", () => {
  it("keeps a key it does not know through an answer and back out", () => {
    const form = parseForm(`{
      "kept": { "n": 1 },
      "questions": [{ "id": "q", "type": "one", "prompt": "Pick", "options": ["A"], "note": "x" }],
      "answers": {}
    }`);
    if (!form || form.anonymous) throw new Error("expected a named form");

    const next = setAnswer(form, "ada", "q", "A");

    expect(next).toMatchObject({ kept: { n: 1 } });
    expect(parseForm(serializeForm(next))).toMatchObject({
      kept: { n: 1 },
      questions: [{ id: "q", note: "x", prompt: "Pick", type: "one" }],
      answers: { ada: { q: "A" } },
    });
    expect(serializeForm(next)).toBe(`{
  "answers": {
    "ada": {
      "q": "A"
    }
  },
  "kept": {
    "n": 1
  },
  "questions": [
    {
      "id": "q",
      "note": "x",
      "options": [
        "A"
      ],
      "prompt": "Pick",
      "type": "one"
    }
  ]
}
`);
  });

  it("stores a dropdown, a date, several images, and more than one cell in a row", () => {
    const form: NamedForm = {
      questions: [
        { id: "d", type: "dropdown", prompt: "Pick", options: ["A", "B"] },
        { id: "when", type: "date", prompt: "When" },
        { id: "pics", type: "image", prompt: "Pics", several: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        { id: "g", type: "grid", prompt: "Grid", several: true, rows: [{ id: "r", label: "Row" }], cols: [{ id: "c", label: "Col" }, { id: "d", label: "Other" }] },
      ],
      answers: {},
    };

    expect(setAnswer(form, "ada", "d", "A").answers.ada?.d).toBe("A");
    expect(setAnswer(form, "ada", "when", "not-a-date")).toBe(form);
    expect(setAnswer(form, "ada", "when", "2026-10-18").answers.ada?.when).toBe("2026-10-18");
    expect(setAnswer(setAnswer(form, "ada", "pics", "a"), "ada", "pics", "b").answers.ada?.pics).toEqual(["a", "b"]);
    expect(setAnswer(setAnswer(form, "ada", "g", { r: "c" }), "ada", "g", { r: "d" }).answers.ada?.g).toEqual({ r: ["c", "d"] });
  });

  it("drops an answer when its question is replaced with one the answer does not fit", () => {
    const stored = setAnswer(one(), "ada", "q", "A");
    const next = replaceQuestions(stored, [{ id: "q", type: "dropdown", prompt: "Pick", options: ["B"] }]);

    expect(next.questions).toEqual([{ id: "q", type: "dropdown", prompt: "Pick", options: ["B"] }]);
    expect("answers" in next && next.answers).toEqual({});
  });

  it("returns null for what is not a form", () => {
    expect(parseForm("nope")).toBeNull();
    expect(parseForm("")).toBeNull();
    expect(parseForm("{")).toBeNull();
    expect(parseForm("[]")).toBeNull();
    expect(parseForm("null")).toBeNull();
    expect(parseForm('{"questions":"no"}')).toBeNull();
    expect(
      parseForm(
        JSON.stringify({
          questions: [
            { id: "q", type: "short", prompt: "A" },
            { id: "q", type: "short", prompt: "B" },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("an anonymous form", () => {
  const form: AnonymousForm = {
    anonymous: true,
    questions: [
      { id: "q", type: "one", prompt: "Pick", options: ["A", "B"] },
      { id: "s", type: "several", prompt: "Many", options: ["A", "B"] },
      { id: "n", type: "scale", prompt: "How" },
      { id: "g", type: "grid", prompt: "Grid", rows: [{ id: "r", label: "R" }], cols: [{ id: "c", label: "C" }] },
      { id: "i", type: "image", prompt: "Pic", options: [{ id: "cat", label: "Cat" }] },
      { id: "t", type: "paragraph", prompt: "Why" },
    ],
    tallies: {},
    texts: {},
    voted: [],
  };

  it("counts the vote, keeps the text, and ignores a second cast by the same member", () => {
    const once = castVote(form, "ada", { q: "A", s: ["A", "B"], n: 5, g: { r: "c" }, i: "cat", t: "because" });
    const twice = castVote(once, "grace", { q: "A", t: "same" });

    expect(once.tallies).toEqual({ q: { A: 1 }, s: { A: 1, B: 1 }, n: { "5": 1 }, g: { "r:c": 1 }, i: { cat: 1 } });
    expect(once.texts).toEqual({ t: ["because"] });
    expect(once.voted).toEqual(["ada"]);
    expect(twice.tallies.q).toEqual({ A: 2 });
    expect(twice.texts.t).toEqual(["because", "same"]);
    const later = castVote(castVote(form, "ada", { t: "zebra" }), "grace", { t: "apple" });
    expect(later.voted).toEqual(["ada", "grace"]);
    expect(later.texts.t).toEqual(["apple", "zebra"]);
    expect(twice.voted).toEqual(["ada", "grace"]);
    expect(castVote(twice, "ada", { q: "B", t: "no" })).toBe(twice);
  });

  it("refuses a member who was not asked and a form that is closed", () => {
    const asked: AnonymousForm = { ...form, ask: ["ada"] };
    const closed: AnonymousForm = { ...form, closed: true };

    expect(castVote(asked, "grace", { q: "A" })).toBe(asked);
    expect(castVote(closed, "ada", { q: "A" })).toBe(closed);
    expect(castVote(asked, "ada", { q: "A" }).voted).toEqual(["ada"]);
  });

  it("keeps an Other line with the tallies, and not in vote order", () => {
    const once = castVote(form, "ada", { q: "A" }, { q: "zebra" });
    const twice = castVote(once, "grace", { q: "B" }, { q: "apple" });

    expect(twice.tallies.q).toEqual({ A: 1, B: 1 });
    expect(twice.voted).toEqual(["ada", "grace"]);
    expect(twice.texts.q).toEqual(["apple", "zebra"]);
    expect(castVote(form, "ada", { q: "A" }, { q: "" }).texts.q).toBeUndefined();
  });
});
