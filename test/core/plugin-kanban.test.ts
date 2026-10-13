import { describe, expect, it } from "vitest";
import { addCard, cardEnd, cardsOf, colourColumn, moveCard, parseBoard, serializeBoard } from "../../src/web/plugins/kanban/board.ts";

const titles = (body: string) => parseBoard(body).columns.map((c) => [c.title, cardsOf(c).map((card) => card.text)]);
const moved = (body: string, from: [number, number], to: [number, number]) => serializeBoard(moveCard(parseBoard(body), { column: from[0], card: from[1] }, { column: to[0], card: to[1] }));

const BOARD = "## To do\n- write\n- review\n\n## Doing\n- build\n\n## Done\n";

describe("a kanban board read from markdown", () => {
  it("has a column for each heading and a card for each list item under it", () => {
    expect(titles(BOARD)).toEqual([
      ["To do", ["write", "review"]],
      ["Doing", ["build"]],
      ["Done", []],
    ]);
    expect(titles("# One #\n* a\n+ b\n1. c\n2) d\n###### Two\n")).toEqual([
      ["One", ["a", "b", "c", "d"]],
      ["Two", []],
    ]);
  });

  it("keeps what is nested under a list item with its card", () => {
    const board = parseBoard("## To do\n- write\n  - the intro\n\n  more on it\n- review\n");
    const [write, review] = cardsOf(board.columns[0]!);

    expect([write!.text, write!.more]).toEqual(["write", "- the intro\n\nmore on it"]);
    expect([review!.text, review!.more]).toEqual(["review", ""]);
  });

  it("writes back exactly the markdown it read, whatever that holds", () => {
    const bodies = [
      BOARD,
      "",
      "\n",
      "no headings at all\n- not a card\n",
      "intro line\n\n## To do\n\nA paragraph between.\n\n- a\n\n- b\n   \n## Done\n",
      "## To do\n- a\n  - nested\n\n    deep text\n- [ ] a checkbox\n> a quote\n| a | table |\n",
      "## Code\n```\n## not a column\n- not a card\n```\n- real\n",
      "## To do\r\n- windows\r\n",
      "Setext\n======\n- before any column\n## Col\n\t- tabbed under nothing\n- a\n\n\n\n",
      "## A\n## B\n## C",
      "## To do\n- a ::timer{5m} here\n<div>html</div>\n- b\n",
    ];
    for (const body of bodies) expect(serializeBoard(parseBoard(body))).toBe(body);
  });

  it("keeps a line that carries a list item on with its card, and stops at a blank line, a fence, or a rule", () => {
    const board = parseBoard("## A\n- a\ncontinued line\n  and indented\nstill going\n\nA paragraph of its own.\n- b\n```\n- not a card\n```\n- c\n> quoted\n## B\n");

    expect(cardsOf(board.columns[0]!).map((c) => [c.text, c.more])).toEqual([
      ["a", "continued line\n  and indented\nstill going"],
      ["b", ""],
      ["c", "> quoted"],
    ]);
  });

  it("reads a rule across the page as no card", () => {
    expect(titles("## A\n- a\n* * *\n- b\n---\n- - -\n***\n___\n## B\n")).toEqual([
      ["A", ["a", "b"]],
      ["B", []],
    ]);
  });

  it("reads a heading or a list inside a code fence as neither", () => {
    expect(titles("## Code\n```\n## not a column\n- not a card\n```\n- real\n")).toEqual([["Code", ["real"]]]);
    expect(titles("- before any column\n## Col\n- a\n")).toEqual([["Col", ["a"]]]);
  });
});

describe("moving a card", () => {
  it("moves its line to another column, after the cards there", () => {
    expect(moved(BOARD, [0, 0], [1, 1])).toBe("## To do\n- review\n\n## Doing\n- build\n- write\n\n## Done\n");
  });

  it("moves it before a card, and within its own column", () => {
    expect(moved(BOARD, [0, 1], [1, 0])).toBe("## To do\n- write\n\n## Doing\n- review\n- build\n\n## Done\n");
    expect(moved(BOARD, [0, 0], [0, 1])).toBe("## To do\n- review\n- write\n\n## Doing\n- build\n\n## Done\n");
    expect(moved(BOARD, [0, 1], [0, 0])).toBe("## To do\n- review\n- write\n\n## Doing\n- build\n\n## Done\n");
  });

  it("puts a card in an empty column under its heading, ahead of the blank lines that end it", () => {
    expect(moved(BOARD, [1, 0], [2, 0])).toBe("## To do\n- write\n- review\n\n## Doing\n\n## Done\n- build\n");
    expect(moved("## A\n- x\n## B\n\n## C\n", [0, 0], [1, 0])).toBe("## A\n## B\n- x\n\n## C\n");
    expect(moved("## A\n- x\n## B", [0, 0], [1, 0])).toBe("## A\n## B\n- x");
  });

  it("takes what is nested under the card with it, and leaves everything else where it was", () => {
    const body = "intro\n## To do\n\nA note to self.\n\n- a\n  - nested\n\n  more\n- b\n\n## Done\n\n- c\n\ntrailing words\n";

    expect(moved(body, [0, 0], [1, 1])).toBe("intro\n## To do\n\nA note to self.\n\n- b\n\n## Done\n\n- c\n- a\n  - nested\n\n  more\n\ntrailing words\n");
  });

  it("takes the lines that carry the card on with it, and leaves a rule where it was", () => {
    expect(moved("## A\n- a\ncontinued line\n- b\n## B\n", [0, 0], [1, 0])).toBe("## A\n- b\n## B\n- a\ncontinued line\n");
    expect(moved("## A\n- a\n* * *\n- b\n## B\n", [0, 0], [1, 0])).toBe("## A\n* * *\n- b\n## B\n- a\n");
    expect(moved("## A\n- a\n* * *\n- b\n## B\n", [0, 1], [1, 0])).toBe("## A\n- a\n* * *\n## B\n- b\n");
  });

  it("leaves the board as it is for a card or a column that isn't there", () => {
    const board = parseBoard(BOARD);
    expect(moveCard(board, { column: 0, card: 5 }, { column: 1, card: 0 })).toBe(board);
    expect(moveCard(board, { column: 0, card: 0 }, { column: 9, card: 0 })).toBe(board);
    expect(moveCard(board, { column: 0, card: 0 }, { column: 1, card: -1 })).toBe(board);
    expect(moved(BOARD, [0, 0], [1, 99])).toBe(moved(BOARD, [0, 0], [1, 1]));
  });

  it("loses no line of the board, wherever a card goes", () => {
    const body = "intro\n## To do\n\ntext\n- a\n  - nested\n- b\n\n## Doing\n```\n- fenced\n```\n- c\n## Done\n\n";
    const lines = (text: string) => text.split("\n").sort();
    const board = parseBoard(body);
    board.columns.forEach((from, f) =>
      cardsOf(from).forEach((_, i) =>
        board.columns.forEach((to, t) => {
          for (let at = 0; at <= cardsOf(to).length; at++) expect(lines(moved(body, [f, i], [t, at]))).toEqual(lines(body));
        }),
      ),
    );
  });
});

describe("adding a card", () => {
  it("adds a list item to the end of a column, with the marker the board uses", () => {
    expect(serializeBoard(addCard(parseBoard(BOARD), 2, "  ship\nit "))).toBe("## To do\n- write\n- review\n\n## Doing\n- build\n\n## Done\n- ship it\n");
    expect(serializeBoard(addCard(parseBoard("## A\n* x\n\n## B\n"), 0, "y"))).toBe("## A\n* x\n* y\n\n## B\n");
    expect(serializeBoard(addCard(parseBoard("## A\n3. x\n"), 0, "y"))).toBe("## A\n3. x\n1. y\n");
  });

  it("adds nothing for an empty card or a column that isn't there", () => {
    const board = parseBoard(BOARD);
    expect(addCard(board, 0, "  ")).toBe(board);
    expect(addCard(board, 7, "x")).toBe(board);
  });
});

describe("a column's colour", () => {
  const coloured = (body: string, column: number, colour: Parameters<typeof colourColumn>[2]) => serializeBoard(colourColumn(parseBoard(body), column, colour));

  it("is read from the end of its heading, and is not part of its title", () => {
    expect(parseBoard("## Doing {.blue}\n- build\n# Done{.green} #\n").columns.map((c) => [c.title, c.colour, cardsOf(c).length])).toEqual([
      ["Doing", "blue", 1],
      ["Done", "green", 0],
    ]);
  });

  it("leaves braces that name no colour in the title", () => {
    expect(parseBoard("## Doing {.teal}\n## {.blue} first\n## Later {blue}\n").columns.map((c) => [c.title, c.colour])).toEqual([
      ["Doing {.teal}", null],
      ["{.blue} first", null],
      ["Later {blue}", null],
    ]);
  });

  it("is set, changed and taken away by rewriting the end of the heading and nothing else", () => {
    expect(coloured(BOARD, 1, "blue")).toBe(BOARD.replace("## Doing\n", "## Doing {.blue}\n"));
    expect(coloured(BOARD.replace("## Doing\n", "## Doing {.blue}\n"), 1, "red")).toBe(BOARD.replace("## Doing\n", "## Doing {.red}\n"));
    expect(coloured(BOARD.replace("## Doing\n", "## Doing {.blue}\n"), 1, null)).toBe(BOARD);
    expect(coloured("#  One ##  \n- a\n", 0, "pink")).toBe("#  One {.pink} ##  \n- a\n");
    expect(coloured("## Doing {.teal}\n", 0, "gray")).toBe("## Doing {.teal} {.gray}\n");
  });

  it("changes nothing for the colour a column has or a column that isn't there", () => {
    const board = parseBoard(BOARD);
    expect(colourColumn(board, 0, null)).toBe(board);
    expect(colourColumn(board, 9, "blue")).toBe(board);
  });

  it("stays with its column when a card is moved or added", () => {
    const body = "## To do {.red}\n- write\n\n## Done {.green}\n";
    expect(moved(body, [0, 0], [1, 0])).toBe("## To do {.red}\n\n## Done {.green}\n- write\n");
    expect(serializeBoard(addCard(parseBoard(body), 1, "ship"))).toBe("## To do {.red}\n- write\n\n## Done {.green}\n- ship\n");
  });
});

describe("where a card is written", () => {
  const body = "intro\n## To do\n\n- write\n  - the intro\n- review\n\n## Done\n- plan\n";
  const board = parseBoard(body);

  it("is the end of the card's own line, counted from the start of the board's markdown", () => {
    expect(body.slice(0, cardEnd(board, { column: 0, card: 0 })!)).toBe("intro\n## To do\n\n- write");
    expect(body.slice(0, cardEnd(board, { column: 0, card: 1 })!)).toBe("intro\n## To do\n\n- write\n  - the intro\n- review");
    expect(body.slice(0, cardEnd(board, { column: 1, card: 0 })!)).toBe("intro\n## To do\n\n- write\n  - the intro\n- review\n\n## Done\n- plan");
  });

  it("is nowhere for a place with no card", () => {
    expect(cardEnd(board, { column: 1, card: 1 })).toBeNull();
    expect(cardEnd(board, { column: 2, card: 0 })).toBeNull();
  });
});
