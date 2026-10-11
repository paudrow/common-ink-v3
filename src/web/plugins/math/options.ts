import type { KatexOptions } from "katex";

/**
 * How every formula is drawn. A note's text is someone else's input, so nothing in a formula may
 * reach the network or the page: `trust` is off, which leaves `\href`, `\url`, `\includegraphics`
 * and the `\html…` commands undrawn, and a formula that can't be read is shown as its own text
 * in the error color. The limits keep a formula that expands without end from holding the page.
 */
export const KATEX: KatexOptions = { throwOnError: false, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 50, output: "htmlAndMathml" };
