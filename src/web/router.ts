import { useCallback, useEffect, useRef, useState } from "react";
import { noteIdFromPath } from "../core/slug.ts";

/** A page is whatever a plugin registered at that path, if any did. */
export type Route = { kind: "home" } | { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; path: string };

/** Where a folder's list of notes lives: `/folder/<id>`, with `all` for every note. No page can be there. */
export const folderPath = (folderId: string) => `/folder/${folderId}`;
const FOLDER = /^\/folder\/([a-z0-9-]+)$/;

export interface Place {
  path: string;
  /** What `navigate` was handed for this entry of the browser's history. */
  state: unknown;
  route: Route;
}

/**
 * `replace` writes over the entry the browser is at. `move` is a step between things already open:
 * it adds an entry of its own, which the next move writes over, so Back retraces every open and
 * the last of a run of moves, and never loses an open to a move made after it.
 */
export type Navigate = (path: string, options?: { replace?: boolean; move?: boolean; state?: unknown }) => void;

/** Whether a tab can be kept at an address. One that starts with two slashes reads as another site's, and a stored layout that held it would be refused whole. */
export const keepsATab = (pathname: string) => /^\/(?!\/)/.test(pathname);

export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  const folderId = FOLDER.exec(pathname)?.[1];
  if (folderId) return { kind: "folder", id: folderId };
  const id = noteIdFromPath(pathname);
  return id ? { kind: "note", id } : { kind: "page", path: pathname };
}

export function useRoute(): [Place, Navigate] {
  const [at, setAt] = useState({ path: location.pathname, state: history.state as unknown });
  /** Whether the entry the browser is at was written by a move. Back and Forward come to an entry that may not be. */
  const moved = useRef(false);
  useEffect(() => {
    const onPop = () => {
      moved.current = false;
      setAt({ path: location.pathname, state: history.state });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // State is handed to the page once. Taken off the entry, it isn't handed over again on Back or a reload.
  useEffect(() => {
    if (history.state !== null) history.replaceState(null, "", location.href);
  }, [at]);
  const navigate = useCallback<Navigate>((to, { replace, move, state = null } = {}) => {
    if (to === location.pathname) return;
    if (replace || (move && moved.current)) history.replaceState(state, "", to);
    else history.pushState(state, "", to);
    if (!replace) moved.current = Boolean(move);
    setAt({ path: to, state });
  }, []);
  return [{ ...at, route: routeOf(at.path) }, navigate];
}
