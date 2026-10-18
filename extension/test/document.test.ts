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
});