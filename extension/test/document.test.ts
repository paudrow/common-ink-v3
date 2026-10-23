import { describe, expect, it } from "vitest";
import { fetchDocument, fileTitle, isDocument, urlLooksLikeDocument } from "../src/clip/document.ts";

const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Title (Council minutes) >> endobj\n%%EOF");

describe("documents", () => {
  it("treats a PDF or JSON address as a document, and a page as a page", () => {
    expect(urlLooksLikeDocument("https://example.com/files/minutes.pdf")).toBe(true);
    expect(urlLooksLikeDocument("https://example.com/data/notes.json")).toBe(true);
    expect(urlLooksLikeDocument("https://example.com/news/story")).toBe(false);
    expect(isDocument("https://example.com/download", "application/pdf", "minutes.pdf")).toBe(true);
    expect(isDocument("https://example.com/story", "text/html; charset=utf-8", "story")).toBe(false);
  });

  it("reads a PDF title, and otherwise the file name", () => {
    expect(fileTitle("minutes.pdf", pdf)).toBe("Council minutes");
    expect(fileTitle("notes.json", new TextEncoder().encode("{}"))).toBe("notes");
  });

  it("downloads a PDF and skips an HTML page", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith(".pdf")) {
        return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="minutes.pdf"' } });
      }
      return new Response("<html><title>News</title></html>", { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const file = await fetchDocument("https://example.com/minutes.pdf", fetchImpl);
    expect(file).toMatchObject({ name: "minutes.pdf", title: "Council minutes" });
    expect(await fetchDocument("https://example.com/story", fetchImpl)).toBeNull();
  });

  it("follows no redirect, so a page can't point the member's cookies at another site and clip what it answers", async () => {
    const secret = JSON.stringify({ account: "dummy-account", balance: 1 });
    const answer = (url: string, credentials: RequestCredentials | undefined): Response => {
      if (url === "https://attacker.test/page.json") return new Response(null, { status: 302, headers: { Location: "https://bank.test/me.json" } });
      if (url === "https://attacker.test/intranet.json") return new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/admin.json" } });
      if (url === "https://bank.test/me.json" && credentials === "include") return new Response(secret, { headers: { "Content-Type": "application/json" } });
      if (url === "http://10.0.0.1/admin.json") return new Response(secret, { headers: { "Content-Type": "application/json" } });
      if (url === "https://example.com/minutes.pdf") return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
      return new Response(null, { status: 403 });
    };
    // Each redirect mode as Chrome applies it to an extension's fetch, with the member signed in to bank.test.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const first = answer(String(input), init?.credentials);
      const location = first.headers.get("location");
      if (!location) return first;
      if (init?.redirect === "error") throw new TypeError("redirect");
      if (init?.redirect === "manual") {
        const response = new Response(null, { status: 200 });
        Object.defineProperties(response, { type: { value: "opaqueredirect" }, status: { value: 0 }, ok: { value: false } });
        return response;
      }
      return answer(location, init?.credentials);
    }) as typeof fetch;
    expect(await fetchDocument("https://attacker.test/page.json", fetchImpl)).toBeNull();
    expect(await fetchDocument("https://attacker.test/intranet.json", fetchImpl)).toBeNull();
    expect(await fetchDocument("https://example.com/minutes.pdf", fetchImpl)).toMatchObject({ name: "minutes.pdf", title: "Council minutes" });
  });
});