import { describe, expect, it } from "vitest";
import { fileClass, imageSize, kindOf, typeOf } from "../../src/core/filetypes.ts";
import { namedUploads, sampleFile, sampleSize } from "../../scripts/sample-files.ts";

describe("the sample files a Try note names", () => {
  it("are what their names say, to the same code that types an upload", async () => {
    const typed = async (name: string) => typeOf(name, (await sampleFile(name))!.subarray(0, 4096));
    const names = ["sample.png", "sample.pdf", "sample.wav", "sample.webm", "sample.csv", "sample.txt", "sample.md"];
    const types = await Promise.all(names.map(typed));
    expect(types).toEqual(["image/png", "application/pdf", "audio/wav", "video/webm", "application/octet-stream", "application/octet-stream", "application/octet-stream"]);
    expect(types.map(kindOf)).toEqual(["image", "file", "audio", "video", "file", "file", "file"]);
    expect(names.map((name, i) => fileClass({ name, type: types[i]! }))).toEqual(["image", "pdf", "audio", "video", "text", "text", "text"]);
    expect([sampleSize("sample.webm"), sampleSize("sample.png")]).toEqual([{ width: 320, height: 180 }, null]);
    expect(imageSize("image/png", (await sampleFile("sample.png"))!.subarray(0, 4096))).toEqual({ width: 640, height: 360 });
    expect(await sampleFile("Sample.PNG")).not.toBeNull();
    expect(await sampleFile("other.png")).toBeNull();
  });

  it("are the video in the browser tests' fixture, and text in UTF-8, with a CSV whose quoted cells hold a comma, a line break and a quote", async () => {
    const webm = (await sampleFile("sample.webm"))!;
    expect([webm.length, [...webm.subarray(0, 4)]]).toEqual([7315, [0x1a, 0x45, 0xdf, 0xa3]]);
    const text = async (name: string) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode((await sampleFile(name))!);
    expect((await text("sample.csv")).split("\r\n")).toEqual([
      "city,country,note",
      'Lisbon,Portugal,"Hills, trams and tiles"',
      'Kyoto,Japan,"Temples',
      'and gardens"',
      'Reykjavík,Iceland,"The ""world\'s northernmost"" capital"',
      "Nairobi,Kenya,Green city in the sun",
      "",
    ]);
    expect(await text("sample.txt")).toMatch(/^A plain text file/);
    expect(await text("sample.md")).toMatch(/^# A markdown file\n/);
  });

  it("are named by an embed whose config is a file's name, and not by one that holds an id or sits in code", () => {
    const text = "::image{sample.png}\n\nsee ::file{sample.pdf} here\n\n::image{aaaaaaaaaaaa 320x180}\n\n`::audio{sample.wav}`\n\n```\n::image{sample.png}\n```\n\n::timer{5m}";
    const named = namedUploads(text);
    expect(named.map(({ embed, name }) => [embed, name])).toEqual([["image", "sample.png"], ["file", "sample.pdf"]]);
    expect(named.map(({ from, to }) => text.slice(from, to))).toEqual(["::image{sample.png}", "::file{sample.pdf}"]);
  });

  it("keep a size word written after the name", () => {
    const text = "::image{sample.png medium}\n\n::image{sample.png huge}";
    expect(namedUploads(text).map(({ name, word }) => [name, word])).toEqual([["sample.png", "medium"]]);
  });
});
