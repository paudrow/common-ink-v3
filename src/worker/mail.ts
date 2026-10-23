import { MAX_RAW_BYTES, normalAddress } from "../core/mail.ts";
import { receive, type Received } from "../core/mailbox.ts";

/*
 * Mail to notes@in.commonink.app, as Cloudflare Email Routing hands it to the Worker's `email` handler.
 * Whatever becomes of a message, nothing is said to its sender: no message is rejected or answered,
 * so mail from someone with no account here, or that failed its domain's checks, reads to them
 * exactly as mail that was kept. docs/email.md has the routing and DNS this needs.
 */

/** Where mail is sent to be kept. MAIL_ADDRESS names another, as a staging Worker would. */
export const mailAddress = (env: Env) => normalAddress(env.MAIL_ADDRESS || "notes@in.commonink.app");

/** Whose Authentication-Results header is read: the server that received the message for us. */
export const mailAuthserv = (env: Env) => (env.MAIL_AUTHSERV || "mx.cloudflare.net").trim().toLowerCase();

/** Whether an envelope recipient is the address, or the address with a `+word` after its name. */
export function addressedTo(recipient: string, address: string): boolean {
  const said = normalAddress(recipient);
  const at = address.lastIndexOf("@");
  const [name, domain] = [address.slice(0, at), address.slice(at + 1)];
  return said === address || (said.endsWith(`@${domain}`) && said.startsWith(`${name}+`) && !said.slice(name.length + 1, -domain.length - 1).includes("@"));
}

/** Takes one message from Email Routing. What became of it is answered for the log and the tests; its sender is told nothing. */
export async function handleEmail(message: Pick<ForwardableEmailMessage, "to" | "raw" | "rawSize">, env: Env, now = Date.now()): Promise<Received> {
  if (!addressedTo(message.to, mailAddress(env))) return { dropped: "unknown" };
  if (message.rawSize > MAX_RAW_BYTES) return { dropped: "too_large" };
  const raw = await new Response(message.raw).arrayBuffer();
  return receive(env.DB, raw, { authserv: mailAuthserv(env), now });
}

/** What the log says of a message: what became of it, and nothing of who sent it or what it says. */
export const logged = (received: Received) => `Mail ${"kept" in received ? "kept" : "duplicate" in received ? "already kept" : "verified" in received ? "verified an address" : `dropped: ${received.dropped}`}`;
