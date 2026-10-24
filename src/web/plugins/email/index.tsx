import type { Plugin } from "../../plugin-api.ts";
import { namable } from "../lib/pointing.ts";
import { EmailPage } from "./EmailPage.tsx";
import { EMAIL_PATH, emailLinks, threadsAt } from "./linking.tsx";
import { Senders } from "./Senders.tsx";

/**
 * Email: the mail the member sends, copies or forwards to notes@, kept as threads that nobody else in
 * the workspace sees and nothing here changes. A note links to a thread, or one message in it, as
 * `[[email:ref]]`, which shows its subject to the member whose it is and "Email" to everyone else.
 * Notes written before links held `::email{ref subject}`, which is converted to a link once (note.convertLinks).
 */
export const email: Plugin = {
  id: "email",
  name: "Email",
  description: "Keeps the mail you send, copy or forward to notes@ as threads only you see, and lets a note reference one.",
  icon: "mail",
  activate(host) {
    host.views.register("page", { id: "email", path: EMAIL_PATH, label: "Email", description: "The mail you send or forward to notes@, kept as threads only you see.", icon: "mail", nav: "more", order: 12, component: (props) => <EmailPage host={host} {...props} /> });
    host.views.register("settings", { id: "email", label: "Email", component: () => <Senders host={host} /> });
    const at = threadsAt(host);
    host.completions.register({ id: "email.at", trigger: "@", spaces: true, items: (typed) => (namable(typed) ? at(typed) : []) });
    const { links, dispose } = emailLinks(host);
    host.editorExtensions.register({ id: "email.links", extension: (editor) => links(editor.noteId) });
    return dispose;
  },
};
