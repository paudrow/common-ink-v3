import { callsIn, type Call } from "./embedSyntax.ts";
import { linesOutsideCode } from "./lines.ts";
import { linkedEvent, linksIn } from "./links.ts";
import type { SourceRecord } from "./protocol.ts";
import { blanked, codeSpans } from "./spans.ts";

const EMBEDDED: readonly string[] = ["email"] satisfies SourceRecord["kind"][];
const REFERRED = /^[a-z0-9]{12}(?: .*)?$/;
/** An event named by what it is called rather than by a reference, as `[[event:Lunch with Sam]]` names one. */
const NAMED_EVENT = /^event:(.+)$/;

/** Each embed of an email a text writes outside code and inline code, with where it is. */
function* writtenIn(text: string): Generator<Call & { kind: SourceRecord["kind"] }> {
  for (const { line, from } of linesOutsideCode(text)) {
    if (!line.includes("(")) continue;
    for (const call of callsIn(blanked(line, codeSpans(line), " "), from)) if (EMBEDDED.includes(call.name)) yield { ...call, kind: call.name as SourceRecord["kind"] };
  }
}

/**
 * The references a text holds outside code and inline code, by the ref each is written with: a link
 * to an event, `[[event:k3j5h8d9f0a1]]`, and an email's embed, `/email(k3j5h8d9f0a1 Invoice)`.
 */
export function referencesIn(text: string): { kind: SourceRecord["kind"]; ref: string }[] {
  const found: { kind: SourceRecord["kind"]; ref: string }[] = linksIn(text).flatMap((link) => {
    const ref = linkedEvent(link.target);
    return ref ? [{ kind: "event" as const, ref }] : [];
  });
  for (const { kind, config } of writtenIn(text)) {
    const inside = config.trim();
    if (REFERRED.test(inside)) found.push({ kind, ref: inside.slice(0, 12) });
  }
  return found;
}

/**
 * Where a text names a record by what it is called and holds no reference to it, as
 * `[[event:Lunch with Sam]]` and `/email(Invoice for October)` do, outside code, with a link's own words.
 * scripts/try-note.ts writes each as the reference of the sample record of that name.
 */
export function namedReferences(text: string): { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] {
  const named: { kind: SourceRecord["kind"]; name: string; display: string | null; from: number; to: number }[] = linksIn(text).flatMap(({ target, display, from, to }) => {
    const name = linkedEvent(target) === null ? NAMED_EVENT.exec(target)?.[1]?.trim() : undefined;
    return name ? [{ kind: "event" as const, name, display, from, to }] : [];
  });
  for (const { kind, config, from, to } of writtenIn(text)) {
    const name = config.trim();
    if (name && !REFERRED.test(name)) named.push({ kind, name, display: null, from, to });
  }
  return named.sort((a, b) => a.from - b.from);
}
