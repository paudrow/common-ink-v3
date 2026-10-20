import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { unpackedExtensionId } from "../../scripts/extension-id.ts";
import { clipperFiles, zip } from "../bundle.ts";

test("the clipper's zip unzips to the extension Chrome loads, under the pinned id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clipper-zip-"));
  writeFileSync(path.join(dir, "clipper.zip"), zip(await clipperFiles()));
  expect(execFileSync("unzip", ["-tq", "clipper.zip"], { cwd: dir, encoding: "utf8" })).toMatch(/^No errors detected/);
  expect(execFileSync("unzip", ["-Z1", "clipper.zip"], { cwd: dir, encoding: "utf8" }).trim().split("\n")).toEqual([
    "background.js",
    "content.js",
    "popup.js",
    "manifest.json",
    "popup.html",
    "popup.css",
    "icon-16.png",
    "icon-48.png",
    "icon-128.png",
  ]);
  execFileSync("unzip", ["-q", "clipper.zip", "-d", "out"], { cwd: dir });
  expect(readFileSync(path.join(dir, "out/manifest.json"), "utf8")).toBe(readFileSync("extension/manifest.json", "utf8"));
  expect(unpackedExtensionId(path.join(dir, "out/manifest.json"))).toBe("nloccbnkboaohceggkmbmkppnjjkkdkh");
});

test("a zip keeps each file's bytes", () => {
  const files = new Map([
    ["a.txt", new TextEncoder().encode("first ".repeat(100))],
    ["b.bin", new Uint8Array([0, 255, 1, 254])],
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), "zip-"));
  writeFileSync(path.join(dir, "x.zip"), zip(files));
  expect(execFileSync("unzip", ["-p", "x.zip", "a.txt"], { cwd: dir, encoding: "utf8" })).toBe("first ".repeat(100));
  expect([...execFileSync("unzip", ["-p", "x.zip", "b.bin"], { cwd: dir })]).toEqual([0, 255, 1, 254]);
});
