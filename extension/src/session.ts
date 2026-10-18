import type { ChosenDraft, Clip, CreatedId, Draft, Miss, PlacedMap, PlacedUpload, SavedNote } from "./clip/types.ts";

export type Session =
  | { status: "idle" }
  | { status: "clipping" }
  | { status: "review"; clip: Clip; draft: Draft }
  | { status: "saving"; clip: Clip; draft: ChosenDraft; placed: PlacedMap; missed: readonly Miss[]; createKey: string; note: CreatedId | null }
  | { status: "saved"; note: SavedNote; missed: readonly Miss[]; draft: Draft }
  | { status: "failed"; clip: Clip; draft: Draft; placed: PlacedMap; missed: readonly Miss[]; createKey: string | null; message: string };

export type SessionEvent =
  | { type: "clipping" }
  | { type: "captured"; clip: Clip; defaults: Draft }
  | { type: "draft"; patch: Partial<Draft> }
  | { type: "save" }
  | { type: "placed"; id: string; upload: PlacedUpload }
  | { type: "miss"; miss: Miss }
  | { type: "noted"; note: CreatedId }
  | { type: "created"; note: SavedNote }
  | { type: "failed"; message: string }
  | { type: "dismiss" };

const CHOOSE = "Choose a folder.";
/** A clip that just started stays on screen. An older one is cleared when the popup opens. */
export const FRESH_MS = 1500;

export function settle(session: Session, touched: number, now: number): Session {
  if (session.status === "saving" || session.status === "clipping" || session.status === "idle") return session;
  if (session.status === "saved") return { status: "idle" };
  return now - touched > FRESH_MS ? { status: "idle" } : session;
}

export function reduce(session: Session, event: SessionEvent): Session {
  switch (event.type) {
    case "clipping":
      return session.status === "saving" ? session : { status: "clipping" };
    case "captured":
      if (session.status === "saving") return session;
      return { status: "review", clip: event.clip, draft: event.defaults };
    case "draft": {
      if (session.status !== "review" && session.status !== "failed") return session;
      return { ...session, draft: { ...session.draft, ...event.patch } };
    }
    case "save":
      return startSave(session);
    case "placed":
      if (session.status !== "saving") return session;
      return { ...session, placed: { ...session.placed, [event.id]: event.upload } };
    case "miss":
      if (session.status !== "saving") return session;
      return { ...session, missed: [...session.missed, event.miss] };
    case "noted":
      if (session.status !== "saving") return session;
      return { ...session, note: event.note };
    case "created":
      if (session.status !== "saving") return session;
      return { status: "saved", note: event.note, missed: session.missed, draft: session.draft };
    case "failed":
      if (session.status === "clipping") return { status: "idle" };
      if (session.status !== "saving" && session.status !== "review") return session;
      return {
        status: "failed",
        clip: session.clip,
        draft: session.draft,
        placed: session.status === "saving" ? session.placed : {},
        missed: session.status === "saving" ? session.missed : [],
        createKey: session.status === "saving" ? session.createKey : null,
        message: event.message,
      };
    case "dismiss":
      if (session.status === "saving") return session;
      return { status: "idle" };
  }
}

function startSave(session: Session): Session {
  if (session.status === "saving" || session.status === "saved" || session.status === "idle" || session.status === "clipping") return session;
  if (!session.draft.workspaceId || !session.draft.folderId) {
    return {
      status: "failed",
      clip: session.clip,
      draft: session.draft,
      placed: session.status === "failed" ? session.placed : {},
      missed: session.status === "failed" ? session.missed : [],
      createKey: session.status === "failed" ? session.createKey : null,
      message: CHOOSE,
    };
  }
  const draft: ChosenDraft = { title: session.draft.title, workspaceId: session.draft.workspaceId, folderId: session.draft.folderId };
  const createKey = session.status === "failed" && session.createKey ? session.createKey : crypto.randomUUID();
  if (session.status === "failed") return { status: "saving", clip: session.clip, draft, placed: session.placed, missed: [], createKey, note: null };
  return { status: "saving", clip: session.clip, draft, placed: {}, missed: [], createKey, note: null };
}
