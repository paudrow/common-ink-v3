// What may be written to the Worker's logs. Anyone who can read them is not thereby let into anyone's
// notes, so a line keeps out every secret and every word a person wrote: tokens, cookies, emails, the
// address of a link, and whatever an error quotes of its input, which is where note text would be.

const RULES: readonly [RegExp, string][] = [
  [/\bBearer\s+\S+/gi, "Bearer …"],
  [/\bcink_[A-Za-z0-9_-]+/g, "cink_…"],
  // A session, a sign-in state and an ID token are each JSON in base64url, a dot, and more.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*/g, "eyJ…"],
  [/\bya29\.[A-Za-z0-9_.-]+/g, "ya29.…"],
  [/\b1\/\/[A-Za-z0-9_-]{20,}/g, "1//…"],
  // A code Google's sign-in hands back, to be traded for tokens.
  [/\b4\/0[A-Za-z0-9_-]{20,}/g, "4/0…"],
  [/(__Host-ink_\w+)=[^;\s]*/g, "$1=…"],
  [/\/(s|api\/shared)\/[A-Za-z0-9_-]{20,64}/g, "/$1/…"],
  // The address a part of an upload is sent to is a key to that upload for an hour: 256 random bits in base64url, 43 characters. The part's number after it stays.
  [/\/(api\/upload-parts)\/[A-Za-z0-9_-]{20,}/g, "/$1/…"],
  // A domain has letters at its end, so a package in a stack, foo@1.2.3/index.js, is kept.
  [/[^\s@"'`<>()/:?=&]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "…@…"],
  // A quotation, not an apostrophe: the mark is neither after nor before a letter. It may run over lines, as text quoted from a note does.
  [/(?<![\p{L}\p{N}])(["'`“«])[\s\S]*?(\1|”|»)(?![\p{L}\p{N}])/gu, "$1…$2"],
];

/** `text` with every secret and every quotation in it replaced by an ellipsis. */
export const redact = (text: string): string => RULES.reduce((out, [rule, to]) => out.replace(rule, to), text);

/** Logs a fault no request caused, redacted: what broke, the error's name, its message and its stack. */
export function logFault(what: string, err: unknown): void {
  const told = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(redact(`${what} broke: ${told}`));
}

/** Logs a line, redacted. */
export const logLine = (line: string): void => console.error(redact(line));
