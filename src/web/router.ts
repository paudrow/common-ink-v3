import { useCallback, useEffect, useState } from "react";
import { noteIdFromPath } from "../core/slug.ts";
import { MODES, modePath, type ModeId } from "./modes.ts";

export type Route = { kind: "home" } | { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "mode"; mode: ModeId } | { kind: "agents" } | { kind: "missing" };

/** Where a folder's list of notes lives: `/folder/<id>`, with `all` for every note. */
export const folderPath = (folderId: string) => `/folder/${folderId}`;
const FOLDER = /^\/folder\/([a-z0-9-]+)$/;

/** Where a member connects and disconnects their agents. */
export const AGENTS_PATH = "/agents";

/**
 * `replace` writes over the entry the browser is at. `move` is a step between things already open:
 * it adds an entry of its own, which the next move writes over, so Back retraces every open and
 * the last of a run of moves, and never loses an open to a move made after it.
 */
export type Navigate = (path: string, options?: { replace?: boolean; move?: boolean }) => void;

const MOVE = { move: true };
const isMove = (state: unknown) => typeof state === "object" && state !== null && "move" in state;

export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  const folderId = FOLDER.exec(pathname)?.[1];
  if (folderId) return { kind: "folder", id: folderId };
  if (pathname === AGENTS_PATH) return { kind: "agents" };
  const mode = MODES.find((m) => modePath(m.id) === pathname);
  if (mode) return { kind: "mode", mode: mode.id };
  const id = noteIdFromPath(pathname);
  return id ? { kind: "note", id } : { kind: "missing" };
}

export function useRoute(): [Route, Navigate] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback<Navigate>((to, options = {}) => {
    if (to === location.pathname) return;
    if (options.replace) history.replaceState(history.state, "", to);
    else if (options.move && isMove(history.state)) history.replaceState(MOVE, "", to);
    else history.pushState(options.move ? MOVE : null, "", to);
    setPath(to);
  }, []);
  return [routeOf(path), navigate];
}
