import { describe, expect, it } from "vitest";
import { matching } from "../../src/web/plugins/lib/match.ts";
import { narrowed, openable, selectedIn, uploadItem, uploadPath, writtenFor } from "../../src/web/plugins/uploads/finding.ts";
import { droppedFiles, onItsOwnLine, pastedFiles, refusal } from "../../src/web/plugins/uploads/pasting.ts";
import { boxFor, formatBytes } from "../../src/web/plugins/uploads/sizing.ts";
import { referredUploads } from "../../src/web/referredUploads.ts";

const ID = "abcdefgh1234";

describe("the room an upload's embed keeps", () => {
  it("is the size the note writes, at its own shape", () => {
    expect(boxFor("image", `${ID} 640x480`)).toEqual({ ratio: 640 / 480, width: 640 });
    expect(boxFor("video", `${ID} 640x360`)).toEqual({ ratio: 16 / 9, width: 640 });
  });

  it("is never larger than the picture, and never taller than 480 pixels", () => {
    expect(boxFor("image", `${ID} 20x10`)).toEqual({ ratio: 2, width: 20 });
    expect(boxFor("image", `${ID} 300x900`)).toEqual({ ratio: 1 / 3, width: 160 });
    expect(boxFor("image", `${ID} 4000x3000`)).toEqual({ ratio: 4 / 3, width: 640 });
  });

  it("is a fixed box for a picture or a video written without a size, or with one that can't be read", () => {
    expect(boxFor("image", ID)).toEqual({ ratio: 16 / 9, width: 480 });
    expect(boxFor("video", `${ID} wide`)).toEqual({ ratio: 16 / 9, width: 480 });
    expect(boxFor("image", `${ID} 0x100`)).toEqual({ ratio: 16 / 9, width: 480 });
  });

  it("is a fixed height for a recording, whatever else its embed says, and nothing for a file", () => {
    expect(boxFor("audio", ID)).toEqual({ height: 56 });
    expect(boxFor("audio", `${ID} 640x480`)).toEqual({ height: 56 });
    expect(boxFor("file", `${ID} 640x480`)).toBeNull();
  });
});

describe("a file's size, as a person reads it", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1023, "1023 bytes"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [1024 * 1024 - 1, "1 MB"],
    [1024 * 1024, "1 MB"],
    [2.5 * 1024 * 1024, "2.5 MB"],
    [50 * 1024 * 1024, "50 MB"],
    [50 * 1024 * 1024 + 1, "50 MB"],
    [1024 * 1024 * 1024, "1 GB"],
    [5 * 1024 * 1024 * 1024 * 1024, "5120 GB"],
  ])("%d is %s", (bytes, said) => expect(formatBytes(bytes)).toBe(said));
});

describe("what a paste or a drop carries", () => {
  it("takes a screenshot, a picture copied from a page, and a file copied from a folder as files", () => {
    expect(pastedFiles({ types: ["Files"], files: ["shot.png"] })).toEqual(["shot.png"]);
    expect(pastedFiles({ types: ["text/html", "Files"], files: ["cat.jpg"] })).toEqual(["cat.jpg"]);
    expect(pastedFiles({ types: ["text/plain", "Files"], files: ["report.pdf", "data.csv"] })).toEqual(["report.pdf", "data.csv"]);
  });

  it("leaves text alone: a paste with no file, and cells or words copied with a picture of themselves", () => {
    expect(pastedFiles({ types: ["text/plain"], files: [] })).toEqual([]);
    expect(pastedFiles({ types: ["text/plain", "text/html"], files: [] })).toEqual([]);
    expect(pastedFiles({ types: ["text/plain", "text/html", "text/rtf", "Files"], files: ["cells.png"] })).toEqual([]);
  });

  it("takes every file of a drop, and none from dragged text", () => {
    expect(droppedFiles({ types: ["Files"], files: ["a.png", "b.mp4"] })).toEqual(["a.png", "b.mp4"]);
    expect(droppedFiles({ types: ["text/plain"], files: [] })).toEqual([]);
  });

  it("refuses a file over 50 MB and an empty one before any of it is sent", () => {
    expect(refusal({ name: "film.mov", size: 50 * 1024 * 1024 })).toBeNull();
    expect(refusal({ name: "film.mov", size: 50 * 1024 * 1024 + 1 })).toBe("film.mov is 50 MB. A file can be at most 50 MB.");
    expect(refusal({ name: "film.mov", size: 300 * 1024 * 1024 })).toBe("film.mov is 300 MB. A file can be at most 50 MB.");
    expect(refusal({ name: "nothing.txt", size: 0 })).toBe("nothing.txt is empty, so there is nothing to upload.");
  });
});

describe("where an uploaded file is written", () => {
  const written = `::image{${ID} 4x3}`;

  it("takes the place of a blank line", () => {
    expect(onItsOwnLine(written, { from: 10, text: "", last: false })).toEqual({ from: 10, to: 10, insert: written, end: 10 + written.length, after: 11 + written.length });
    expect(onItsOwnLine(written, { from: 10, text: "  ", last: false })).toEqual({ from: 10, to: 12, insert: written, end: 10 + written.length, after: 11 + written.length });
  });

  it("goes on a new line under a line with words, which stay as they are", () => {
    expect(onItsOwnLine(written, { from: 10, text: "words", last: false })).toEqual({ from: 15, to: 15, insert: `\n${written}`, end: 16 + written.length, after: 17 + written.length });
  });

  it("makes a line under it at the end of the note, for the cursor", () => {
    expect(onItsOwnLine(written, { from: 10, text: "", last: true }).insert).toBe(`${written}\n`);
    expect(onItsOwnLine(written, { from: 10, text: "words", last: true }).insert).toBe(`\n${written}\n`);
  });
});

describe("how a note writes an upload", () => {
  it("writes a picture with the size the server read, or else the one the browser measured, or none", () => {
    expect(writtenFor({ id: ID, kind: "image", width: 640, height: 480 }, { width: 1, height: 1 })).toBe(`::image{${ID} 640x480}`);
    expect(writtenFor({ id: ID, kind: "image", width: null, height: null }, { width: 120, height: 80 })).toBe(`::image{${ID} 120x80}`);
    expect(writtenFor({ id: ID, kind: "image", width: null, height: null })).toBe(`::image{${ID}}`);
  });

  it("writes a video with the size the browser measured or a default, and a recording and a file with none", () => {
    expect(writtenFor({ id: ID, kind: "video", width: null, height: null }, { width: 1920, height: 1080 })).toBe(`::video{${ID} 1920x1080}`);
    expect(writtenFor({ id: ID, kind: "video", width: null, height: null })).toBe(`::video{${ID} 640x360}`);
    expect(writtenFor({ id: ID, kind: "audio", width: null, height: null }, { width: 9, height: 9 })).toBe(`::audio{${ID}}`);
    expect(writtenFor({ id: ID, kind: "file", width: null, height: null })).toBe(`::file{${ID}}`);
  });
});

describe("finding an upload", () => {
  const uploads = [
    { id: "aaaaaaaaaaaa", name: "Harbour.PNG", kind: "image", state: "live" },
    { id: "bbbbbbbbbbbb", name: "minutes.txt", kind: "file", state: "live" },
    { id: "cccccccccccc", name: "harbour-walk.mp4", kind: "video", state: "archived" },
    { id: "dddddddddddd", name: "old-harbour.png", kind: "image", state: "trashed" },
  ] as const;

  it("narrows the Uploads page by name, ignoring case, and by kind, keeping the order", () => {
    expect(narrowed(uploads, { text: " harb ", kind: null }).map((u) => u.name)).toEqual(["Harbour.PNG", "harbour-walk.mp4", "old-harbour.png"]);
    expect(narrowed(uploads, { text: "harb", kind: "image" }).map((u) => u.name)).toEqual(["Harbour.PNG", "old-harbour.png"]);
    expect(narrowed(uploads, { text: "", kind: "file" }).map((u) => u.name)).toEqual(["minutes.txt"]);
    expect(narrowed(uploads, { text: "zebra", kind: null })).toEqual([]);
  });

  const notes = [
    { id: "n1n1n1n1n1n1", label: "The old harbour" },
    { id: "n2n2n2n2n2n2", label: "Harbour walk" },
    { id: "n3n3n3n3n3n3", label: "Minutes of the board" },
  ];
  const offered = openable(notes, uploads, (u) => `Upload ${u.state}`);
  const found = (typed: string) => matching(offered, typed, (item) => item.label).map((item) => item.label);

  it("offers quick open every note, then every upload not in Trash, by its file name", () => {
    expect(offered.map((item) => [item.id, item.label, item.hint])).toEqual([
      ["n1n1n1n1n1n1", "The old harbour", undefined],
      ["n2n2n2n2n2n2", "Harbour walk", undefined],
      ["n3n3n3n3n3n3", "Minutes of the board", undefined],
      ["upload:aaaaaaaaaaaa", "Harbour.PNG", "Upload live"],
      ["upload:bbbbbbbbbbbb", "minutes.txt", "Upload live"],
      ["upload:cccccccccccc", "harbour-walk.mp4", "Upload archived"],
    ]);
  });

  it("ranks an upload among the notes by how well its name fits, after a note that fits as well", () => {
    expect(found("harbour")).toEqual(["Harbour walk", "Harbour.PNG", "harbour-walk.mp4", "The old harbour"]);
    expect(found("minutes.")).toEqual(["minutes.txt"]);
  });

  it("leaves the notes ranked as they are with no uploads when what is typed fits no upload", () => {
    for (const typed of ["board", "the", "old h", "walk"]) expect(found(typed).filter((label) => notes.some((n) => n.label === label))).toEqual(matching(notes, typed, (n) => n.label).map((n) => n.label));
    expect(found("board")).toEqual(["Minutes of the board"]);
  });

  it("tells a picked upload from a picked note, and reads the selected upload from the page's address", () => {
    expect(uploadItem("upload:aaaaaaaaaaaa")).toBe("aaaaaaaaaaaa");
    expect(uploadItem("n1n1n1n1n1n1")).toBeNull();
    expect(uploadPath("aaaaaaaaaaaa")).toBe("/uploads/aaaaaaaaaaaa");
    expect(selectedIn("/uploads/aaaaaaaaaaaa")).toBe("aaaaaaaaaaaa");
    expect(selectedIn("/uploads")).toBeNull();
    expect(selectedIn("/uploads/not-an-id")).toBeNull();
  });
});

describe("what the app was told of the uploads notes refer to", () => {
  const picture = { name: "a.png", type: "image/png", kind: "image", size: 10, width: 4, height: 3, state: "live" } as const;

  it("knows nothing of an upload until it is told, and then knows whether it is there for the reader", () => {
    const referred = referredUploads();
    expect(referred.get(ID)).toBeUndefined();
    referred.learn([
      { id: ID, upload: picture },
      { id: "zzzzzzzzzzzz", upload: null },
    ]);
    expect(referred.get(ID)).toEqual(picture);
    expect(referred.get("zzzzzzzzzzzz")).toBeNull();
  });

  it("tells its listeners once when something is different, and not when a read says the same again", () => {
    const referred = referredUploads();
    let told = 0;
    const stop = referred.subscribe(() => told++);
    referred.learn([{ id: ID, upload: picture }]);
    referred.learn([{ id: ID, upload: { ...picture } }]);
    expect(told).toBe(1);
    referred.learn([{ id: ID, upload: { ...picture, state: "trashed" } }]);
    referred.learn([{ id: ID, upload: null }]);
    expect(told).toBe(3);
    stop();
    referred.learn([{ id: ID, upload: picture }]);
    expect(told).toBe(3);
  });
});
