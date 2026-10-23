import { MAIL_PROVIDER, MAIL_SOURCE, addSender, forgetMail, isMessage, listSenders, listThreads, readThread, removeSender } from "../../core/mailbox.ts";
import type { MailSource } from "../../core/sources.ts";
import { connectPlain, connectionOf } from "./connections.ts";
import type { Provider } from "./index.ts";

/**
 * Email: the mail a person sends, copies or forwards to `address`, which src/worker/mail.ts keeps
 * for them. It is connected by saying so, as nothing outside Common Ink is agreed to, and until it
 * is, mail from the person is dropped. Disconnecting forgets every message kept and every address
 * added, so nothing of it is left here.
 */
export function mail(db: D1Database, address: string, now: () => number): Provider {
  return {
    owns: (id) => id === MAIL_SOURCE,
    async of(personId) {
      const connection = await connectionOf(db, personId, MAIL_PROVIDER);
      const source: MailSource = {
        kind: "email",
        info: { id: MAIL_SOURCE, name: "Email", provider: "Email", state: connection ? "connected" : "not_connected", account: connection ? address : null },
        address,
        list: (ask) => listThreads(db, personId, MAIL_SOURCE, ask),
        thread: (id) => readThread(db, personId, MAIL_SOURCE, id),
        isMessage: (id) => isMessage(db, personId, id),
        senders: {
          list: () => listSenders(db, personId),
          add: (said) => addSender(db, personId, said, now()),
          remove: (said) => removeSender(db, personId, said),
        },
      };
      return [source];
    },
    async connect(personId) {
      await connectPlain(db, personId, MAIL_PROVIDER, address, now());
      return { redirect: null };
    },
    async disconnect(personId) {
      await forgetMail(db, personId);
      await db.prepare("DELETE FROM source_connections WHERE person_id = ? AND provider = ?").bind(personId, MAIL_PROVIDER).run();
    },
    // Nothing outside Common Ink holds it.
    ending: async () => null,
  };
}
