// The dev server's guard for dev sign-in. The Worker takes a request for localhost as one from this
// machine, and signs it in as anyone (src/worker/auth.ts devSignIn). Behind Vite it reads that name
// from the Host header, which any client writes, and Vite's own check lets `localhost` through from
// anywhere. Started with --host, other machines reach the server too, so a request that names this
// machine is answered only when it came from this machine.
import type { IncomingMessage, ServerResponse } from "node:http";
import { THIS_MACHINE } from "../src/worker/hosts.ts";
/** The addresses a connection from this machine comes from. */
const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/** The hostname the Worker reads from `host`, read the same way: the Cloudflare plugin makes the request's URL from it. Null where it makes none. */
function hostnameOf(host: string | undefined): string | null {
  try {
    return new URL(`http://${host ?? ""}`).hostname;
  } catch {
    return null;
  }
}

export function thisMachineOnly(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (!THIS_MACHINE.test(hostnameOf(req.headers.host) ?? "") || LOOPBACK.test(req.socket.remoteAddress ?? "")) return next();
  res.statusCode = 403;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("This address names the machine the dev server runs on. From another machine, use its own name.");
}
