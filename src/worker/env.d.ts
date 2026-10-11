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
  /** A host given to HTML embeds alone, such as https://embed.commonink.app. Without one the app's own host serves their document. */
  EMBED_ORIGIN?: string;
}

interface Env extends InkSettings {}

declare namespace Cloudflare {
  interface Env extends InkSettings {}
}
