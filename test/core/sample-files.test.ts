import { describe, expect, it } from "vitest";
import { imageSize, kindOf, typeOf } from "../../src/core/filetypes.ts";
import { namedUploads, sampleFile } from "../../scripts/sample-files.ts";

describe("the sample files a Try note names", () => {
  it("are what their names say, to the same code that types an upload", async () => {
    const typed = async (name: string) => typeOf(name, (await sampleFile(name))!.subarray(0, 4096));
    const types = await Promise.all(["sample.png", "sample.pdf", "sample.wav"].map(typed));
    expect(types).toEqual(["image/png", "application/octet-stream", "audio/wav"]);
    expect(types.map(kindOf)).toEqual(["image", "file", "audio"]);
    expect(imageSize("image/png", (await sampleFile("sample.png"))!.subarray(0, 4096))).toEqual({ width: 640, height: 360 });
    expect(await sampleFile("Sample.PNG")).not.toBeNull();
    expect(await sampleFile("other.png")).toBeNull();
  });

  it("are named by an embed whose config is a file's name, and not by one that holds an id or sits in code", () => {
    const text = "::image{sample.png}\n\nsee ::file{sample.pdf} here\n\n::image{aaaaaaaaaaaa 320x180}\n\n`::audio{sample.wav}`\n\n```\n::image{sample.png}\n```\n\n::timer{5m}";
    const named = namedUploads(text);
    expect(named.map(({ embed, name }) => [embed, name])).toEqual([["image", "sample.png"], ["file", "sample.pdf"]]);
    expect(named.map(({ from, to }) => text.slice(from, to))).toEqual(["::image{sample.png}", "::file{sample.pdf}"]);
  });
});
