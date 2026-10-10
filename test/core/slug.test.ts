import { describe, expect, it } from "vitest";
import { noteIdFromPath, noteSlug, noteTitle } from "../../src/core/slug.ts";

describe("a note's title", () => {
  it("is its first # heading", () => {
    expect(noteTitle("intro\n## Not this\n# Café Notes #\n# Later")).toBe("Café Notes");
  });

  it("skips headings inside code blocks", () => {
    expect(noteTitle("```sh\n# a comment\n```\n# Real title")).toBe("Real title");
  });

  it("keeps a # that is part of the words", () => {
    expect(noteTitle("# Learning C#")).toBe("Learning C#");
  });

  it("is empty without a heading", () => {
    expect(noteTitle("#hashtag only\n\nbody")).toBe("");
  });
});

describe("a note's slug", () => {
  it("follows the title", () => {
    expect(noteSlug("Café Notes: Week 1!")).toBe("cafe-notes-week-1");
  });

  it("falls back when the title has nothing to use", () => {
    expect(noteSlug("")).toBe("untitled");
    expect(noteSlug("日本語")).toBe("untitled");
  });
});

describe("a note's path", () => {
  it("opens the note by id whatever the slug says", () => {
    expect(noteIdFromPath("/note/old-title-abc123def456")).toBe("abc123def456");
    expect(noteIdFromPath("/note/abc123def456")).toBe("abc123def456");
    expect(noteIdFromPath("/note/too-short-abc")).toBeNull();
  });
});
