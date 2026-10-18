import { describe, expect, it } from "vitest";
import { clipWithVideo } from "../src/clip/video.ts";
import type { Clip } from "../src/clip/types.ts";

const watch = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

describe("clipWithVideo", () => {
  it("keeps the description and leaves the watch address on its own line", () => {
    const clip: Clip = {
      mode: "page",
      title: "YouTube",
      source: { pageTitle: "YouTube", pageUrl: watch, clippedOn: "2026-10-18" },
      blocks: [{ type: "paragraph", inlines: [{ type: "text", text: "The first video on YouTube." }] }],
    };
    const next = clipWithVideo(clip, { title: "Me at the zoo", author: "jawed" }, watch);
    expect(next.title).toBe("Me at the zoo");
    expect(next.blocks).toEqual([
      { type: "paragraph", inlines: [{ type: "text", text: "jawed" }] },
      { type: "paragraph", inlines: [{ type: "text", text: "The first video on YouTube." }] },
      { type: "paragraph", inlines: [{ type: "link", href: watch, inlines: [{ type: "text", text: watch }] }] },
    ]);
  });
});