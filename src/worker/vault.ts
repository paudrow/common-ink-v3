import { b64url, fromB64url } from "./session.ts";

/*
 * What is kept of a person's tokens is sealed here before it reaches the database, with a key the
 * database never holds: AES-256-GCM, a fresh 96-bit nonce for every value, under a key derived from
 * the TOKEN_KEY secret. A sealed value is bound to the row and column it was sealed for, so one
 * copied into another person's row opens as nothing. A value sealed under another key, or changed
 * in any way, opens as null: whoever reads it treats that as no token.
 */

export interface Vault {
  seal(plain: string, boundTo: string): Promise<string>;
  open(sealed: string | null, boundTo: string): Promise<string | null>;
}

const VERSION = "v1";
const INFO = "common-ink data source tokens v1";
const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let made = keys.get(secret);
  if (!made) {
    made = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(INFO) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    keys.set(secret, made);
  }
  return made;
}

/** A secret short enough to guess protects nothing, so it is taken for no secret at all. */
export const MIN_TOKEN_KEY = 32;

/** The vault under a secret, or null without one: then no token is kept at all. */
export function vault(secret: string | undefined): Vault | null {
  if (!secret || secret.length < MIN_TOKEN_KEY) return null;
  return {
    async seal(plain, boundTo) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(boundTo) }, await key(secret), encoder.encode(plain));
      return `${VERSION}.${b64url(nonce)}.${b64url(new Uint8Array(sealed))}`;
    },
    async open(sealed, boundTo) {
      const [version, nonce, body] = (sealed ?? "").split(".");
      if (version !== VERSION || !nonce || !body) return null;
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(nonce), additionalData: encoder.encode(boundTo) }, await key(secret), fromB64url(body));
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
  };
}
