import { linesOutsideCode } from "./lines.ts";
import { linkedEvent, linksIn } from "./links.ts";
import type { SourceRecord } from "./protocol.ts";

const WRITTEN = /::(contact|email)\{([^{}\n]*)\}/g;
const REFERRED = /^[a-z0-9]{12}(?: .*)?$/;
/** An event named by what it is called rather than by a reference, as `[[event:Lunch with Sam]]` names one. */
const NAMED_EVENT = /^event:(.+)$/;

/**
 * The references a text holds outside code and inline code, by the ref each is written with: a link
 * to an event, `[[event:k3j5h8d9f0a1]]`, and a contact's or an email's embed, `::contact{k3j5h8d9f0a1 Ada}`.
 */
export function referencesIn(text: string): { kind: SourceRecord["kind"]; ref: string }[] {
  const found: { kind: SourceRecord["kind"]; ref: string }[] = linksIn(text).flatMap((link) => {
    const ref = linkedEvent(link.target);
    return ref ? [{ kind: "event" as const, ref }] : [];
  });
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
 * `[[event:Lunch with Sam]]` and `::contact{Sam Okafor}` do, outside code, with a link's own words.
 * scripts/try-note.ts writes each as the reference of the sample record of that name.
 */
export function namedReferences(text: string): { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] {
  const named: { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] = linksIn(text).flatMap(({ target, display, from, to }) => {
    const name = linkedEvent(target) === null ? NAMED_EVENT.exec(target)?.[1]?.trim() : undefined;
    return name ? [{ kind: "event" as const, name, display, from, to }] : [];
  });
  for (const { line, from } of linesOutsideCode(text)) {
    for (const found of line.matchAll(WRITTEN)) {
      const name = found[2]!.trim();
      const inCode = (line.slice(0, found.index).match(/`/g) ?? []).length % 2 === 1;
      if (!name || inCode || REFERRED.test(name)) continue;
      named.push({ kind: found[1] as SourceRecord["kind"], name, display: null, from: from + found.index, to: from + found.index + found[0].length });
    }
  }
  return named.sort((a, b) => a.from - b.from);
}
