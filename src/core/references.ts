import { linesOutsideCode } from "./lines.ts";
import { linkedEmail, linkedEvent, linksIn } from "./links.ts";
import type { SourceRecord } from "./protocol.ts";

const WRITTEN = /::(contact|email)\{([^{}\n]*)\}/g;
const REFERRED = /^[a-z0-9]{12}(?: .*)?$/;
/** An event or a thread named by what it is called rather than by a reference, as `[[event:Lunch with Sam]]` names one. */
const NAMED_LINK = /^(event|email):(.+)$/;

/**
 * The references a text holds outside code and inline code, by the ref each is written with: a link
 * to an event or an email, `[[event:k3j5h8d9f0a1]]`, and a contact's embed, `::contact{k3j5h8d9f0a1 Ada}`.
 */
export function referencesIn(text: string): { kind: SourceRecord["kind"]; ref: string }[] {
  const found = linksIn(text).flatMap((link): { kind: SourceRecord["kind"]; ref: string }[] => {
    const event = linkedEvent(link.target);
    const email = linkedEmail(link.target);
    return event ? [{ kind: "event", ref: event }] : email ? [{ kind: "email", ref: email }] : [];
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
 * `[[event:Lunch with Sam]]`, `[[email:Engine plans]]` and `::contact{Sam Okafor}` do, outside code,
 * with a link's own words.
 * scripts/try-note.ts writes each as the reference of the sample record of that name.
 */
export function namedReferences(text: string): { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] {
  const named = linksIn(text).flatMap(({ target, display, from, to }): { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] => {
    const [, kind, name] = linkedEvent(target) === null && linkedEmail(target) === null ? (NAMED_LINK.exec(target) ?? []) : [];
    return kind && name?.trim() ? [{ kind: kind as "event" | "email", name: name.trim(), display, from, to }] : [];
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
