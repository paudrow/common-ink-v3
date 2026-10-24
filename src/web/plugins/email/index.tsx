import type { Plugin } from "../../plugin-api.ts";
import { referenceEmbed } from "../lib/references.tsx";
import { EMAIL_PATH, EmailPage } from "./EmailPage.tsx";
import { Senders } from "./Senders.tsx";

const when = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Email: the mail the member sends, copies or forwards to notes@, kept as threads that nobody else in
 * the workspace sees and nothing here changes. A note references a thread, or one message in it, as
 * `/email(ref subject)`, which shows it as it is now to the member whose it is and the subject to
 * everyone else.
 */
export const email: Plugin = {
  id: "email",
  name: "Email",
  description: "Keeps the mail you send, copy or forward to notes@ as threads only you see, and lets a note reference one.",
  icon: "mail",
  activate(host) {
    host.views.register("page", { id: "email", path: EMAIL_PATH, label: "Email", description: "The mail you send or forward to notes@, kept as threads only you see.", icon: "mail", nav: "more", order: 12, component: (props) => <EmailPage host={host} {...props} /> });
    host.views.register("settings", { id: "email", label: "Email", component: () => <Senders host={host} /> });
    host.embeds.register(
      referenceEmbed({
        host,
        kind: "email",
        title: "Email",
        hint: "copy a reference from a thread on the Email page, and paste it over this",
        shown: ({ thread, messageId }) => {
          const message = thread.messages.find((m) => m.id === messageId);
          return { text: message?.subject || thread.subject, title: [message ? message.from.name || message.from.address : thread.from.map((f) => f.name || f.address).join(", "), when(message?.sentAt ?? thread.lastAt)].join(" · ") };
        },
        details: ({ thread, messageId }, { close }) => {
          const message = thread.messages.find((m) => m.id === messageId) ?? thread.messages[thread.messages.length - 1];
          return (
            <dl className="ref-details">
              <dt>Thread</dt>
              <dd>
                {thread.subject} ({thread.count} {thread.count === 1 ? "message" : "messages"})
              </dd>
              {message && (
                <>
                  <dt>{messageId ? "Message" : "Latest"}</dt>
                  <dd>
                    {message.from.name || message.from.address}, {when(message.sentAt)}
                  </dd>
                  <dd className="email-snippet">{message.text.slice(0, 300)}</dd>
                </>
              )}
              <dd>
                <a
                  href={`${EMAIL_PATH}/${encodeURIComponent(messageId ?? thread.id)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    close();
                    host.app().go(`${EMAIL_PATH}/${encodeURIComponent(messageId ?? thread.id)}`);
                  }}
                >
                  Open the thread
                </a>
              </dd>
            </dl>
          );
        },
      }),
    );
  },
};
