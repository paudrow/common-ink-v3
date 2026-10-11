interface InkSettings {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Emails allowed to sign in with Google, separated by commas or spaces. */
  ALLOWED_EMAILS?: string;
  /** "1" on this machine and in Previews: /auth/dev signs in without Google. */
  DEV_SIGN_IN?: string;
}

interface Env extends InkSettings {}

declare namespace Cloudflare {
  interface Env extends InkSettings {}
}
