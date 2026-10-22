import { MAX_NOTES_AT_ONCE, nameKey, type Notice, type PluginHost, type RenamedTag } from "../../plugin-api.ts";

export const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

/** What the confirmation of a rename says it will do, from a preview of it. */
export function confirmation(plan: RenamedTag): string {
  const changing = plan.renamed.length;
  const own = plan.descriptions.find((d) => nameKey(d.name) === nameKey(plan.name));
  const words = [changing ? `Rename #${plan.name} to #${plan.to} in ${notes(changing)}?` : `No note you can change has #${plan.name}.`];
  if (changing && plan.under.length) words.push(plan.under.length === 1 ? `#${plan.under[0]} goes with it.` : `The ${plan.under.length} tags under it go with it.`);
  if (plan.merged) words.push(`#${plan.to} is already a tag, so the two become one.`);
  if (changing && own?.description && nameKey(plan.name) !== nameKey(plan.to)) words.push(own.toDescribed ? `#${plan.to} keeps its own description.` : "Its description goes with it.");
  if (plan.skipped) words.push(`${notes(plan.skipped)} you can't change ${plan.skipped === 1 ? "keeps" : "keep"} #${plan.name}.`);
  if (changing) words.push("Each note's history has the change, and Undo puts them all back.");
  return words.join(" ");
}

/** What the notice after a rename says it did. */
export function renamedWords(done: RenamedTag): string {
  const failed = done.failed ? ` ${notes(done.failed)} couldn't be changed and ${done.failed === 1 ? "keeps" : "keep"} #${done.name}.` : "";
  return `Renamed #${done.name} to #${done.to} in ${notes(done.renamed.length)}.${failed}`;
}

/**
 * Takes a rename back: each note's change is reverted, as many at once as a revert takes, and each
 * description the rename moved is said again with its old name, and taken from the name it went to
 * where the rename wrote it there. A note changed since keeps its change, and the notice says how many.
 */
export async function undoRename(host: PluginHost, done: RenamedTag): Promise<Notice> {
  let kept = 0;
  for (let at = 0; at < done.renamed.length; at += MAX_NOTES_AT_ONCE) {
    const some = done.renamed.slice(at, at + MAX_NOTES_AT_ONCE);
    const { skipped } = await host.perform({ type: "history.revert", changes: some.map((note) => ({ noteId: note.noteId, revisions: [note.revision] })) });
    kept += skipped.length;
  }
  for (const moved of done.descriptions) {
    await host.perform({ type: "tag.describe", name: moved.name, description: moved.description });
    if (!moved.describedTo) continue;
    // Emptied, a tag notes still have, as one merged into, keeps nothing; forgotten, one no note has now goes. Null alone leaves a tag a note has as it is.
    await host.perform({ type: "tag.describe", name: moved.to, description: "" });
    await host.perform({ type: "tag.describe", name: moved.to, description: null });
  }
  return { message: kept ? `#${done.name} is back, but ${notes(kept)} changed since and kept #${done.to}` : `#${done.name} is back` };
}
