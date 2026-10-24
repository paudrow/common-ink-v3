import { describe, expect, it } from "vitest";
import { underRecording } from "../../src/web/plugins/uploads/transcribing.ts";

const ID = "abcdefgh1234";

describe("where what was said in a recording is written", () => {
  it("is the end of the line that plays it, for a line of its own under it", () => {
    const text = `# Standup\n\n/audio(${ID})\nAfter\n`;
    expect(underRecording(text, ID)).toBe(text.indexOf("\nAfter"));
    expect(underRecording(`/audio(${ID})`, ID)).toBe(`/audio(${ID})`.length);
  });

  it("is under the line nearest where the button was pressed, when the note plays it twice", () => {
    const text = `/audio(${ID})\nmiddle\n/audio(${ID})\nend`;
    expect(underRecording(text, ID, 0)).toBe(text.indexOf("\nmiddle"));
    expect(underRecording(text, ID, text.length)).toBe(text.indexOf("\nend"));
  });

  it("is nowhere when the note no longer plays it, nor for another upload whose id starts the same", () => {
    expect(underRecording("# Gone\n", ID)).toBeNull();
    expect(underRecording(`/audio(${ID}x)\n/image(${ID})\n`, ID)).toBeNull();
  });
});
