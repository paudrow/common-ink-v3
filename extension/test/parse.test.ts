import { describe, expect, it } from "vitest";
import { parseCapture } from "../src/clip/parse.ts";
import { clipFromTree, INLINE_IMAGE_CAP } from "../src/clip/tree.ts";
import type { HtmlTree } from "../src/clip/types.ts";

/** A data URL of `bytes` bytes of a PNG's signature and then filler, as a page writes an image inline. */
const dataPng = (bytes: number) => {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < bytes; i++) body[i] = i % 251;
  return `data:image/png;base64,${Buffer.from(body).toString("base64")}`;
};

const image = (src: string): HtmlTree => ({ tag: "img", attrs: { src, alt: "Wall" }, children: [], text: "" });

const capture = (...images: HtmlTree[]) => ({
  mode: "page",
  title: "Walls",
  source: { pageTitle: "Walls", pageUrl: "https://walls.example/", clippedOn: "2026-10-20" },
  tree: { tag: "article", attrs: {}, children: images, text: "" },
});

const imagesOf = (raw: unknown) =>
  clipFromTree(parseCapture(raw)).blocks.flatMap((block) => (block.type === "image" ? [block.image.source] : []));

describe("an image written inline in the page", () => {
  it("is carried whole, however much longer than other attributes it is", () => {
    const src = dataPng(45_913);
    expect(imagesOf(capture(image(src)))).toEqual([{ kind: "inline", mediaType: "image/png", base64: src.slice("data:image/png;base64,".length) }]);
  });

  it("is too big, and never cut short, when it is over the cap for one image", () => {
    expect(imagesOf(capture(image(dataPng(INLINE_IMAGE_CAP + 1))))).toEqual([{ kind: "skip", reason: "inline-too-big" }]);
  });

  it("is too big once the images before it fill the cap for one clip", () => {
    const near = dataPng(INLINE_IMAGE_CAP - 1000);
    const kinds = imagesOf(capture(...Array.from({ length: 5 }, () => image(near)))).map((source) => source.kind);
    expect(kinds).toEqual(["inline", "inline", "inline", "inline", "skip"]);
  });

  it("leaves other attributes cut at their limit", () => {
    const long = `https://walls.example/${"a".repeat(9_000)}`;
    const parsed = parseCapture({ ...capture(), tree: { tag: "a", attrs: { href: long }, children: [], text: "Walls" } });
    expect(parsed.tree.attrs.href).toHaveLength(8_000);
  });
});
