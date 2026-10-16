/**
 * How a file is cut into parts to be sent. A request to the Worker can carry at most 100 MB on the
 * Free and Pro plans, so a part is 80 MiB, and every part but the last is exactly that: the bucket
 * wants its parts the same size but the last, and at least 5 MiB. A file of 25 GB is 320 parts.
 */
const MIB = 1024 * 1024;
export const PART_BYTES = 80 * MIB;
/** The most bytes one upload may be. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * MIB;
/** The most parts the bucket takes for one file. A file of {@link MAX_UPLOAD_BYTES} is far below it. */
const MAX_PARTS = 10_000;

export interface Span {
  offset: number;
  length: number;
}

/** A file of `size` bytes, cut into `count` parts of `partSize` bytes, the last one shorter or the same. */
export interface PartPlan {
  size: number;
  partSize: number;
  count: number;
}

export function planParts(size: number, partSize = PART_BYTES): PartPlan {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`A file of ${size} bytes has no parts`);
  const count = Math.ceil(size / partSize);
  if (count > MAX_PARTS) throw new RangeError(`A file of ${size} bytes is more than ${MAX_PARTS} parts`);
  return { size, partSize, count };
}

/** Where part `number` (from 1) is in the file, or null for a number that is no part of it. */
export function partSpan(plan: PartPlan, number: number): Span | null {
  if (!Number.isInteger(number) || number < 1 || number > plan.count) return null;
  const offset = (number - 1) * plan.partSize;
  return { offset, length: Math.min(plan.partSize, plan.size - offset) };
}

/** The parts still to be sent, in order, when those numbered in `stored` are there. */
export function partsLeft(plan: PartPlan, stored: Iterable<number>): number[] {
  const there = new Set(stored);
  return Array.from({ length: plan.count }, (_, i) => i + 1).filter((number) => !there.has(number));
}
