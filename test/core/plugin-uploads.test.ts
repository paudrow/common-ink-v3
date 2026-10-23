import { describe, expect, it } from "vitest";
import { matching } from "../../src/web/plugins/lib/match.ts";
import { MINE, onlyMine, openable, reachWords, selectedIn, uploaderWords, uploadItem, uploadPath, withMine, writtenFor } from "../../src/web/plugins/uploads/finding.ts";
import { droppedFiles, onItsOwnLine, pastedFiles, refusal } from "../../src/web/plugins/uploads/pasting.ts";
import { shareIn, withShare } from "../../src/core/uploadRefs.ts";
import { boxFor, dragged, formatBytes, reachOf, stepped } from "../../src/web/plugins/uploads/sizing.ts";
import { referredUploads } from "../../src/web/referredUploads.ts";

const ID = "abcdefgh1234";

describe("the room an upload's embed keeps", () => {
  it("is the column's width at the note's shape, and never wider than the picture or the video is", () => {
    expect(boxFor("image", `${ID} 640x480`)).toEqual({ ratio: 640 / 480, maxWidth: 640 });
    expect(boxFor("video", `${ID} 640x360`)).toEqual({ ratio: 16 / 9, maxWidth: 640 });
    expect(boxFor("image", `${ID} 20x10`)).toEqual({ ratio: 2, maxWidth: 20 });
    expect(boxFor("image", `${ID} 300x900`)).toEqual({ ratio: 1 / 3, maxWidth: 300 });
    expect(boxFor("image", `${ID} 4000x3000`)).toEqual({ ratio: 4 / 3, maxWidth: 4000 });
    expect(boxFor("video", `${ID} 1920x1080`)).toEqual({ ratio: 16 / 9, maxWidth: 1920 });
  });

  it("is a share of the column for a size word, at the same shape and no wider than the picture", () => {
    expect(boxFor("image", `${ID} 640x480 small`)).toEqual({ ratio: 640 / 480, maxWidth: 640, share: 1 / 3 });
    expect(boxFor("image", `${ID} 640x480 medium`)).toEqual({ ratio: 640 / 480, maxWidth: 640, share: 1 / 2 });
    expect(boxFor("video", `${ID} 640x360 large`)).toEqual({ ratio: 16 / 9, maxWidth: 640, share: 3 / 4 });
    expect(boxFor("image", `${ID} 640x480 full`)).toEqual({ ratio: 640 / 480, maxWidth: 640 });
  });

  it("is a share of the column for a percent, at the same shape and no wider than the picture", () => {
    expect(boxFor("image", `${ID} 640x480 42%`)).toEqual({ ratio: 640 / 480, maxWidth: 640, share: 0.42 });
    expect(boxFor("video", `${ID} 640x360 7%`)).toEqual({ ratio: 16 / 9, maxWidth: 640, share: 0.07 });
    expect(boxFor("image", `${ID} 640x480 100%`)).toEqual({ ratio: 640 / 480, maxWidth: 640 });
  });

  it("is the whole column for a size it can't read, which is no error", () => {
    expect(boxFor("image", `${ID} 640x480 huge`)).toEqual({ ratio: 640 / 480, maxWidth: 640 });
    expect(boxFor("image", `${ID} 640x480 300`)).toEqual({ ratio: 640 / 480, maxWidth: 640 });
  });

  it("is a fixed box for a picture or a video written without a size, or with one that can't be read", () => {
    expect(boxFor("image", ID)).toEqual({ ratio: 16 / 9, maxWidth: 480 });
    expect(boxFor("video", `${ID} wide`)).toEqual({ ratio: 16 / 9, maxWidth: 480 });
    expect(boxFor("image", `${ID} 0x100`)).toEqual({ ratio: 16 / 9, maxWidth: 480 });
    expect(boxFor("image", `${ID} small`)).toEqual({ ratio: 16 / 9, maxWidth: 480, share: 1 / 3 });
  });

  it("is a cropped picture's crop: its shape, no wider than it, at its share of the column", () => {
    expect(boxFor("image", `${ID} 1200x800 crop=120,40,800,600`)).toEqual({ ratio: 800 / 600, maxWidth: 800 });
    expect(boxFor("image", `${ID} 1200x800 42% crop=0,0,400,800`)).toEqual({ ratio: 0.5, maxWidth: 400, share: 0.42 });
    expect(boxFor("image", `${ID} 1200x800 crop=1000,0,800,800`)).toEqual({ ratio: 200 / 800, maxWidth: 200 });
    expect(boxFor("image", `${ID} 1200x800 crop=0,0,1200,800`)).toEqual({ ratio: 1.5, maxWidth: 1200 });
  });

  it("is a video's whole size, which is never cropped", () => {
    expect(boxFor("video", `${ID} 640x360 crop=0,0,100,100`)).toEqual({ ratio: 16 / 9, maxWidth: 640 });
  });

  it("is a fixed height for a recording, whatever else its embed says, and nothing for a file", () => {
    expect(boxFor("audio", ID)).toEqual({ height: 56 });
    expect(boxFor("audio", `${ID} 640x480 small`)).toEqual({ height: 56 });
    expect(boxFor("file", `${ID} 640x480`)).toBeNull();
  });
});

describe("a drag of the size handle", () => {
  const wide = reachOf(600, 2000);
  const written = (x: number, free = false, reach = wide) => withShare(`${ID} 2000x1000`, dragged(reach, x, free));

  it("draws a picture any width it is dragged to, as a whole percent of the column", () => {
    expect(written(252)).toBe(`${ID} 2000x1000 42%`);
    expect(written(287)).toBe(`${ID} 2000x1000 48%`);
    expect(written(410)).toBe(`${ID} 2000x1000 68%`);
  });

  it("snaps to a size word's width within 12 pixels of it, unless free", () => {
    expect(written(190)).toBe(`${ID} 2000x1000 small`);
    expect(written(288)).toBe(`${ID} 2000x1000 medium`);
    expect(written(461)).toBe(`${ID} 2000x1000 large`);
    expect(written(589)).toBe(`${ID} 2000x1000`);
    expect(written(290, true)).toBe(`${ID} 2000x1000 48%`);
    expect(written(589, true)).toBe(`${ID} 2000x1000 98%`);
  });

  it("is no narrower than a tenth of the column and no wider than the column", () => {
    expect(written(0)).toBe(`${ID} 2000x1000 10%`);
    expect(written(-40, true)).toBe(`${ID} 2000x1000 10%`);
    expect(written(900)).toBe(`${ID} 2000x1000`);
  });

  it("is never wider than the picture, and at its own width is the whole column, which draws it as wide", () => {
    const narrow = reachOf(600, 320);
    expect(narrow.most).toBeCloseTo(0.5333, 4);
    expect(written(250, false, narrow)).toBe(`${ID} 2000x1000 42%`);
    expect(written(315, false, narrow)).toBe(`${ID} 2000x1000`);
    expect(written(500, true, narrow)).toBe(`${ID} 2000x1000`);
    expect(written(10, false, reachOf(600, 40))).toBe(`${ID} 2000x1000`);
  });
});

describe("a step of the size handle from the keyboard", () => {
  const wide = reachOf(600, 2000);

  it("is a twentieth of the column, stopping at a third, and stays at either end", () => {
    expect(stepped(wide, 1, -1)).toBe(0.95);
    expect(stepped(wide, 0.5, -1)).toBe(0.45);
    expect(stepped(wide, 0.42, 1)).toBe(0.45);
    expect(stepped(wide, 0.37, -1)).toBe(0.35);
    expect(stepped(wide, 0.35, -1)).toBe(1 / 3);
    expect(stepped(wide, 1 / 3, -1)).toBe(0.3);
    expect(stepped(wide, 0.3, 1)).toBe(1 / 3);
    expect(stepped(wide, 0.95, 1)).toBe(1);
    expect(stepped(wide, 1, 1)).toBe(1);
    expect(stepped(wide, 0.1, -1)).toBe(0.1);
  });

  it("is a hundredth of the column when fine", () => {
    expect(stepped(wide, 0.42, 1, true)).toBe(0.43);
    expect(stepped(wide, 0.5, -1, true)).toBe(0.49);
    expect(stepped(wide, 0.34, -1, true)).toBe(1 / 3);
  });

  it("goes on past a third a hundredth at a time, as the note writes each one back", () => {
    const shares = [0.35];
    for (let i = 0; i < 4; i++) shares.push(shareIn(withShare(ID, stepped(wide, shares.at(-1)!, -1, true))));
    expect(shares).toEqual([0.35, 0.34, 1 / 3, 0.32, 0.31]);
    const up = [0.31];
    for (let i = 0; i < 4; i++) up.push(shareIn(withShare(ID, stepped(wide, up.at(-1)!, 1, true))));
    expect(up).toEqual([0.31, 0.32, 1 / 3, 0.34, 0.35]);
  });

  it("steps a picture written with no size within the room kept for one, 480 pixels", () => {
    const unsized = reachOf(600, 480);
    expect(stepped(unsized, 1, -1)).toBe(0.75);
    expect(stepped(unsized, 0.75, 1)).toBe(1);
  });

  it("goes no wider than the picture, where it is the whole column", () => {
    const narrow = reachOf(600, 320);
    expect(stepped(narrow, 0.5, 1)).toBe(1);
    expect(stepped(narrow, 1, -1)).toBe(0.5);
    expect(stepped(narrow, 0.6, -1)).toBe(0.5);
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

  it("refuses a file over 25 GB and an empty one before any of it is sent", () => {
    expect(refusal({ name: "film.mov", size: 50 * 1024 * 1024 })).toBeNull();
    expect(refusal({ name: "film.mov", size: 25 * 1024 ** 3 + 1 })).toBe("film.mov is 25 GB. A file can be at most 25 GB.");
    expect(refusal({ name: "film.mov", size: 300 * 1024 ** 3 })).toBe("film.mov is 300 GB. A file can be at most 25 GB.");
    expect(refusal({ name: "episode.wav", size: 3 * 1024 ** 3 })).toBeNull();
    expect(refusal({ name: "nothing.txt", size: 0 })).toBe("nothing.txt is empty, so there is nothing to upload.");
  });
});

describe("where an uploaded file is written", () => {
  const written = `/image(${ID} 4x3)`;

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
    expect(writtenFor({ id: ID, kind: "image", width: 640, height: 480 }, { width: 1, height: 1 })).toBe(`/image(${ID} 640x480)`);
    expect(writtenFor({ id: ID, kind: "image", width: null, height: null }, { width: 120, height: 80 })).toBe(`/image(${ID} 120x80)`);
    expect(writtenFor({ id: ID, kind: "image", width: null, height: null })).toBe(`/image(${ID})`);
  });

  it("writes a video with the size the browser measured or a default, and a recording and a file with none", () => {
    expect(writtenFor({ id: ID, kind: "video", width: null, height: null }, { width: 1920, height: 1080 })).toBe(`/video(${ID} 1920x1080)`);
    expect(writtenFor({ id: ID, kind: "video", width: null, height: null })).toBe(`/video(${ID} 640x360)`);
    expect(writtenFor({ id: ID, kind: "audio", width: null, height: null }, { width: 9, height: 9 })).toBe(`/audio(${ID})`);
    expect(writtenFor({ id: ID, kind: "file", width: null, height: null })).toBe(`/file(${ID})`);
  });
});

describe("finding an upload", () => {
  const uploads = [
    { id: "aaaaaaaaaaaa", name: "Harbour.PNG", kind: "image", state: "live" },
    { id: "bbbbbbbbbbbb", name: "minutes.txt", kind: "file", state: "live" },
    { id: "cccccccccccc", name: "harbour-walk.mp4", kind: "video", state: "archived" },
    { id: "dddddddddddd", name: "old-harbour.png", kind: "image", state: "trashed" },
  ] as const;

  const ada = { kind: "member", personId: "ada", name: "Ada Lovelace" } as const;
  const bob = { kind: "member", personId: "bob", name: "Bob Babbage" } as const;
  const scribe = { kind: "agent", agentId: "ada", name: "Scribe", onBehalfOf: "ada" } as const;

  it("says who uploaded a file: You for the member, and anyone else by name, an agent of theirs too", () => {
    expect(uploaderWords({ uploadedBy: ada }, "ada")).toBe("You");
    expect(uploaderWords({ uploadedBy: bob }, "ada")).toBe("Bob Babbage");
    expect(uploaderWords({ uploadedBy: scribe }, "ada")).toBe("Scribe");
  });

  it("says how far a file is seen in plain words, from the notes the member can see", () => {
    expect(reachWords({ uploadedBy: ada, private: true, uses: 0 }, "ada")).toBe("Only you");
    expect(reachWords({ uploadedBy: ada, private: true, uses: 2 }, "ada")).toBe("Only you");
    expect(reachWords({ uploadedBy: ada, private: false, uses: 1 }, "ada")).toBe("In 1 note");
    expect(reachWords({ uploadedBy: bob, private: false, uses: 3 }, "ada")).toBe("In 3 notes");
    expect(reachWords({ uploadedBy: bob, private: false, uses: 0 }, "ada")).toBe("Not in a note");
    expect(reachWords({ uploadedBy: bob, private: true, uses: 0 }, "ada")).toBe("Not in a note");
  });

  it("chooses Mine by writing uploader:@me into the query, and Everyone's by taking it out", () => {
    expect(onlyMine("")).toBe(false);
    expect(onlyMine("uploader:@me")).toBe(true);
    expect(onlyMine("type:image uploaded-by:@ME")).toBe(true);
    expect(onlyMine("-uploader:@me")).toBe(false);
    expect(onlyMine("uploader:@me OR type:image")).toBe(false);
    expect(withMine("", true)).toBe(MINE);
    expect(withMine("type:image ", true)).toBe("type:image uploader:@me");
    expect(withMine("type:image uploader:@me", true)).toBe("type:image uploader:@me");
    expect(withMine("type:image uploader:@me used:no", false)).toBe("type:image used:no");
    expect(withMine("uploader:@me", false)).toBe("");
    expect(withMine("report", false)).toBe("report");
    expect(withMine("(type:pdf OR type:text) uploaded-by:@me", false)).toBe("(type:pdf OR type:text)");
    // Mine after an OR keeps to the member's own on both sides, and is read back as Mine.
    expect(withMine("type:image OR type:text", true)).toBe("(type:image OR type:text) uploader:@me");
    expect(onlyMine(withMine("type:image OR type:text", true))).toBe(true);
    expect(withMine(withMine("type:image OR type:text", true), false)).toBe("(type:image OR type:text)");
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
