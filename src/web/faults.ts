// Faults the app's page sees, told to the Worker (POST /api/faults, src/worker/report.ts), which reports them as
// it does its own. That catches what the Worker can't tell of itself, such as a request Cloudflare cut off.
// A page tells at most MAX_TOLD of them, and the same one once.

import { ApiError } from "./api.ts";

const MAX_TOLD = 10;
const told = new Set<string>();

export interface SeenFault {
  name: string;
  message: string;
  stack?: string | null;
  op?: string | null;
  status?: number | null;
}

/** What a page sees that is no fault of Common Ink's: a browser's own warnings, a request it gave up on or couldn't send, and an extension's code. */
const NOT_OURS = [/^ResizeObserver loop/, /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)$/, /^The (operation|user) (was|aborted)/];
const notOurs = (fault: SeenFault) => fault.name === "AbortError" || NOT_OURS.some((rule) => rule.test(fault.message)) || /-extension:\/\//.test(`${fault.message}\n${fault.stack ?? ""}`);

export function tellFault(fault: SeenFault): void {
  if (notOurs(fault)) return;
  const key = `${fault.op ?? ""} ${fault.status ?? ""} ${fault.name}: ${fault.message}`;
  if (told.size >= MAX_TOLD || told.has(key)) return;
  told.add(key);
  void fetch("/api/faults", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route: location.pathname, ...fault, message: fault.message.slice(0, 2000), stack: fault.stack?.slice(0, 6000) ?? null }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Tells of every error the page throws and doesn't catch. An error event with no error, such as another
 * site's script's "Script error." or a browser's own warning, is nothing to tell, and an operation's answer
 * that wasn't caught is the server's to tell: `perform` tells of those it cut off.
 */
export function tellUncaught(): void {
  const tell = (err: unknown) => {
    if (!(err instanceof ApiError)) tellFault(seen(err));
  };
  addEventListener("error", (event) => {
    if (event.error === undefined || event.error === null) return;
    tell(event.error);
  });
  addEventListener("unhandledrejection", (event) => tell(event.reason));
}

/** A value thrown that isn't an Error says nothing of where it came from, and may be anything at all, so only its kind is told. */
const seen = (err: unknown): SeenFault => (err instanceof Error ? { name: err.name, message: err.message, stack: err.stack ?? null } : { name: "NotAnError", message: `A ${typeof err} was thrown` });
