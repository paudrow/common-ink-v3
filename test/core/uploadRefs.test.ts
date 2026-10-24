import { describe, expect, it } from "vitest";
import { cropIn, shareIn, sizeIn, uploadIds, withCrop, withShare, withUpload, writtenUpload } from "../../src/core/uploadRefs.ts";

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
    for (const share of [1 / 3, 0.42, 1]) expect(uploadIds(`/image(${withShare(`${ID} 4x3`, share)})`)).toEqual([ID]);
    expect(writtenUpload("image", ID, { width: 4, height: 3 })).toBe(`/image(${ID} 4x3)`);
  });
});

describe("the part of its picture a note says is drawn", () => {
  it("is the crop word after the id, in the pixels of the size", () => {
    expect(cropIn(`${ID} 1200x800 crop=120,40,800,600`)).toEqual({ x: 120, y: 40, width: 800, height: 600 });
    expect(cropIn(`${ID} 1200x800 42% crop=0,0,600,800`)).toEqual({ x: 0, y: 0, width: 600, height: 800 });
    expect(cropIn(`${ID} 1200x800 crop=1,2,3,4 large`)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(cropIn(`${ID} 1200x800 huge crop=1,2,3,4 crop=5,6,7,8`)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("is only as much of it as is in the picture", () => {
    expect(cropIn(`${ID} 1200x800 crop=1000,700,800,600`)).toEqual({ x: 1000, y: 700, width: 200, height: 100 });
    expect(cropIn(`${ID} 1200x800 crop=1200,0,10,10`)).toBeNull();
  });

  it("is none for all of the picture, for no size, and for a word written any other way", () => {
    expect(cropIn(`${ID} 1200x800 crop=0,0,1200,800`)).toBeNull();
    expect(cropIn(`${ID} 1200x800 crop=0,0,5000,5000`)).toBeNull();
    expect(cropIn(`${ID} crop=1,2,3,4`)).toBeNull();
    expect(cropIn(`${ID} 1200x800 crop=1,2,0,4`)).toBeNull();
    for (const word of ["crop=1,2,3", "crop=1,2,3,4,5", "crop=-1,2,3,4", "crop=1.5,2,3,4", "Crop=1,2,3,4", "crop", "crop=1, 2,3,4"]) expect(cropIn(`${ID} 1200x800 ${word}`), word).toBeNull();
    expect(cropIn("crop=1,2,3,4")).toBeNull();
  });
});

describe("an embed drawing another part of its picture", () => {
  it("writes the crop in whole pixels after the size and the width", () => {
    expect(withCrop(`${ID} 1200x800`, { x: 120, y: 40, width: 800, height: 600 })).toBe(`${ID} 1200x800 crop=120,40,800,600`);
    expect(withCrop(`${ID} 1200x800 42%`, { x: 120.4, y: 39.6, width: 800.2, height: 600.5 })).toBe(`${ID} 1200x800 42% crop=120,40,801,600`);
    expect(withCrop(`${ID} 1200x800 medium huge`, { x: 0, y: 0, width: 600, height: 800 })).toBe(`${ID} 1200x800 medium crop=0,0,600,800 huge`);
  });

  it("puts a new crop after the size, and after the width where that follows the size, and keeps every other word", () => {
    expect(withCrop(`${ID} 1200x800 small crop=1,2,3,4 huge`, { x: 10, y: 20, width: 30, height: 40 })).toBe(`${ID} 1200x800 small crop=10,20,30,40 huge`);
    expect(withCrop(`${ID} 1200x800 huge small crop=1,2,3,4`, { x: 10, y: 20, width: 30, height: 40 })).toBe(`${ID} 1200x800 crop=10,20,30,40 huge small`);
  });

  it("writes none for null or for all of the picture, and keeps it within the picture", () => {
    expect(withCrop(`${ID} 1200x800 42% crop=120,40,800,600`, null)).toBe(`${ID} 1200x800 42%`);
    expect(withCrop(`${ID} 1200x800 crop=120,40,800,600`, { x: 0, y: 0, width: 1200, height: 800 })).toBe(`${ID} 1200x800`);
    expect(withCrop(`${ID} 1200x800`, { x: -0.3, y: 0.2, width: 1200.4, height: 799.9 })).toBe(`${ID} 1200x800`);
    expect(withCrop(`${ID} 1200x800`, { x: 1000, y: 700, width: 800, height: 600 })).toBe(`${ID} 1200x800 crop=1000,700,200,100`);
  });

  it("leaves a config with no size, or naming no upload, as it is", () => {
    expect(withCrop(`${ID} medium`, { x: 1, y: 2, width: 3, height: 4 })).toBe(`${ID} medium`);
    expect(withCrop("not an id", { x: 1, y: 2, width: 3, height: 4 })).toBe("not an id");
  });

  it("survives a new width, and a new width survives it", () => {
    const cropped = withCrop(`${ID} 1200x800 42%`, { x: 120, y: 40, width: 800, height: 600 });
    const resized = withShare(cropped, 0.6);
    expect(resized).toBe(`${ID} 1200x800 60% crop=120,40,800,600`);
    expect(cropIn(resized)).toEqual({ x: 120, y: 40, width: 800, height: 600 });
    expect(shareIn(withCrop(resized, { x: 0, y: 0, width: 600, height: 600 }))).toBe(0.6);
    expect(uploadIds(`/image(${resized})`)).toEqual([ID]);
  });
});

describe("a drawing's embed", () => {
  it("refers to its upload as a picture's does, and an empty one to none", () => {
    expect(uploadIds(`# Plan\n\n/drawing(${ID} 820x460 medium)\n\n/drawing()\n`)).toEqual([ID]);
  });

  it("names a new upload and its room in place of the one it named, keeping its width and every other word", () => {
    expect(withUpload(`${ID} 820x460 medium note=kept`, "zyxwvuts9876", { width: 640.4, height: 360.6 })).toBe("zyxwvuts9876 640x361 medium note=kept");
    expect(withUpload(`${ID} 42%`, "zyxwvuts9876", { width: 300, height: 200 })).toBe("zyxwvuts9876 300x200 42%");
    expect(withUpload(`${ID} medium`, "zyxwvuts9876", { width: 300, height: 200 })).toBe("zyxwvuts9876 300x200 medium");
  });

  it("names an upload in an empty one", () => {
    expect(withUpload("", ID, { width: 300, height: 200 })).toBe(`${ID} 300x200`);
    expect(withUpload("small", ID, { width: 300, height: 200 })).toBe(`${ID} 300x200 small`);
    expect(withUpload("820x460 medium", ID, { width: 300, height: 200 })).toBe(`${ID} 300x200 medium`);
  });
});
