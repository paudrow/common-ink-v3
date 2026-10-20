import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipper } from "../src/store.ts";

function area(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = { ...initial };
  return {
    items,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in items).map((key) => [key, items[key]])),
    set: async (values: Record<string, unknown>) => void Object.assign(items, values),
    remove: async (keys: string[]) => keys.forEach((key) => delete items[key]),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("disconnect", () => {
  it("ends the sign-in on the server before forgetting the token", async () => {
    const local = area({ auth: { token: "cink_clipper", host: "https://ink.test" } });
    vi.stubGlobal("chrome", { storage: { local, session: area() }, action: { setBadgeText: async () => undefined } });
    const sent: Array<{ url: string; method: string; authorization: string | null; signedIn: boolean }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      sent.push({ url, method: init.method ?? "GET", authorization: new Headers(init.headers).get("Authorization"), signedIn: "auth" in local.items });
      if (url.endsWith("/clipper/revoke")) return new Response(null, { status: 204 });
      const result = { content: [{ text: JSON.stringify({ person: { id: "p1", name: "Ada" }, workspaces: [], readOnly: false, folderIds: null }) }] };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    });

    const clipper = createClipper();
    expect((await clipper.getState()).auth.personName).toBe("Ada");
    const after = await clipper.disconnect();

    expect(sent.at(-1)).toEqual({ url: "https://ink.test/clipper/revoke", method: "POST", authorization: "Bearer cink_clipper", signedIn: true });
    expect(local.items.auth).toBeUndefined();
    expect(after.auth.status).toBe("missing");
  });

  it("still forgets the token when the server can't be reached", async () => {
    const local = area({ auth: { token: "cink_clipper", host: "https://ink.test" } });
    vi.stubGlobal("chrome", { storage: { local, session: area() }, action: { setBadgeText: async () => undefined } });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });

    const after = await createClipper().disconnect();

    expect(local.items.auth).toBeUndefined();
    expect(after.auth.status).toBe("missing");
  });
});
