import type { Plugin } from "../../plugin-api.ts";
import { referenceEmbed } from "../lib/references.tsx";
import { ContactsPage } from "./Contacts.tsx";

/**
 * Contacts: the people in the contacts the member connected, which nobody else in the workspace
 * sees and nothing here changes. A note references one as `::contact{ref name}`, which shows the
 * contact as they are now to the member whose it is and the name to everyone else.
 */
export const contacts: Plugin = {
  id: "contacts",
  name: "Contacts",
  description: "Shows the people in the contacts you connect, which nobody else in the workspace sees, and lets a note reference one.",
  icon: "contacts",
  activate(host) {
    host.views.register("page", { id: "contacts", path: "/contacts", label: "Contacts", // First under More, wherever this plugin is among the others: its place there sets where Contact is in the / menu.
      icon: "contacts", nav: "more", order: 10, component: (props) => <ContactsPage host={host} {...props} /> });
    host.embeds.register(
      referenceEmbed({
        host,
        kind: "contact",
        title: "Contact",
        hint: "copy a reference from a contact on the Contacts page, and paste it over this",
        shown: ({ contact }) => ({ text: contact.name || "No name", title: [contact.organization, ...contact.emails, ...contact.phones].filter(Boolean).join(" · ") || "Contact" }),
        details: ({ contact }) => (
          <dl className="ref-details">
            <dt>Contact</dt>
            <dd>{contact.name || "No name"}</dd>
            {contact.organization && (
              <>
                <dt>Organization</dt>
                <dd>{contact.organization}</dd>
              </>
            )}
            {contact.emails.length > 0 && (
              <>
                <dt>Email</dt>
                {contact.emails.map((email) => (
                  <dd key={email}>
                    <a href={`mailto:${email}`}>{email}</a>
                  </dd>
                ))}
              </>
            )}
            {contact.phones.length > 0 && (
              <>
                <dt>Phone</dt>
                {contact.phones.map((phone) => (
                  <dd key={phone}>{phone}</dd>
                ))}
              </>
            )}
          </dl>
        ),
      }),
    );
  },
};
