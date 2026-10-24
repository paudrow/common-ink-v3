import type { Page } from "@playwright/test";
import { me, perform } from "./helpers.ts";

/** Mail as Email Routing hands it over, posted to /dev/email, which takes it the same way where dev sign-in is on. */
export async function send(page: Page, lines: string[]): Promise<Record<string, unknown>> {
  return page.evaluate(async (raw) => (await (await fetch("/dev/email", { method: "POST", body: raw })).json()) as Record<string, unknown>, lines.join("\r\n"));
}

export const vouched = (domain: string) => `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;

/** Connects the signed-in person's Email, and answers the address they send from. */
export async function connectEmail(page: Page): Promise<string> {
  await perform(page, { type: "source.connect", id: "email", back: "/email" });
  return (await me(page)).person.email;
}

interface Mail {
  subject: string;
  text: string;
  /** Who it is from: the member, unless it forwards another's message. */
  from?: string;
  id?: string;
  date?: string;
  /** Headers of the message forwarded, attached whole, which is then what is kept. */
  forwards?: string[];
}

/** One message from the signed-in member to notes@, kept for them. */
export async function mail(page: Page, { subject, text, from, id, date, forwards }: Mail): Promise<Record<string, unknown>> {
  const email = (await me(page)).person.email;
  const domain = email.replace(/.*@/, "");
  const head = [vouched(domain), `From: Me <${email}>`, "To: notes@in.commonink.app", `Subject: ${forwards ? `Fwd: ${subject}` : subject}`, `Message-ID: <${id ?? crypto.randomUUID()}@${domain}>`, `Date: ${date ?? new Date().toUTCString()}`, "MIME-Version: 1.0"];
  if (!forwards) return send(page, [...head, "Content-Type: text/plain; charset=utf-8", "", text]);
  return send(page, [
    ...head,
    'Content-Type: multipart/mixed; boundary="fw"',
    "",
    "--fw",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
    "--fw",
    "Content-Type: message/rfc822",
    "",
    `From: ${from}`,
    "To: Me <me@example.com>",
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@forwarded.example>`,
    `Date: ${date ?? new Date().toUTCString()}`,
    ...forwards,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--fw--",
  ]);
}
