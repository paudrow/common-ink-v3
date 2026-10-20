// How the Worker tells of a fault: always as one structured line in Workers Logs, and to Sentry as well
// when the SENTRY_DSN secret is set. A report names where and what broke, never who or what they wrote:
// its route is a pattern of known words, and every message and stack in it is redacted (src/core/logs.ts).

import { z } from "zod";
import { redact } from "../core/logs.ts";
import { sessionPersonId } from "./auth.ts";
import { MAX_FORM_BYTES, cappedJson } from "./body.ts";

/** Who saw the fault: a request the Worker answered, the app's page in a browser, or the hourly job. */
export type Source = "worker" | "client" | "job";

export interface Report {
  source: Source;
  /** The address as a pattern of known words, such as `/note/*` for a note's page. */
  route: string;
  /** Cloudflare's ray id, which is also in the response's `CF-Ray` header and in Workers Logs. */
  requestId: string | null;
  /** The operation's type, or the MCP method and tool. */
  op: string | null;
  status: number | null;
  name: string;
  message: string;
  stack: string | null;
}

/** What one request did that its report names, filled in as it is answered. */
export interface Trace {
  readonly requestId: string;
  readonly route: string;
  op?: string | null;
  /** What was thrown and answered as a fault. Only the last of a request's faults is told. */
  fault?: unknown;
}

/** The words of the Worker's own addresses and the app's pages. A number, such as a part's, is kept too. Any other part of an address, an id, a token, a name, is `*`. */
const WORDS = new Set([
  ...["api", "workspaces", "ops", "plugins", "draft", "trusted", "notes", "invites", "shared", "uploads", "upload-parts", "agents", "me", "faults"],
  ...["auth", "dev", "google", "callback", "connect", "sign-out", "clipper", "revoke", "mcp", "health"],
  ...["oauth", "authorize", "token", "register", "request", "consent", "deny", ".well-known", "oauth-protected-resource", "oauth-authorization-server"],
  ...["embed-frame", "sw.js", "assets", "s", "note", "folder", "all"],
]);

export const routeOf = (pathname: string): string =>
  pathname
    .split("/")
    .map((part) => (part === "" || WORDS.has(part) || /^\d{1,6}$/.test(part) ? part : "*"))
    .join("/");

/** An op's type or an MCP method as told: a name, or nothing when what was sent is not one. */
export const opName = (op: unknown): string | null => (typeof op === "string" && /^[\w./:-]{1,64}$/.test(op) ? op : null);

export function traceOf(req: Request, url: URL): Trace {
  const ray = req.headers.get("CF-Ray");
  return { requestId: ray && /^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : crypto.randomUUID(), route: routeOf(url.pathname) };
}

/** A request's report: its fault, or its status when it answered 5xx without one. Null when there is nothing to tell. */
export function reportOf(trace: Trace, status: number): Report | null {
  if (trace.fault === undefined && status < 500) return null;
  return { source: "worker", route: trace.route, requestId: trace.requestId, op: trace.op ?? null, status, ...told(trace.fault, status) };
}

/** What a thrown value says, with what an error quotes of its input left out by `report`. */
export function told(err: unknown, status: number | null = null): Pick<Report, "name" | "message" | "stack"> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack ?? null };
  if (err === undefined) return { name: "Status", message: `Answered ${status}`, stack: null };
  return { name: typeof err, message: String(err), stack: null };
}

// Cut before redacting, which takes longer the longer the text.
const redacted = (report: Report): Report => ({
  ...report,
  route: redact(report.route),
  name: redact(report.name.slice(0, 200)),
  message: redact(report.message.slice(0, 2000)),
  stack: report.stack === null ? null : redact(report.stack.slice(0, 8000)),
});

/** Where a DSN says to send events, and the key that may. Null for a DSN that isn't one. */
export function sentryTarget(dsn: string): { endpoint: string; key: string } | null {
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(project)) return null;
    return { endpoint: `${url.origin}/api/${project}/envelope/`, key: url.username };
  } catch {
    return null;
  }
}

/** A Sentry envelope of one error event: https://develop.sentry.dev/sdk/data-model/envelopes/ */
export function sentryEnvelope(report: Report, dsn: string, at: { eventId: string; now: number; release: string | null }): string {
  const event = {
    event_id: at.eventId,
    timestamp: at.now / 1000,
    platform: "javascript",
    level: "error",
    logger: report.source,
    transaction: report.route,
    ...(at.release ? { release: at.release } : {}),
    tags: { source: report.source, route: report.route, ...(report.op ? { op: report.op } : {}), ...(report.status ? { status: String(report.status) } : {}), ...(report.requestId ? { request_id: report.requestId } : {}) },
    exception: { values: [{ type: report.name, value: report.message }] },
    ...(report.stack ? { extra: { stack: report.stack } } : {}),
  };
  return [JSON.stringify({ event_id: at.eventId, sent_at: new Date(at.now).toISOString(), dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n") + "\n";
}

type Reporting = Pick<Env, "SENTRY_DSN" | "CF_VERSION_METADATA">;

/** When this isolate last sent Sentry a fault of each kind. The same fault, such as every uptime check while D1 is down, goes once a minute. */
const sentAt = new Map<string, number>();
const SENT_AGAIN_MS = 60_000;

function due(out: Report, now: number): boolean {
  const kind = `${out.source} ${out.route} ${out.op} ${out.status} ${out.name}: ${out.message}`;
  if (now - (sentAt.get(kind) ?? -Infinity) < SENT_AGAIN_MS) return false;
  if (sentAt.size >= 500) sentAt.clear();
  sentAt.set(kind, now);
  return true;
}

/**
 * Tells of `report`, redacted: a line in Workers Logs, which reads its fields, and an event to Sentry
 * when SENTRY_DSN is set, sent after the response under `waitUntil`. Sentry being down loses that event
 * and nothing else, and telling never throws into the answer it is about.
 */
export function report(env: Reporting, waitUntil: (sent: Promise<unknown>) => void, raw: Report): void {
  try {
    tell(env, waitUntil, raw);
  } catch {
    // Nothing is left to tell it to.
  }
}

function tell(env: Reporting, waitUntil: (sent: Promise<unknown>) => void, raw: Report): void {
  const out = redacted(raw);
  console.error({ fault: out });
  const target = env.SENTRY_DSN ? sentryTarget(env.SENTRY_DSN) : null;
  if (!target || !due(out, Date.now())) return;
  const body = sentryEnvelope(out, env.SENTRY_DSN!, { eventId: crypto.randomUUID().replaceAll("-", ""), now: Date.now(), release: env.CF_VERSION_METADATA?.id ?? null });
  waitUntil(
    fetch(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=common-ink/1` },
      body,
    }).catch(() => {}),
  );
}

/** How many faults this isolate hears from one person's pages in a minute: a page sends at most 10, and a script that sends more is no page. */
const HEARD_PER_MINUTE = 20;
const heardFrom = new Map<string, { since: number; count: number }>();

function heard(personId: string, now: number): boolean {
  const last = heardFrom.get(personId);
  const window = last && now - last.since < 60_000 ? last : { since: now, count: 0 };
  if (heardFrom.size >= 1000 && !last) heardFrom.clear();
  heardFrom.set(personId, { ...window, count: window.count + 1 });
  return window.count < HEARD_PER_MINUTE;
}

/** What the app's page sends of a fault it saw (src/web/faults.ts). */
const ClientFault = z.object({
  route: z.string().max(2000),
  op: z.string().max(64).nullish(),
  status: z.number().int().min(0).max(599).nullish(),
  name: z.string().max(200),
  message: z.string().max(2000),
  stack: z.string().max(8000).nullish(),
});

/**
 * POST /api/faults: a fault the app's page saw, told as the Worker tells its own. Only a signed-in
 * member's page is heard, and only from the app's own origin. The page sends at most a few per load.
 */
export async function handleClientFault(req: Request, env: Env, url: URL, tell: (report: Report) => void): Promise<Response> {
  const answer = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return answer(405);
  if (req.headers.get("Origin") !== url.origin) return answer(403);
  const personId = await sessionPersonId(req, env, url);
  if (!personId) return answer(401);
  if (!heard(personId, Date.now())) return answer(429);
  let sent: z.infer<typeof ClientFault>;
  try {
    sent = ClientFault.parse(await cappedJson(req, MAX_FORM_BYTES));
  } catch {
    return answer(400);
  }
  tell({ source: "client", route: routeOf(sent.route), requestId: null, op: opName(sent.op), status: sent.status ?? null, name: sent.name, message: sent.message, stack: sent.stack ?? null });
  return answer(204);
}
