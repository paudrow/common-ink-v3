interface InkSettings {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Seals what is kept of each person's Google tokens: at least 32 characters, such as `openssl rand -base64 32`.
   * Without it no token is kept, and Google Calendar and Contacts aren't offered as data sources.
   */
  TOKEN_KEY?: string;
  /** Emails allowed to sign in with Google, separated by commas or spaces. An invite to a workspace doesn't add to them. */
  ALLOWED_EMAILS?: string;
  /** "1" on this machine and in Previews: /auth/dev signs in without Google. */
  DEV_SIGN_IN?: string;
  /** "1" under Vite's dev server, whose page has an inline script of its own. */
  DEV_SERVER?: string;
  /** A host given to HTML embeds alone, such as https://embed.commonink.app. Without one the app's own host serves their document. */
  EMBED_ORIGIN?: string;
  /** A site kept for opening files in a tab, such as https://files.commonink.example. Without one a PDF is downloaded. */
  FILE_ORIGIN?: string;
  /** The Chrome extension ids the clipper may sign in from, separated by commas. Without one no clipper signs in. */
  CLIPPER_EXTENSION_IDS?: string;
  /** Where mail is sent to be kept in the Email data source. Without it, notes@commonink.app. */
  MAIL_ADDRESS?: string;
  /** Whose Authentication-Results header the Worker trusts on incoming mail. Without it, mx.cloudflare.net: Cloudflare Email Routing's. */
  MAIL_AUTHSERV?: string;
  /** A Sentry project's DSN. With it, every fault the Worker reports is also sent to Sentry; without it, faults go only to Workers Logs (src/worker/report.ts). */
  SENTRY_DSN?: string;
}

interface Env extends InkSettings {}

declare namespace Cloudflare {
  interface Env extends InkSettings {}
}
