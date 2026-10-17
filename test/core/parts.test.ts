import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, PART_BYTES, partSpan, partsLeft, planParts } from "../../src/core/parts.ts";

const MIB = 1024 * 1024;

describe("cutting a file into parts", () => {
  it("keeps every part under the 100 MB a request to the Worker can carry, and at least the 5 MiB the bucket wants of all but the last", () => {
    expect(PART_BYTES).toBe(80 * MIB);
    expect(PART_BYTES).toBeLessThan(100_000_000);
    expect(PART_BYTES).toBeGreaterThanOrEqual(5 * MIB);
  });

  it("cuts a file into parts of the same size but the last, which is what is left", () => {
    expect(planParts(1)).toEqual({ size: 1, partSize: PART_BYTES, count: 1 });
    expect(planParts(PART_BYTES)).toEqual({ size: PART_BYTES, partSize: PART_BYTES, count: 1 });
    expect(planParts(PART_BYTES + 1)).toEqual({ size: PART_BYTES + 1, partSize: PART_BYTES, count: 2 });
    expect(planParts(105 * MIB).count).toBe(2);
    expect(planParts(MAX_UPLOAD_BYTES)).toEqual({ size: 25 * 1024 * MIB, partSize: PART_BYTES, count: 320 });
  });

  it("says where each part is, and that a number past the last is none", () => {
    const plan = planParts(2 * PART_BYTES + 10);
    expect([1, 2, 3].map((n) => partSpan(plan, n))).toEqual([
      { offset: 0, length: PART_BYTES },
      { offset: PART_BYTES, length: PART_BYTES },
      { offset: 2 * PART_BYTES, length: 10 },
    ]);
    expect([0, 4, 1.5, -1].map((n) => partSpan(plan, n))).toEqual([null, null, null, null]);
    expect(partSpan(planParts(7), 1)).toEqual({ offset: 0, length: 7 });
  });

  it("covers the file exactly once, whatever its size", () => {
    for (const size of [1, 5, PART_BYTES - 1, PART_BYTES, PART_BYTES + 1, 3 * PART_BYTES + 12345, MAX_UPLOAD_BYTES]) {
      const plan = planParts(size);
      let at = 0;
      for (let n = 1; n <= plan.count; n++) {
        const span = partSpan(plan, n)!;
        expect(span.offset, `${size}, part ${n}`).toBe(at);
        expect(span.length).toBeGreaterThan(0);
        at += span.length;
      }
      expect(at, String(size)).toBe(size);
    }
  });

  it("lists the parts still to send, in order", () => {
    const plan = planParts(4 * PART_BYTES);
    expect(partsLeft(plan, [])).toEqual([1, 2, 3, 4]);
    expect(partsLeft(plan, [3, 1])).toEqual([2, 4]);
    expect(partsLeft(plan, [1, 2, 3, 4, 9])).toEqual([]);
  });

  it("refuses a size that is no file", () => {
    for (const size of [0, -1, 1.5, Number.NaN]) expect(() => planParts(size), String(size)).toThrow(RangeError);
  });
});
