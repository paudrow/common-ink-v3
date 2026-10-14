import type { Plugin } from "../plugin-api.ts";
import { Soon } from "./lib/Soon.tsx";

export const backlinks: Plugin = {
  id: "backlinks",
  name: "Backlinks",
  description: "The notes that link to the open note, in the inspector.",
  icon: "backlinks",
  activate(host) {
    host.views.register("inspector", { id: "backlinks", label: "Backlinks", icon: "backlinks", for: ["note"], component: () => <Soon issue={13}>Notes that link here arrive with</Soon> });
  },
};
