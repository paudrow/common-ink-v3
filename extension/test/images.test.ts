import { describe, expect, it } from "vitest";
import { PART_BYTES } from "../../src/core/parts.ts";
import { imageBox, placeId, planImage } from "../src/clip/images.ts";
import type { ClipImage } from "../src/clip/types.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("planImage", () => {
  it("names a PNG so the server sniff agrees", () => {
    expect(planImage(png)).toEqual({ action: "upload", name: "clip.png", bytes: png });
  });

  it("misses bytes that are not an image", () => {
    expect(planImage(Uint8Array.from([1, 2, 3, 4]))).toEqual({ action: "miss", reason: "not-image" });
  });

  it("misses a file longer than one request can carry", () => {
    const bytes = new Uint8Array(PART_BYTES + 1);
    bytes.set(png);
    expect(planImage(bytes)).toEqual({ action: "miss", reason: "too-big" });
  });

  it("misses a fetch that returned nothing", () => {
    expect(planImage(null)).toEqual({ action: "miss", reason: "unfetched" });
  });
});

describe("placeId and imageBox", () => {
  const remote: ClipImage = { key: "i1", alt: "Chamber", width: 1200, height: 800, source: { kind: "remote", url: "https://example.com/vote.png" } };

  it("keys a remote image by its URL", () => {
    expect(placeId(remote)).toBe("https://example.com/vote.png");
  });

  it("prefers the upload's size, then the page's, then nothing", () => {
    expect(imageBox({ width: 10, height: 12 }, remote)).toEqual({ width: 10, height: 12 });
    expect(imageBox({ width: null, height: null }, remote)).toEqual({ width: 1200, height: 800 });
    expect(imageBox({ width: null, height: null }, { width: null, height: null })).toBeNull();
  });
});
