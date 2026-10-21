import { useCallback, useEffect, useRef, useState } from "react";
import { noteIdFromPath } from "../core/slug.ts";
import { movedTo } from "./moved.ts";

/** A page is whatever a plugin registered at that path, if any did. */
export type Route = { kind: "home" } | { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; path: string };

/** Where a folder's list of notes lives: `/folder/<id>`, with `all` for every note. No page can be there. */
export const folderPath = (folderId: string) => `/folder/${folderId}`;
const FOLDER = /^\/folder\/([a-z0-9-]+)$/;

export interface Place {
  path: string;
  /** The address's query as the browser has it, such as `?q=plan`, or empty. */
  query: string;
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

/** What a tab holds: the plugin API's `Opened`, written here so the router stands on its own. */
type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; id: string; path: string };

/** The page an address names: the one at exactly that address, or else the one whose path it is under. */
export const pageAt = <P extends { path: string }>(pages: readonly P[], pathname: string): P | undefined => pages.find((p) => p.path === pathname) ?? pages.find((p) => pathname.startsWith(`${p.path}/`));

/**
 * What going to an address of the app's opens in a tab, as a link to it does: a note, a folder's
 * list, or the page the address names, at that address, and at `/` the home page. Null where no
 * tab is: an address no page is at, and a page that only leads somewhere else without saying where.
 */
export function openedAt(address: string, pages: readonly { id: string; path: string; home?: boolean; transient?: unknown }[]): Opened | null {
  const to = movedTo(address);
  const cut = to.search(/[?#]/);
  const pathname = cut < 0 ? to : to.slice(0, cut);
  const route = routeOf(pathname);
  if (route.kind === "note" || route.kind === "folder") return { kind: route.kind, id: route.id };
  const page = route.kind === "home" ? pages.find((p) => p.home) : pageAt(pages, pathname);
  return page && page.transient !== true ? { kind: "page", id: page.id, path: to.split("#")[0]! } : null;
}

/** Writes the browser's address where it is now, in place of an address that moved. */
function arrive() {
  const now = movedTo(location.pathname + location.search + location.hash);
  if (now !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", now);
}

export function useRoute(): [Place, Navigate] {
  const [at, setAt] = useState(() => {
    arrive();
    return { path: location.pathname, query: location.search, state: history.state as unknown };
  });
  /** Whether the entry the browser is at was written by a move. Back and Forward come to an entry that may not be. */
  const moved = useRef(false);
  useEffect(() => {
    const onPop = () => {
      arrive();
      moved.current = false;
      setAt({ path: location.pathname, query: location.search, state: history.state });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // State is handed to the page once. Taken off the entry, it isn't handed over again on Back or a reload.
  useEffect(() => {
    if (history.state !== null) history.replaceState(null, "", location.href);
  }, [at]);
  const navigate = useCallback<Navigate>((address, { replace, move, state = null } = {}) => {
    const to = movedTo(address);
    if (to === location.pathname + location.search) return;
    if (replace || (move && moved.current)) history.replaceState(state, "", to);
    else history.pushState(state, "", to);
    if (!replace) moved.current = Boolean(move);
    setAt({ path: location.pathname, query: location.search, state });
  }, []);
  return [{ ...at, route: routeOf(at.path) }, navigate];
}
