// Where a request belongs before anything else runs. www.commonink.app redirects to commonink.app
// (permanently), since Google sign-in returns only to addresses registered with it. Other hosts,
// including v3.commonink.app and the workers.dev Previews, answer for themselves.

const PRODUCTION_APEX = "commonink.app";

/** The names of the machine the app runs on, as a URL's hostname reads them: dev sign-in takes a request for one as this machine's. */
export const THIS_MACHINE = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Where to send a request instead, or null to answer it here. Path and query are kept. */
export function redirectFor(url: URL): { location: string; status: 301 } | null {
  if (url.hostname !== `www.${PRODUCTION_APEX}`) return null;
  const apex = new URL(url);
  apex.hostname = PRODUCTION_APEX;
  apex.port = "";
  return { location: apex.toString(), status: 301 };
}
