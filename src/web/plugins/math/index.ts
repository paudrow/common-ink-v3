import type { Plugin } from "../../plugin-api.ts";
import { drawnMath } from "../lib/drawnMath.ts";
import { whenSeen } from "../lib/live.ts";
import { mathBlocks, type Heights } from "./blocks.ts";
import { hasMath } from "./syntax.ts";

/** How many formulas' heights are kept between visits. */
const KEPT = 400;

const isHeights = (value: unknown): value is Record<string, number> => typeof value === "object" && value !== null && Object.values(value).every((height) => typeof height === "number");

/**
 * LaTeX in a note, drawn as math: `$…$` in a line, and `$$…$$` on lines of its own. The drawing is
 * loaded the first time a note on screen has a formula in it, so a member who writes no math never
 * carries it, and a price doesn't fetch it. A drawn table draws the formulas in its cells the same way.
 */
export const math: Plugin = {
  id: "math",
  name: "LaTeX",
  description: "Formulas written between $ signs, drawn as math.",
  icon: "math",
  activate(host) {
    let stopped = false;
    let drawn = false;
    const kept = host.storage.get("heights");
    const heights: Heights = {
      drawn: new Map(Object.entries(isHeights(kept) ? kept : {})),
      written: new Map(),
      learned: () => host.storage.set("heights", Object.fromEntries([...heights.drawn].slice(-KEPT))),
    };
    const blocks = mathBlocks(heights, () => drawn);
    const load = () =>
      import("./rendering.ts").then(
        ({ mathRendering, facesLoaded, draw }) =>
          facesLoaded().then(() => {
            if (stopped) return;
            drawn = true;
            host.editorExtensions.register({ id: "math", extension: mathRendering(blocks, heights) });
            drawnMath.set(draw);
          }),
        () => !stopped && host.report(new Error("The math couldn't be loaded, so formulas are shown as written. Reload the page to try again.")),
      );
    host.editorExtensions.register({ id: "math.blocks", extension: [blocks.extension, whenSeen(hasMath, load)] });
    return () => {
      stopped = true;
      drawnMath.set(null);
    };
  },
};
