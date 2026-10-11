import type { Plugin } from "../../plugin-api.ts";
import { Members } from "./Members.tsx";

export const members: Plugin = {
  id: "members",
  name: "Members",
  activate(host) {
    host.views.register("page", { id: "members", path: "/members", label: "Members", nav: "menu", component: ({ app }) => <Members host={host} app={app} /> });
  },
};
