import { expect, it } from "vitest";
import { tagOfPath, tagPath } from "../../src/web/plugins/tags/path.ts";

it("a tag's address is under /tags, and reads back as the tag", () => {
  expect(tagPath("work")).toBe("/tags/work");
  expect(tagOfPath("/tags/work")).toBe("work");
  expect(tagPath("café_2")).toBe("/tags/caf%C3%A9_2");
  expect(tagOfPath("/tags/caf%C3%A9_2")).toBe("café_2");
});

it("a tag with a slash in it keeps the slash in its address", () => {
  expect(tagPath("work/2026-q4")).toBe("/tags/work/2026-q4");
  expect(tagOfPath("/tags/work/2026-q4")).toBe("work/2026-q4");
});

it("an address that names no tag, or isn't written as one, names none", () => {
  expect(tagOfPath("/tags")).toBeNull();
  expect(tagOfPath("/tags/")).toBeNull();
  expect(tagOfPath("/tagsy/work")).toBeNull();
  expect(tagOfPath("/tags/%E0%A4%A")).toBeNull();
});

it("whatever an address says is read as a name and nothing more", () => {
  expect(tagOfPath("/tags/%3Cimg%20src%3Dx%3E")).toBe("<img src=x>");
});
