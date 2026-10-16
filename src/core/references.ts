import { linesOutsideCode } from "./lines.ts";
import type { SourceRecord } from "./protocol.ts";

const WRITTEN = /::(event|contact)\{([^{}\n]*)\}/g;
const REFERRED = /^[a-z0-9]{12}(?: .*)?$/;

/** The references a text holds outside code and inline code, by the ref each is written with, as `::event{k3j5h8d9f0a1 Lunch}` holds `k3j5h8d9f0a1`. */
export function referencesIn(text: string): { kind: SourceRecord["kind"]; ref: string }[] {
  const found = [];
  for (const { line } of linesOutsideCode(text)) {
    if (!line.includes("::")) continue;
    for (const written of line.matchAll(WRITTEN)) {
      const inCode = (line.slice(0, written.index).match(/`/g) ?? []).length % 2 === 1;
      const inside = written[2]!.trim();
      if (!inCode && REFERRED.test(inside)) found.push({ kind: written[1] as SourceRecord["kind"], ref: inside.slice(0, 12) });
    }
  }
  return found;
}

/**
 * Where a text names a record by what it is called and holds no reference to it, as
 * `::event{Lunch with Sam}` does, outside code. scripts/try-note.ts writes each as the reference of
 * the sample record of that name.
 */
export function namedReferences(text: string): { kind: SourceRecord["kind"]; name: string; from: number; to: number }[] {
  const named = [];
  for (const { line, from } of linesOutsideCode(text)) {
    for (const found of line.matchAll(WRITTEN)) {
      const name = found[2]!.trim();
      const inCode = (line.slice(0, found.index).match(/`/g) ?? []).length % 2 === 1;
      if (!name || inCode || REFERRED.test(name)) continue;
      named.push({ kind: found[1] as SourceRecord["kind"], name, from: from + found.index, to: from + found.index + found[0].length });
    }
  }
  return named;
}
