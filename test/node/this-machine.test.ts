// Run by node: the dev server's guard, as Vite hands it each request.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { thisMachineOnly } from "../../scripts/this-machine.ts";

/** What the guard does with a request for `host` that came from `remote`: "on" to the app, or the status it answered. */
function answer(host: string | undefined, remote: string | undefined): string | number {
  let status: number | null = null;
  let passed = false;
  const res = { statusCode: 200, setHeader() {}, end() {} };
  res.end = () => void (status = res.statusCode);
  thisMachineOnly({ headers: { host }, socket: { remoteAddress: remote } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => (passed = true));
  return passed ? "on" : status!;
}

test("a request naming this machine is answered only from this machine, whatever port it names", () => {
  // Each written another way that the Worker still reads as this machine: an empty port, a capital, a dot, IPv6 written out.
  for (const host of ["localhost:5173", "LOCALHOST", "localhost:", "127.0.0.1:5173", "127.0.0.1:", "[::1]:5173", "[0:0:0:0:0:0:0:1]:5173", "[0::1]", "[::0001]", "[::1]:"]) {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(answer(host, remote), "on", `${host} from ${remote}`);
    for (const remote of ["192.168.1.20", "100.64.0.7", "::ffff:10.0.0.2", "fe80::1", undefined]) assert.equal(answer(host, remote), 403, `${host} from ${remote}`);
  }
});

test("a request naming the machine by another name is answered from anywhere, as Vite's own host check allows it", () => {
  for (const host of ["192.168.1.5:5173", "mac.tailnet.ts.net:5173", undefined]) assert.equal(answer(host, "192.168.1.20"), "on", String(host));
});
