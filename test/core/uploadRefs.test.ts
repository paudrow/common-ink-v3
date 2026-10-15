import { describe, expect, it } from "vitest";
import { sizeIn, sizeWordIn, uploadIds, withSizeWord, writtenUpload } from "../../src/core/uploadRefs.ts";

const ID = "abcdefgh1234";

describe("how wide a note says a picture or a video is drawn", () => {
  it.each([
    [`${ID} 640x380`, "full"],
    [`${ID} 640x380 small`, "small"],
    [`${ID} 640x380 medium`, "medium"],
    [`${ID} 640x380 large`, "large"],
    [`${ID} 640x380 full`, "full"],
    [`${ID} large`, "large"],
    [ID, "full"],
  ])("%s is %s", (config, word) => expect(sizeWordIn(config)).toBe(word));

  it.each([`${ID} 640x380 huge`, `${ID} 640x380 300`, `${ID} 640x380 Small`, `${ID} 640x380 smallish`, `${ID} 640x380 50%`, `${ID} wide`, "small"])("anything else, as %s, is full", (config) => expect(sizeWordIn(config)).toBe("full"));

  it("leaves the size the app wrote as it was", () => {
    expect(sizeIn(`${ID} 640x380 medium`)).toEqual({ width: 640, height: 380 });
    expect(sizeIn(`${ID} 640x380`)).toEqual({ width: 640, height: 380 });
    expect(sizeIn(`${ID} medium`)).toBeNull();
  });
});

describe("an embed drawn another width", () => {
  it("writes the word after the size, and nothing for full", () => {
    expect(withSizeWord(`${ID} 640x380`, "medium")).toBe(`${ID} 640x380 medium`);
    expect(withSizeWord(`${ID} 640x380 medium`, "small")).toBe(`${ID} 640x380 small`);
    expect(withSizeWord(`${ID} 640x380 large`, "full")).toBe(`${ID} 640x380`);
    expect(withSizeWord(ID, "large")).toBe(`${ID} large`);
  });

  it("drops what isn't its grammar, and leaves a config naming no upload alone", () => {
    expect(withSizeWord(`${ID} 640x380 huge`, "small")).toBe(`${ID} 640x380 small`);
    expect(withSizeWord(`${ID} 640x380 medium 12`, "full")).toBe(`${ID} 640x380`);
    expect(withSizeWord("", "small")).toBe("");
    expect(withSizeWord("not an id", "small")).toBe("not an id");
  });

  it("is still the same upload to the note", () => {
    for (const word of ["small", "medium", "large"] as const) expect(uploadIds(`::image{${withSizeWord(`${ID} 4x3`, word)}}`)).toEqual([ID]);
    expect(writtenUpload("image", ID, { width: 4, height: 3 })).toBe(`::image{${ID} 4x3}`);
  });
});
