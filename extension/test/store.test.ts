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

describe("signIn", () => {
  const ID = "nloccbnkboaohceggkmbmkppnjjkkdkh";

  /** A clipper whose sign-in window ends with Chrome's `failure`, and whose fetch of the sign-in page answers with `page`. */
  function failingWith(failure: string, page: () => Promise<Response>) {
    const probed: Array<{ url: string; credentials?: RequestCredentials; redirect?: RequestRedirect }> = [];
    vi.stubGlobal("chrome", {
      storage: { local: area(), session: area() },
      action: { setBadgeText: async () => undefined },
      runtime: { id: ID },
      identity: {
        getRedirectURL: () => `https://${ID}.chromiumapp.org/`,
        launchWebAuthFlow: async () => {
          throw new Error(failure);
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      probed.push({ url: String(input), credentials: init.credentials, redirect: init.redirect });
      return page();
    });
    return { clipper: createClipper(), probed };
  }

  it("says the window was closed when Chrome says the member didn't approve", async () => {
    const { clipper, probed } = failingWith("The user did not approve access.", async () => new Response("unexpected"));
    expect((await clipper.signIn("https://ink.test")).notice).toBe("You closed the sign-in window before allowing the clipper.");
    expect(probed).toEqual([]);
  });

  it("names the extension's ID when Common Ink doesn't allow it", async () => {
    const { clipper, probed } = failingWith("Authorization page could not be loaded.", async () => new Response("<h1>That address can't receive a clipper</h1>", { status: 400 }));
    const state = await clipper.signIn("https://ink.test");
    expect(state.notice).toBe(`This clipper (ID ${ID}) isn't allowed to sign in to ink.test. Its CLIPPER_EXTENSION_IDS setting has to name that ID.`);
    // The page is asked without cookies, so the check signs no one in and allows nothing.
    expect(probed).toEqual([{ url: `https://ink.test/clipper/connect?redirect=${encodeURIComponent(`https://${ID}.chromiumapp.org/`)}`, credentials: "omit", redirect: "manual" }]);
  });

  it("says Common Ink didn't answer when the host can't be reached", async () => {
    const { clipper } = failingWith("Authorization page could not be loaded.", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await clipper.signIn("http://localhost:5299")).notice).toBe("Common Ink at localhost:5299 didn't answer. Check the host and that it is running.");
  });

  it("passes on what Chrome said when the page loads but the window still failed", async () => {
    const { clipper } = failingWith("Authorization page could not be loaded.", async () => new Response(null, { status: 503 }));
    expect((await clipper.signIn("https://ink.test")).notice).toBe("Common Ink at ink.test answered 503. Chrome said: Authorization page could not be loaded.");
  });

  it("passes on any other error from Chrome", async () => {
    const { clipper } = failingWith("Something new went wrong.", async () => new Response("unexpected"));
    expect((await clipper.signIn("https://ink.test")).notice).toBe("Sign-in failed. Chrome said: Something new went wrong.");
  });
});
