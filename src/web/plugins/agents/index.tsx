import type { Plugin } from "../../plugin-api.ts";
import { Agents } from "./Agents.tsx";

/** Where the History plugin's page is, when it is on. An author handed to it as the page's state is the one it shows. */
const HISTORY = "/history";

export const agents: Plugin = {
  id: "agents",
  name: "Agents",
  description: "Connect an AI agent to your notes, and see what each one changed.",
  icon: "agent",
  activate(host) {
    host.views.register("page", {
      id: "agents",
      path: "/agents",
      label: "Agents",
      nav: "menu",
      component: ({ app }) => (
        <Agents
          host={host}
          workspace={app.workspace}
          workspaces={app.workspaces}
          version={(app.notes ?? []).reduce((sum, n) => sum + n.revision, 0)}
          onShowChanges={app.pages.some((p) => p.path === HISTORY) ? (agentId) => app.go(HISTORY, { state: `agent:${agentId}` }) : undefined}
          onReverted={app.refresh}
        />
      ),
    });
  },
};
