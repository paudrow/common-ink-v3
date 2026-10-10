import { useCallback, useEffect, useState } from "react";
import { noteIdFromPath } from "../core/slug.ts";

export type Route = { kind: "home" } | { kind: "note"; id: string } | { kind: "missing" };

export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  const id = noteIdFromPath(pathname);
  return id ? { kind: "note", id } : { kind: "missing" };
}

export function useRoute(): [Route, (path: string, options?: { replace?: boolean }) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    if (to === location.pathname) return;
    if (options.replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    setPath(to);
  }, []);
  return [routeOf(path), navigate];
}
