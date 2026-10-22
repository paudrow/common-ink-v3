import { describe, expect, it } from "vitest";
import { kindOf, typeOf } from "../../src/core/filetypes.ts";
import { clockOf, recordedType, recordingName, refusedBecause } from "../../src/web/plugins/uploads/recorded.ts";

const EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

describe("a recording made in a note", () => {
  it("is recorded in the first type the browser records, named by the ending the server reads a recording from", () => {
    expect(recordedType(() => true)).toEqual({ type: "audio/webm;codecs=opus", ending: "weba" });
    expect(recordedType((type) => type === "audio/mp4")).toEqual({ type: "audio/mp4", ending: "m4a" });
    expect(recordedType((type) => type.startsWith("audio/ogg"))).toEqual({ type: "audio/ogg;codecs=opus", ending: "ogg" });
    expect(recordedType(() => false)).toBeNull();
  });

  it("is a recording on the server as .weba, where the same bytes as .webm are a video", () => {
    expect(typeOf("Recording 2026-10-22 at 09.41.weba", EBML)).toBe("audio/webm");
    expect(kindOf("audio/webm")).toBe("audio");
    expect(kindOf(typeOf("clip.webm", EBML))).toBe("video");
    expect(typeOf("fake.weba", new TextEncoder().encode("not webm"))).toBe("application/octet-stream");
  });

  it("says how long it has run as a clock does", () => {
    expect([0, 999, 7_000, 59_999, 60_000, 90_500, 600_000, -5].map(clockOf)).toEqual(["0:00", "0:00", "0:07", "0:59", "1:00", "1:30", "10:00", "0:00"]);
  });

  it("is named for when it was begun", () => {
    expect(recordingName(new Date(2026, 9, 2, 9, 4), "weba")).toBe("Recording 2026-10-02 at 09.04.weba");
  });

  it("says why the microphone couldn't be had, by what the browser threw", () => {
    expect(refusedBecause(new DOMException("denied", "NotAllowedError"))).toBe("Common Ink isn't allowed to use your microphone. Allow it in your browser's settings for this site, then try again.");
    expect(refusedBecause(new DOMException("none", "NotFoundError"))).toBe("No microphone was found. Connect one, then try again.");
    expect(refusedBecause(new DOMException("busy", "NotReadableError"))).toBe("Your microphone is busy in another app. Close it there, then try again.");
    expect(refusedBecause("odd")).toBe("Your microphone couldn't be started.");
  });
});
