import { useCallback, useEffect, useState } from "react";
import { noteIdFromPath } from "../core/slug.ts";
import { MODES, modePath, type ModeId } from "./modes.ts";

export type Route = { kind: "home" } | { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "mode"; mode: ModeId } | { kind: "missing" };

/** Where a folder's list of notes lives: `/folder/<id>`, with `all` for every note. */
export const folderPath = (folderId: string) => `/folder/${folderId}`;
const FOLDER = /^\/folder\/([a-z0-9-]+)$/;

export type Navigate = (path: string, options?: { replace?: boolean }) => void;

export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  const folderId = FOLDER.exec(pathname)?.[1];
  if (folderId) return { kind: "folder", id: folderId };
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
    if (options.replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    setPath(to);
  }, []);
  return [routeOf(path), navigate];
}
