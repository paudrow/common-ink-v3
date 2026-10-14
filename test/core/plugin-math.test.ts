import katex from "katex";
import { describe, expect, it } from "vitest";
import { KATEX } from "../../src/web/plugins/math/options.ts";
import { formulasIn, hasMath, mathBlocksIn } from "../../src/web/plugins/math/syntax.ts";

const tex = (line: string) => formulasIn(line).map((f) => f.tex);

describe("a formula in a line", () => {
  it("is what is between two dollar signs, and says where it is", () => {
    expect(formulasIn("so $e = mc^2$ holds", 10)).toEqual([{ from: 13, to: 23, tex: "e = mc^2", display: false }]);
    expect(tex("$a$ and $b+c$")).toEqual(["a", "b+c"]);
  });

  it("is set on its own between doubled dollar signs", () => {
    expect(formulasIn("$$\\int_0^1 x\\,dx$$")).toEqual([{ from: 0, to: 18, tex: "\\int_0^1 x\\,dx", display: true }]);
  });

  it("isn't money, a lone dollar sign, or anything with a space inside the dollars", () => {
    for (const line of ["$5 and $10", "it cost $5, then $6 more", "a $ b $ c", "$ x$", "$x $", "\\$x\\$", "100$", "$$", "$$$"]) expect(tex(line), line).toEqual([]);
  });

  it("beside money on the same line pairs only its own two dollar signs, and a price beside it stays words", () => {
    expect(tex("Inline: $e^{i\\pi} + 1 = 0$ and $\\frac{a}{b}$, while $5 and $10 stay money.")).toEqual(["e^{i\\pi} + 1 = 0", "\\frac{a}{b}"]);
    expect(tex("It costs $5 and $\\frac{a}{b}$ of it, or $x$.")).toEqual(["\\frac{a}{b}", "x"]);
    expect(tex("$\\frac{a}{b}$ costs $5.")).toEqual(["\\frac{a}{b}"]);
  });

  it("can hold a dollar sign written \\$", () => {
    expect(tex("$\\$5 + x$")).toEqual(["\\$5 + x"]);
  });
});

describe("a block of math", () => {
  it("is the lines between two lines that are only $$", () => {
    const note = "# Sums\n\n$$\n\\sum_{i=1}^n i\n= \\frac{n(n+1)}{2}\n$$\n\nAfter.";

    expect(mathBlocksIn(note.split("\n"))).toEqual([{ from: 8, to: 8 + "$$\n\\sum_{i=1}^n i\n= \\frac{n(n+1)}{2}\n$$".length, tex: "\\sum_{i=1}^n i\n= \\frac{n(n+1)}{2}", display: true, lines: 4 }]);
  });

  it("counts every line the note writes it on, blank ones too", () => {
    expect(mathBlocksIn("$$\n\nx\n\n$$".split("\n"))).toMatchObject([{ tex: "x", lines: 5 }]);
  });

  it("isn't one without its closing line, or inside a code fence", () => {
    expect(mathBlocksIn("$$\nx\n\nnever closed".split("\n"))).toEqual([]);
    expect(mathBlocksIn("```\n$$\nx\n$$\n```".split("\n"))).toEqual([]);
    expect(mathBlocksIn("```\ncode\n```\n$$\nx\n$$".split("\n")).map((b) => b.tex)).toEqual(["x"]);
  });
});

describe("whether a note has math worth loading the drawing for", () => {
  it("is so for a formula in a line or a block, and not for a price or a lone dollar sign", () => {
    expect(["so $x^2$ holds", "$$\nx\n$$", "a\n$$ y $$\nb"].map(hasMath)).toEqual([true, true, true]);
    expect(["it cost $5", "from $5 to $10", "$", "$$\nnever closed", "\\$x\\$"].map(hasMath)).toEqual([false, false, false, false, false]);
  });
});

describe("how a formula is drawn", () => {
  const drawn = (formula: string) => katex.renderToString(formula, KATEX);

  it("draws math", () => {
    expect(drawn("\\frac{a}{b}")).toContain('class="mfrac"');
  });

  it("never makes a link, an image, or markup of the note's choosing", () => {
    for (const formula of [
      "\\href{javascript:alert(1)}{click}",
      "\\href{https://example.com}{click}",
      "\\url{https://example.com}",
      "\\includegraphics{https://example.com/pixel.png}",
      "\\htmlData{onclick=alert(1)}{x}",
      "\\htmlClass{evil}{x}",
      "\\htmlStyle{background:url(https://example.com)}{x}",
      "\\htmlId{app}{x}",
    ]) {
      const html = drawn(formula);
      // The formula's own text is in the drawing as text. What must not be there is an element or an attribute it chose.
      expect(html, formula).not.toMatch(/<a\b|<img\b|<[^>]*\s(href|src|id|on\w+|data-[\w-]+)=|class="[^"]*\bevil\b|style="[^"]*(url\(|background)/i);
    }
  });

  it("shows a formula it can't read as text, with no markup from it", () => {
    const html = drawn("\\frac{<img src=x onerror=alert(1)>");

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("stops a formula that expands without end", () => {
    expect(drawn("\\def\\x{\\x\\x}\\x")).toContain("katex-error");
  });
});
