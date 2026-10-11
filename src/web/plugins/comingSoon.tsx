import type { IconName, Plugin } from "../plugin-api.ts";
import { Soon } from "./lib/Soon.tsx";

/** Pages that aren't built yet, each with the issue that builds it. The plugin that builds one takes its entry out of here. */
const PAGES: readonly { id: string; label: string; icon: IconName; nav: "primary" | "more"; order?: number; issue: number }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", nav: "primary", order: 10, issue: 23 },
];

export const comingSoon: Plugin = {
  id: "coming-soon",
  name: "Pages to come",
  activate(host) {
    for (const { issue, ...page } of PAGES) {
      host.views.register("page", {
        ...page,
        path: `/${page.id}`,
        component: () => (
          <section className="mode-view">
            <h1>{page.label}</h1>
            <Soon issue={issue}>{page.label} arrives with</Soon>
          </section>
        ),
      });
    }
  },
};
