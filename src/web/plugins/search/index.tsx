import type { Plugin } from "../../plugin-api.ts";
import { SEARCH_PATH } from "./request.ts";
import { SearchPage } from "./Search.tsx";

/**
 * Search. The page asks the server for the notes whose text has what is typed, as it is typed, and
 * shows each with the lines that matched. The search is in the page's address, so it can be linked,
 * reloaded, and come back to.
 */
export const search: Plugin = {
  id: "search",
  name: "Search",
  description: "Finds notes by their words, phrases and tags, on the Search page and in every folder's list.",
  icon: "search",
  activate(host) {
    host.views.register("page", { id: "search", path: SEARCH_PATH, label: "Search", description: "Find notes by their words, phrases and tags, across the workspace.", icon: "search", nav: "primary", order: 20, component: ({ app }) => <SearchPage host={host} app={app} /> });
  },
};
