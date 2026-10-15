import { describe, expect, it } from "vitest";
import { disposition, fileClass, kindOf, showsInline, typeOf, typesOf } from "../../src/core/filetypes.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("what a person calls a file", () => {
  it("is a PDF only when its name ends in pdf and its bytes start as one, and a PDF is shown in place, by the browser's viewer", () => {
    expect(typeOf("paper.pdf", bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(typeOf("PAPER.PDF", bytes("%PDF-2.0"))).toBe("application/pdf");
    expect(typeOf("paper.pdf", bytes("<html><script>"))).toBe("application/octet-stream");
    expect(typeOf("paper.txt", bytes("%PDF-1.7"))).toBe("application/octet-stream");
    expect([kindOf("application/pdf"), showsInline("application/pdf")]).toEqual(["file", true]);
    expect(disposition("application/pdf", "paper.pdf")).toMatch(/^inline; /);
  });

  it("is its kind, a PDF, text by its name's ending, or other", () => {
    const of = (name: string, type: string) => fileClass({ name, type });
    expect([
      of("dot.png", "image/png"),
      of("clip.mp4", "video/mp4"),
      of("note.wav", "audio/wav"),
      of("paper.pdf", "application/pdf"),
      of("notes.md", "application/octet-stream"),
      of("Data.CSV", "application/octet-stream"),
      of("app.log", "application/octet-stream"),
      of("main.ts", "application/octet-stream"),
      of("archive.zip", "application/octet-stream"),
      of("paper.pdf", "application/octet-stream"),
      of("noending", "application/octet-stream"),
      of("drawing.svg", "image/svg+xml"),
    ]).toEqual(["image", "video", "audio", "pdf", "text", "text", "text", "text", "other", "other", "other", "image"]);
    expect(typesOf("pdf")).toEqual(["application/pdf"]);
    expect(typesOf("text")).toEqual([]);
    expect(typesOf("other")).toEqual([]);
  });
});
