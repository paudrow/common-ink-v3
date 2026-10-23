/**
 * Why Chrome's sign-in window ended without a token, said so the member can act on it. Chrome tells a
 * closed window apart, but says only that the page "could not be loaded" both when the host is down and
 * when Common Ink refuses this extension with a 400, and then shows no window at all. So the sign-in
 * page at `connect` is asked again, without cookies, so the check signs no one in, and for no longer
 * than the clipper waits on Common Ink elsewhere.
 */
export async function whySignInFailed(err: unknown, connect: string, extensionId: string): Promise<string> {
  const said = err instanceof Error ? err.message : String(err);
  if (/did not approve/i.test(said)) return "You closed the sign-in window before allowing the clipper.";
  if (!/could not be loaded/i.test(said)) return `Sign-in failed. Chrome said: ${said}`;
  const host = new URL(connect).host;
  let page: Response;
  try {
    page = await fetch(connect, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(5_000) });
  } catch {
    return `Common Ink at ${host} didn't answer. Check the host and that it is running.`;
  }
  if (page.status === 400) return `This clipper (ID ${extensionId}) isn't allowed to sign in to ${host}. Its CLIPPER_EXTENSION_IDS setting has to name that ID.`;
  if (page.ok || page.type === "opaqueredirect") return `Sign-in failed. Chrome said: ${said}`;
  return `Common Ink at ${host} answered ${page.status}. Chrome said: ${said}`;
}
