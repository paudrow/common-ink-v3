import type { Dispose } from "../../plugin-api.ts";

/** The notes the member has Blame mode on for. */
export interface BlameToggles {
  has(noteId: string): boolean;
  toggle(noteId: string): void;
  subscribe(listener: () => void): Dispose;
}

/** The change a run of Blame mode asked History to show, by note, until the note's History panel shows it; and the notes whose panel is showing. */
export interface Asked {
  of(noteId: string): number | null;
  ask(noteId: string, revision: number): void;
  shown(noteId: string): void;
  subscribe(listener: () => void): Dispose;
  showing: Set<string>;
}

/** What History kept of Blame mode while the mode was part of it: the notes it was on for. */
export interface Former {
  read(): unknown;
  forget(): void;
}

/**
 * What the Blame and History plugins share in one workspace. Blame offers its toggles while it is on,
 * and History's panel has a switch for them only then. Blame asks History to show a change. History
 * offers what it kept of the mode before Blame was a plugin of its own, for Blame to take once.
 */
export interface BlameLink {
  toggles(): BlameToggles | null;
  offer(toggles: BlameToggles): Dispose;
  readonly asked: Asked;
  former: Former | null;
  subscribe(listener: () => void): Dispose;
}

function store() {
  const listeners = new Set<() => void>();
  return {
    told: () => listeners.forEach((listener) => listener()),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function link(): BlameLink {
  let offered: BlameToggles | null = null;
  const { told, subscribe } = store();
  const picks = new Map<string, number>();
  const asking = store();
  return {
    toggles: () => offered,
    offer(toggles) {
      offered = toggles;
      told();
      return () => {
        if (offered === toggles) offered = null;
        told();
      };
    },
    asked: {
      of: (noteId) => picks.get(noteId) ?? null,
      ask(noteId, revision) {
        picks.set(noteId, revision);
        asking.told();
      },
      shown(noteId) {
        if (picks.delete(noteId)) asking.told();
      },
      subscribe: asking.subscribe,
      showing: new Set(),
    },
    former: null,
    subscribe,
  };
}

const links = new Map<string, BlameLink>();

/** The link of the workspace with this id: the same one for both plugins, whichever asks first. */
export function blameLink(workspaceId: string): BlameLink {
  let found = links.get(workspaceId);
  if (!found) links.set(workspaceId, (found = link()));
  return found;
}
