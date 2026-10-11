import type { NoteSummary } from "../../plugin-api.ts";

/** The notes a listing covers, out of `app.notes`: live ones, and archived ones when they were asked for. Never one in Trash. */
export const listable = (notes: readonly NoteSummary[], includeArchived: boolean) => notes.filter((n) => n.state === "live" || (includeArchived && n.state === "archived"));
