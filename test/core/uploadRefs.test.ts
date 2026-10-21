import { describe, expect, it } from "vitest";
import { shareIn, sizeIn, uploadIds, withShare, writtenUpload } from "../../src/core/uploadRefs.ts";

const ID = "abcdefgh1234";

describe("how wide a note says a picture or a video is drawn", () => {
  it.each([
    [`${ID} 640x380`, 1],
    [`${ID} 640x380 small`, 1 / 3],
    [`${ID} 640x380 medium`, 1 / 2],
    [`${ID} 640x380 large`, 3 / 4],
    [`${ID} 640x380 full`, 1],
    [`${ID} large`, 3 / 4],
    [ID, 1],
    [`${ID} 640x380 42%`, 0.42],
    [`${ID} 640x380 1%`, 0.01],
    [`${ID} 640x380 100%`, 1],
    [`${ID} 33%`, 0.33],
    [`${ID} 640x380 crop medium`, 1 / 2],
    [`${ID} 640x380 huge small`, 1 / 3],
    [`${ID} 640x380 40% small`, 0.4],
  ])("%s is %d of the column", (config, share) => expect(shareIn(config)).toBe(share));

  it.each([`${ID} 640x380 huge`, `${ID} 640x380 300`, `${ID} 640x380 Small`, `${ID} 640x380 smallish`, `${ID} 640x380 0%`, `${ID} 640x380 101%`, `${ID} 640x380 4.5%`, `${ID} 640x380 50 %`, `${ID} wide`, "small", "50%"])("anything else, as %s, is the whole column", (config) => expect(shareIn(config)).toBe(1));

  it("leaves the size the app wrote as it was", () => {
    expect(sizeIn(`${ID} 640x380 medium`)).toEqual({ width: 640, height: 380 });
    expect(sizeIn(`${ID} 640x380`)).toEqual({ width: 640, height: 380 });
    expect(sizeIn(`${ID} medium`)).toBeNull();
  });
});

describe("an embed drawn another width", () => {
  it("writes a size word after the size where the share is one, and nothing for the whole column", () => {
    expect(withShare(`${ID} 640x380`, 1 / 2)).toBe(`${ID} 640x380 medium`);
    expect(withShare(`${ID} 640x380 medium`, 1 / 3)).toBe(`${ID} 640x380 small`);
    expect(withShare(`${ID} 640x380 42%`, 0.75)).toBe(`${ID} 640x380 large`);
    expect(withShare(`${ID} 640x380 large`, 1)).toBe(`${ID} 640x380`);
    expect(withShare(ID, 3 / 4)).toBe(`${ID} large`);
  });

  it("writes any other share as the whole percent nearest it, from 1% to 100%", () => {
    expect(withShare(`${ID} 640x380`, 0.42)).toBe(`${ID} 640x380 42%`);
    expect(withShare(`${ID} 640x380 small`, 0.4166)).toBe(`${ID} 640x380 42%`);
    expect(withShare(`${ID} 640x380 42%`, 0.335)).toBe(`${ID} 640x380 34%`);
    expect(withShare(`${ID} 640x380`, 0.332)).toBe(`${ID} 640x380 small`);
    expect(withShare(`${ID} 640x380`, 0.996)).toBe(`${ID} 640x380`);
    expect(withShare(`${ID} 640x380`, 0.001)).toBe(`${ID} 640x380 1%`);
  });

  it("reads back every whole percent it writes as that percent, but a third, which is small", () => {
    const back = Array.from({ length: 100 }, (_, i) => Math.round(shareIn(withShare(`${ID} 4x3`, (i + 1) / 100)) * 1e4) / 1e4);
    expect(back.filter((share, i) => share !== (i + 1) / 100)).toEqual([0.3333]);
  });

  it("keeps every other word, drops another width, and leaves a config naming no upload alone", () => {
    expect(withShare(`${ID} 640x380 huge`, 1 / 3)).toBe(`${ID} 640x380 small huge`);
    expect(withShare(`${ID} 640x380 medium crop=1,2,3,4`, 1)).toBe(`${ID} 640x380 crop=1,2,3,4`);
    expect(withShare(`${ID} 640x380 crop=1,2,3,4 large 30%`, 0.6)).toBe(`${ID} 640x380 60% crop=1,2,3,4`);
    expect(withShare("", 1 / 3)).toBe("");
    expect(withShare("not an id", 1 / 3)).toBe("not an id");
  });

  it("is still the same upload to the note", () => {
    for (const share of [1 / 3, 0.42, 1]) expect(uploadIds(`::image{${withShare(`${ID} 4x3`, share)}}`)).toEqual([ID]);
    expect(writtenUpload("image", ID, { width: 4, height: 3 })).toBe(`::image{${ID} 4x3}`);
  });
});
