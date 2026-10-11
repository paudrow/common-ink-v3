import type { NoteSummary } from "../core/protocol.ts";

/**
 * Whether `a` says something later of a note than `b` does: its text changed since, or its state did,
 * which the revision doesn't show.
 */
export const laterThan = (a: NoteSummary, b: NoteSummary) => a.revision > b.revision || (a.stateAt ?? 0) > (b.stateAt ?? 0);

/** The latest change to the text or the state of any of `known`, which is when to ask from for what has changed since. */
export const lastChange = (known: readonly NoteSummary[]) => known.reduce((latest, n) => Math.max(latest, n.updatedAt, n.stateAt ?? 0), 0);

/**
 * A listing can answer after a save, a new note, or a move to Trash that it was sent before. A note
 * learned since it was sent stays as it was learned, and one already known to be later is kept.
 * Neither being later, what was learned wins, and then the listing, which alone says who may do what.
 */
export function newest(listed: readonly NoteSummary[], known: readonly NoteSummary[] | null, learned: ReadonlyMap<string, NoteSummary>): NoteSummary[] {
  const byId = new Map((known ?? []).map((n) => [n.id, n]));
  const listedIds = new Set(listed.map((n) => n.id));
  const fresh = listed.map((n) => {
    const since = learned.get(n.id);
    if (since && !laterThan(n, since)) return since;
    const mine = byId.get(n.id);
    return mine && laterThan(mine, n) ? mine : n;
  });
  return [...[...learned.values()].filter((n) => !listedIds.has(n.id)), ...fresh];
}

/**
 * What the app knows of the notes the member can see, in every state, after listing them again:
 * `kept` is the live and archived notes and `trash` the ones in Trash. `gone` is each note it knew
 * that is in neither now: removed from Trash, or hidden from the member.
 */
export function relisted(kept: readonly NoteSummary[], trash: readonly NoteSummary[], known: readonly NoteSummary[] | null, learned: ReadonlyMap<string, NoteSummary>): { notes: NoteSummary[]; gone: string[] } {
  const notes = newest([...kept, ...trash], known, learned);
  const there = new Set(notes.map((n) => n.id));
  return { notes, gone: (known ?? []).filter((n) => !there.has(n.id)).map((n) => n.id) };
}

/**
 * `known` after a listing of only what changed: each listed note that is new, or later than the one
 * known, comes first. A note listed twice, as when it went to Trash between two listings, is taken
 * as the later says. `known` itself when nothing listed is later, as when an answer is older than
 * what the member has done since.
 */
export function withChanged(changed: readonly NoteSummary[], known: NoteSummary[]): NoteSummary[] {
  const byId = new Map(known.map((n) => [n.id, n]));
  const later = new Map<string, NoteSummary>();
  for (const n of changed) {
    const mine = later.get(n.id) ?? byId.get(n.id);
    if (!mine || laterThan(n, mine)) later.set(n.id, n);
  }
  return later.size ? [...later.values(), ...known.filter((n) => !later.has(n.id))] : known;
}
