import { describe, expect, it } from "vitest";
import { clearKey, EMBED_SCHEMAS, isDuration, keysText, placeProblems, problemText, readConfig, removeWord, renameKey, schemaFor, setKey, settableKeys, type EmbedSchema } from "../../src/core/embedSchema.ts";
import { withCrop, withShare, withUpload, writtenUpload } from "../../src/core/uploadRefs.ts";
import { inlineIn } from "../../src/core/embedSyntax.ts";
import { writeClock } from "../../src/web/plugins/lib/clock.ts";
import { durationParts, durationWords } from "../../src/core/embedOptions.ts";

const schema = (name: string): EmbedSchema => EMBED_SCHEMAS[name]!;
const [IMAGE, TIMER, HTML, CONTACT, DRAWING, KANBAN] = [schema("image"), schema("timer"), schema("html"), schema("contact"), schema("drawing"), schema("kanban")];
const ID = "u2p9l4d8a3c7";
const problems = (schema: EmbedSchema, config: string) => readConfig(schema, config).problems.map((p) => problemText(schema, p));

describe("reading an embed's config against its schema", () => {
  it("gives each key its words: bare words in schema order, an optional key passed over by a word it refuses", () => {
    expect(readConfig(IMAGE, `${ID} 640x480 42% crop=1,2,3,4`)).toEqual({ values: { upload: ID, size: "640x480", width: "42%", crop: "1,2,3,4" }, written: new Set(["upload", "size", "width", "crop"]), problems: [] });
    expect(readConfig(IMAGE, `${ID} medium`).values).toEqual({ upload: ID, width: "medium" });
    expect(readConfig(DRAWING, "").problems).toEqual([]);
    expect(readConfig(DRAWING, "800x450").values).toEqual({ size: "800x450" });
    expect(readConfig(CONTACT, "aaaaaaaaaaaa Lunch at noon=ish").values).toEqual({ ref: "aaaaaaaaaaaa", label: "Lunch at noon=ish" });
  });

  it("says which key is wrong and how", () => {
    expect(problems(HTML, "heigth=400")).toEqual(["Unknown key heigth. Did you mean height?"]);
    expect(problems(HTML, "hei=400")).toEqual(["Unknown key hei. Did you mean height?"]);
    expect(problems(HTML, "colour=red")).toEqual(["Unknown key colour."]);
    expect(problems(HTML, "height=5000")).toEqual(["Height: A whole number from 40 to 2000."]);
    expect(problems(TIMER, "")).toEqual(["Length is needed. Write it like 25m, 1h30m or 90s."]);
    expect(problems(TIMER, "5")).toEqual(["Length: Write it like 25m, 1h30m or 90s."]);
    expect(problems(TIMER, "5m colour=red")).toEqual(["Unknown key colour."]);
    expect(problems(TIMER, "5m foo")).toEqual(['"foo" isn\'t anything this embed takes.']);
    expect(problems(IMAGE, "abc")).toEqual(["Upload: An upload's id: 12 lowercase letters and digits."]);
    expect(problems(IMAGE, `${ID} 640x480 huge`)).toEqual(['"huge" isn\'t anything this embed takes.']);
    expect(problems(KANBAN, "x")).toEqual(['"x" isn\'t anything this embed takes.']);
  });

  it("says where a bare word must go for the embed's own reader to find it", () => {
    expect(problems(TIMER, "at=3s 5m")).toEqual(["Length: Write it before the key=value settings."]);
    expect(problems(IMAGE, `${ID} crop=1,2,3,4 640x480`)).toEqual(["Size: Write it before the key=value settings."]);
    expect(problems(IMAGE, `crop=1,2,3,4 ${ID} 640x480`)).toEqual(["Upload: Write it before the key=value settings.", "Size: Write it before the key=value settings."]);
    expect(problems(IMAGE, ` ${ID} 640x480 `)).toEqual(["Upload: Write it first, with no space before it."]);
    expect(problems(IMAGE, `${ID} 640x480 `)).toEqual([]);
  });

  it("says a bare key written as key=value is written as its value alone", () => {
    expect(problems(IMAGE, `${ID} size=640x480`)).toEqual(["size is written as its value alone, not as size=. The room kept for it, like 640x480."]);
  });

  it("leaves a declared schema's other words to the plugin", () => {
    const poll = schemaFor("x-poll", [{ type: "number", id: "votes", label: "Votes", default: 1, min: 1, max: 5, step: 1 }])!;
    expect(problems(poll, "size=big anything votes=2")).toEqual([]);
    expect(problems(poll, "votes=9")).toEqual(["Votes: A whole number from 1 to 5."]);
    expect(schemaFor("x-poll")).toBeUndefined();
    expect(schemaFor("html", [])).toBe(HTML);
  });
});

describe("setting and clearing an embed's keys", () => {
  it("replaces a bare key's word where it is, and keeps every other byte", () => {
    expect(setKey(IMAGE, `${ID}  640x480\tlarge`, "size", "800x600")).toEqual({ config: `${ID}  800x600\tlarge` });
    expect(setKey(TIMER, "5m at=3s", "length", "10m")).toEqual({ config: "10m at=3s" });
  });

  it("puts a bare key that isn't written after the bare words before it", () => {
    expect(setKey(IMAGE, `${ID} 640x480 crop=1,2,3,4`, "width", "medium")).toEqual({ config: `${ID} 640x480 medium crop=1,2,3,4` });
    expect(setKey(IMAGE, `${ID} crop=1,2,3,4`, "size", "640x480")).toEqual({ config: `${ID} 640x480 crop=1,2,3,4` });
    expect(setKey(DRAWING, "800x450", "upload", ID)).toEqual({ config: `${ID} 800x450` });
    expect(setKey(DRAWING, "", "width", "50%")).toEqual({ config: "50%" });
  });

  it("writes a bare key written out of its place where it belongs, before the key=value words, set to the same value or another", () => {
    const since = "since=2026-10-10T12:00:00.000Z";
    expect(setKey(TIMER, `${since} 5m`, "length", "6m")).toEqual({ config: `6m ${since}` });
    expect(setKey(TIMER, `${since} 5m`, "length", "5m")).toEqual({ config: `5m ${since}` });
    expect(setKey(IMAGE, `crop=1,2,3,4 ${ID}`, "upload", ID)).toEqual({ config: `${ID} crop=1,2,3,4` });
    expect(setKey(IMAGE, ` ${ID} 640x480`, "upload", ID)).toEqual({ config: `${ID} 640x480` });
  });

  it("writes a key=value key at the end, unquoted for a word key, and none for the default", () => {
    expect(setKey(IMAGE, `${ID} 640x480`, "crop", "1,2,3,4")).toEqual({ config: `${ID} 640x480 crop=1,2,3,4` });
    expect(setKey(HTML, "", "height", "480")).toEqual({ config: "height=480" });
    expect(setKey(HTML, "height=480", "height", "320")).toEqual({ config: "" });
  });

  it("sets and clears a contact's label, the words after its reference", () => {
    expect(setKey(CONTACT, "aaaaaaaaaaaa Lunch", "label", "Lunch at noon")).toEqual({ config: "aaaaaaaaaaaa Lunch at noon" });
    expect(setKey(CONTACT, "aaaaaaaaaaaa", "label", "Tea")).toEqual({ config: "aaaaaaaaaaaa Tea" });
    expect(clearKey(CONTACT, "aaaaaaaaaaaa Lunch at noon", "label")).toEqual({ config: "aaaaaaaaaaaa" });
  });

  it("refuses a value its key can't take, a key the schema doesn't have, and clearing a key the embed can't do without", () => {
    expect(setKey(IMAGE, ID, "size", "big")).toBe("The room kept for it, like 640x480.");
    expect(setKey(HTML, "", "height", "5")).toBe("A whole number from 40 to 2000.");
    expect(setKey(HTML, "", "width", "5")).toBe("No setting width.");
    expect(clearKey(IMAGE, `${ID} 640x480`, "upload")).toBe("Upload is needed.");
    expect(clearKey(TIMER, "5m", "length")).toBe("Length is needed.");
  });

  it("keeps an upload's id, which a drawing's saved scene is found by, from being cleared", () => {
    expect(clearKey(DRAWING, `${ID} 800x450`, "upload")).toBe("Upload can't be cleared.");
    expect(setKey(DRAWING, `${ID} 800x450`, "upload", "")).toBe("Upload can't be cleared.");
    expect(clearKey(DRAWING, `${ID} 800x450`, "size")).toEqual({ config: ID });
  });

  it("clears a key's words and the space before them, and leaves the rest as it was", () => {
    expect(clearKey(IMAGE, `${ID} 640x480 42% crop=1,2,3,4`, "width")).toEqual({ config: `${ID} 640x480 crop=1,2,3,4` });
    expect(clearKey(IMAGE, `${ID} 640x480 crop=1,2,3,4 crop=5,6,7,8`, "crop")).toEqual({ config: `${ID} 640x480` });
    expect(clearKey(TIMER, "5m since=2026-10-10T12:00:00.000Z", "since")).toEqual({ config: "5m" });
    expect(clearKey(HTML, "height=480", "height")).toEqual({ config: "" });
  });
});

describe("what each embed's own writer writes", () => {
  it("reads with no problems", () => {
    const written = [
      ["timer", writeClock({ length: "5m", run: { is: "idle" } })],
      ["timer", writeClock({ length: "1h30m", run: { is: "running", since: Date.parse("2026-10-10T12:00:00.000Z") } })],
      ["timer", writeClock({ length: "90s", run: { is: "stopped", elapsed: 3_723_000 } })],
      ["stopwatch", writeClock({ length: null, run: { is: "stopped", elapsed: 0 } })],
      ["stopwatch", writeClock({ length: null, run: { is: "running", since: 0 } })],
      ...(["image", "video", "audio", "file", "drawing"] as const).map((embed) => [embed, inlineIn(writtenUpload(embed, ID))[0]!.config]),
      ["image", inlineIn(writtenUpload("image", ID, { width: 640.4, height: 480 }))[0]!.config],
      ["image", withShare(`${ID} 640x480`, 0.42)],
      ["video", withShare(`${ID} 640x360`, 0.5)],
      ["image", withCrop(withShare(`${ID} 640x480`, 0.75), { x: 10, y: 20, width: 300, height: 200 })],
      ["drawing", withUpload("", ID, { width: 820, height: 460 })],
      ["drawing", withShare(withUpload("50%", ID, { width: 820, height: 460 }), 0.33)],
    ] as const;
    for (const [name, config] of written) expect(problems(schema(name), config), `${name}{${config}}`).toEqual([]);
  });

  it("is set again by the schema as it was", () => {
    const written = [
      [IMAGE, withCrop(withShare(`${ID} 640x480`, 0.5), { x: 1, y: 2, width: 3, height: 4 })],
      [TIMER, writeClock({ length: "1h30m", run: { is: "running", since: Date.parse("2026-10-10T12:00:00.000Z") } })],
      [TIMER, writeClock({ length: "90s", run: { is: "stopped", elapsed: 3_723_000 } })],
      [CONTACT, "aaaaaaaaaaaa Lunch at noon"],
      [HTML, "height=480"],
    ] as const;
    for (const [schema, config] of written) {
      const { values } = readConfig(schema, config);
      let again = "";
      for (const id of [...schema.keys.map((k) => k.id), ...(schema.rest ? [schema.rest.id] : [])]) {
        if (values[id] === undefined) continue;
        const next = setKey(schema, again, id, values[id]);
        if (typeof next === "string") throw new Error(next);
        again = next.config;
      }
      expect(again).toBe(config);
    }
  });

  it("tells an agent to leave out what a clock's own controls write", () => {
    expect(keysText(EMBED_SCHEMAS.timer!).split("\n").slice(2, 4)).toEqual([
      "- since=VALUE, written by its own controls: leave it out. An instant, like 2026-10-16T09:30:00.000Z.",
      "- at=VALUE, written by its own controls: leave it out. Write it like 25m, 1h30m or 90s.",
    ]);
  });
});

describe("the settings panel's keys", () => {
  const settable = (schema: EmbedSchema) => settableKeys(schema).map((key) => key.id);

  it("leave out what the app measures, as a picture's size, which the config still says and is still read", () => {
    expect(settable(IMAGE)).toEqual(["upload", "width", "crop"]);
    expect(settable(DRAWING)).toEqual(["upload", "width"]);
    expect(settable(TIMER)).toEqual(["length"]);
    expect(readConfig(IMAGE, `${ID} 640x480`).values.size).toBe("640x480");
    expect(problems(IMAGE, `${ID} 0x480`)).toEqual(['"0x480" isn\'t anything this embed takes.']);
    expect(keysText(IMAGE)).toContain("- size, written as its value alone. The room kept for it, like 640x480.");
  });

  it("set a timer's length as a duration, which reads back in hours, minutes and seconds as it was written", () => {
    expect(TIMER.keys.map(isDuration)).toEqual([true, false, false]);
    expect(HTML.keys.map(isDuration)).toEqual([false]);
    expect(durationParts("1h30m")).toEqual([1, 30, 0]);
    expect(durationParts("90s")).toEqual([0, 1, 30]);
    expect(durationParts("25")).toEqual([0, 25, 0]);
    // A timer reads a length of any number of hours, so the field shows them all.
    expect(durationParts("150h20m")).toEqual([150, 20, 0]);
    expect(durationParts("x")).toBeNull();
    for (const written of ["1h5m", "25m", "1h1m1s", "45s"]) {
      const [h, m, s] = durationParts(written)!;
      expect(durationWords((h * 60 + m) * 60 + s)).toBe(written);
    }
  });
});

describe("putting a problem right from the settings panel", () => {
  const placed = (schema: EmbedSchema, config: string) => placeProblems(schema, readConfig(schema, config));

  it("shows a bad value, a word out of place and a needed key under the key's field, and a stray word or a wrong key with no field as a row", () => {
    expect(placed(HTML, "height=5000")).toEqual({ byKey: { height: "A whole number from 40 to 2000." }, strays: [], rest: [] });
    expect(placed(TIMER, "")).toEqual({ byKey: { length: "Needed." }, strays: [], rest: [] });
    expect(placed(IMAGE, `${ID} crop=1,2,3,4 medium`).byKey).toEqual({ width: "Write it before the key=value settings." });
    expect(placed(IMAGE, ` ${ID}`).byKey).toEqual({ upload: "Write it first, with no space before it." });
    expect(placed(HTML, "heigth=200 colour=red")).toEqual({
      byKey: {},
      strays: [
        { word: "heigth=200", at: { from: 0, to: 10 }, text: "Unknown key heigth", rename: { from: "heigth", to: "height" } },
        { word: "colour=red", at: { from: 11, to: 21 }, text: "Unknown key colour" },
      ],
      rest: [],
    });
    expect(placed(TIMER, "5m foo").strays).toEqual([{ word: "foo", at: { from: 3, to: 6 }, text: 'Unknown word "foo"' }]);
    // What has no field, as a size the app measures or a word a clock's own controls write, is a row to remove.
    expect(placed(IMAGE, `${ID} crop=1,2,3,4 640x480`)).toEqual({ byKey: {}, strays: [{ word: "640x480", at: { from: 26, to: 33 }, text: "Size: Write it before the key=value settings." }], rest: [] });
    expect(placed(TIMER, "5m since=garbage")).toEqual({ byKey: {}, strays: [{ word: "since=garbage", at: { from: 3, to: 16 }, text: "Running since: An instant, like 2026-10-16T09:30:00.000Z." }], rest: [] });
  });

  it("removes the one word where it is, and the space before it, and keeps every other byte", () => {
    expect(removeWord("5m  colour=red\tfoo", "colour=red", { from: 4, to: 14 })).toBe("5m\tfoo");
    expect(removeWord("foo 5m", "foo", { from: 0, to: 3 })).toBe("5m");
    expect(removeWord("5m foo foo", "foo", { from: 7, to: 10 })).toBe("5m foo");
    // The second 5m is the extra one, and the first the timer's length.
    const extra = placed(TIMER, "5m foo=1 5m").strays.find((s) => s.word === "5m")!;
    expect(removeWord("5m foo=1 5m", extra.word, extra.at)).toBe("5m foo=1");
    // A config that changed under the panel is left as it is.
    expect(removeWord("6m", "5m", { from: 0, to: 2 })).toBe("6m");
  });

  it("renames a key=value word's key and keeps its value and every other byte", () => {
    expect(renameKey(HTML, "heigth=200", "heigth", "height")).toEqual({ config: "height=200" });
    expect(renameKey(IMAGE, `${ID}  640x480 crp="1,2,3,4"`, "crp", "crop")).toEqual({ config: `${ID}  640x480 crop="1,2,3,4"` });
    expect(renameKey(HTML, "heigth=200", "heigth", "width")).toBe("No setting width.");
    expect(renameKey(HTML, "height=200", "heigth", "height")).toBe("No key heigth is written.");
  });
});
