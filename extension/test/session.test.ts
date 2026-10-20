import { describe, expect, it } from "vitest";
import { FRESH_MS, reduce, settle, type Session } from "../src/session.ts";
import type { Clip } from "../src/clip/types.ts";

const clip: Clip = {
  mode: "page",
  title: "Council",
  source: { pageTitle: "Council", pageUrl: "https://example.com/a", clippedOn: "2026-10-18" },
  blocks: [],
};

const review: Session = { status: "review", clip, draft: { title: "Council", workspaceId: "w", folderId: "f" } };

describe("reduce", () => {
  it("ignores a capture while a save is in flight", () => {
    const saving: Session = { status: "saving", clip, draft: { title: "Council", workspaceId: "w", folderId: "f" }, placed: {}, missed: [], createKey: "k", note: null };
    const next = reduce(saving, { type: "captured", clip: { ...clip, title: "Other" }, defaults: { title: "Other", workspaceId: "w", folderId: "f" } });
    expect(next).toBe(saving);
  });

  it("keeps placed uploads when a failed save is tried again", () => {
    const failed: Session = {
      status: "failed",
      clip,
      draft: { title: "Council", workspaceId: "w", folderId: "f" },
      placed: { "https://example.com/a.png": { id: "aaaaaaaaaaaa", width: 1, height: 1 } },
      missed: [{ key: "i1", reason: "unfetched" }],
      createKey: "clip-key",
      message: "The server refused.",
    };
    const next = reduce(failed, { type: "save" });
    expect(next.status).toBe("saving");
    if (next.status === "saving") {
      expect(next.placed).toEqual(failed.placed);
      expect(next.missed).toEqual([]);
      expect(next.createKey).toBe("clip-key");
    }
  });

  it("ignores dismiss while a save is in flight", () => {
    const saving: Session = { status: "saving", clip, draft: { title: "Council", workspaceId: "w", folderId: "f" }, placed: {}, missed: [], createKey: "k", note: null };
    expect(reduce(saving, { type: "dismiss" })).toBe(saving);
  });

  it("ignores a second save while saving, and a save from the saved note", () => {
    const saving: Session = { status: "saving", clip, draft: { title: "Council", workspaceId: "w", folderId: "f" }, placed: {}, missed: [], createKey: "k", note: { id: "n", slug: "council", title: "Council" } };
    expect(reduce(saving, { type: "save" })).toBe(saving);
    const saved = reduce(review, { type: "save" });
    expect(saved.status).toBe("saving");
  });

  it("replaces a review with a new capture", () => {
    const next = reduce(review, { type: "captured", clip: { ...clip, title: "Other" }, defaults: { title: "Other", workspaceId: null, folderId: null } });
    expect(next.status).toBe("review");
    if (next.status === "review") expect(next.clip.title).toBe("Other");
  });
});

describe("settle", () => {
  const saved: Session = { status: "saved", note: { id: "n", slug: "council", title: "Council", url: "https://commonink.app/n" }, missed: [], draft: review.draft };

  it("opens on a fresh clip after a note was saved", () => {
    expect(settle(saved, 0, FRESH_MS + 1).status).toBe("idle");
  });

  it("keeps a clip that just arrived, and clears one that has been sitting", () => {
    expect(settle(review, 1_000, 1_000 + FRESH_MS).status).toBe("review");
    expect(settle(review, 1_000, 1_000 + FRESH_MS + 1).status).toBe("idle");
  });

  it("leaves a save that is still running", () => {
    const saving: Session = { status: "saving", clip, draft: { title: "Council", workspaceId: "w", folderId: "f" }, placed: {}, missed: [], createKey: "k", note: null };
    expect(settle(saving, 0, 10_000)).toBe(saving);
  });
});
