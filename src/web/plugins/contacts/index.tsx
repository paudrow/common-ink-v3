import type { Plugin } from "../../plugin-api.ts";
import { ContactsPage } from "./Contacts.tsx";

/**
 * Contacts: the people in the contacts the member connected, which nobody else in the workspace
 * sees and nothing here changes. A note names one with `@`, as `[[person:Name]]`.
 */
export const contacts: Plugin = {
  id: "contacts",
  name: "Contacts",
  description: "Shows the people in the contacts you connect, which nobody else in the workspace sees.",
  icon: "contacts",
  activate(host) {
    host.views.register("page", { id: "contacts", path: "/contacts", label: "Contacts", description: "The people in the contacts you connect, which only you see.", // First under More, wherever this plugin is among the others.
      icon: "contacts", nav: "more", order: 10, component: (props) => <ContactsPage host={host} {...props} /> });
  },
};
