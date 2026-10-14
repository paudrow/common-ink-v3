import { useState } from "react";
import { ALL_NOTES, type App, type PluginHost } from "../../plugin-api.ts";
import { NoteFinder } from "../noteList.tsx";
import { INITIAL_VIEW, listReducer, type ListView } from "../noteListView.ts";
import { addressOf, queryIn } from "./request.ts";

/**
 * The Search page: the list every folder's tab has, of every note, with the keyboard in its search
 * field, and with the query as its one control: which notes, whether they have todos and the order
 * are said in it, typed or built under Advanced. The address is the search. Typing writes it there
 * after a pause, and a link, a reload, or Back brings one back. Which cards are expanded is the
 * page's own, for as long as it is shown.
 */
export function SearchPage({ host, app }: { host: PluginHost; app: App }) {
  const [expanded, setExpanded] = useState<ListView["expanded"]>({});
  const [kept] = useState({ scrollTop: 0 });
  const view: ListView = { ...INITIAL_VIEW, query: queryIn(app.query), expanded };
  return (
    <NoteFinder
      app={app}
      host={host}
      folderId={ALL_NOTES}
      readNote={app.readNote}
      snippets
      view={view}
      act={(action) => {
        const next = listReducer(view, action);
        setExpanded(next.expanded);
        if (next.query !== view.query) app.go(addressOf(next.query), { replace: true });
      }}
      kept={kept}
      heading="Search"
      queryOnly
      autoFocus
    />
  );
}
