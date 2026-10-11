import type { Vault } from "../vault.ts";

/** A person's connection to a provider, as the database keeps it. The tokens are sealed. */
export interface Connection {
  personId: string;
  provider: string;
  account: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  /** The provider stopped taking the tokens, so the person has to agree again. */
  broken: boolean;
  /** The data sources the provider stopped answering for, though it still takes the tokens. */
  lapsed: string[];
}

interface Row {
  person_id: string;
  provider: string;
  account: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number;
  scopes: string;
  broken: number;
  lapsed: string;
}

export async function connectionOf(db: D1Database, personId: string, provider: string): Promise<Connection | null> {
  const row = await db.prepare("SELECT * FROM source_connections WHERE person_id = ? AND provider = ?").bind(personId, provider).first<Row>();
  return row && { personId: row.person_id, provider: row.provider, account: row.account, accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at, scopes: row.scopes.split(" ").filter(Boolean), broken: row.broken === 1, lapsed: row.lapsed.split(" ").filter(Boolean) };
}

/** What a sealed token is bound to: its person, its provider, and which of the two it is. */
const boundTo = (personId: string, provider: string, which: "access" | "refresh") => `${provider}:${personId}:${which}`;

export const openToken = (vault: Vault, connection: Connection, which: "access" | "refresh") =>
  vault.open(which === "access" ? connection.accessToken : connection.refreshToken, boundTo(connection.personId, connection.provider, which));

export interface Tokens {
  accessToken: string;
  /** Null keeps the refresh token already held. */
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

/**
 * Keeps what a provider handed over when the person agreed, sealed, in place of what was held. A
 * refresh token already held is kept when none came with these. Agreeing is what makes a connection
 * and what mends one, so this alone may create the row or clear `broken` and `lapsed`.
 */
export async function keepTokens(db: D1Database, vault: Vault, personId: string, provider: string, account: string, tokens: Tokens, now: number): Promise<void> {
  const access = await vault.seal(tokens.accessToken, boundTo(personId, provider, "access"));
  const refresh = tokens.refreshToken === null ? null : await vault.seal(tokens.refreshToken, boundTo(personId, provider, "refresh"));
  await db
    .prepare(
      `INSERT INTO source_connections (person_id, provider, account, access_token, refresh_token, expires_at, scopes, broken, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)
       ON CONFLICT (person_id, provider) DO UPDATE SET account = excluded.account, access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, source_connections.refresh_token),
         expires_at = excluded.expires_at, scopes = excluded.scopes, broken = 0, lapsed = '', updated_at = excluded.updated_at`,
    )
    .bind(personId, provider, account, access, refresh, tokens.expiresAt, tokens.scopes.join(" "), now)
    .run();
}

/**
 * Keeps a renewed access token on the connection it was renewed for, and on nothing else: the row
 * must still hold the very refresh token the renewal used. A connection that was ended while the
 * renewal was in flight, or ended and made again, is left as it is, and false says so. Renewing
 * changes neither what was agreed to nor whether a data source needs reconnecting.
 */
export async function keepRenewed(db: D1Database, vault: Vault, held: Connection, renewed: { accessToken: string; refreshToken: string | null; expiresAt: number }, now: number): Promise<boolean> {
  if (held.refreshToken === null) return false;
  const access = await vault.seal(renewed.accessToken, boundTo(held.personId, held.provider, "access"));
  const refresh = renewed.refreshToken === null ? null : await vault.seal(renewed.refreshToken, boundTo(held.personId, held.provider, "refresh"));
  const done = await db
    .prepare("UPDATE source_connections SET access_token = ?1, refresh_token = COALESCE(?2, refresh_token), expires_at = ?3, updated_at = ?4 WHERE person_id = ?5 AND provider = ?6 AND refresh_token = ?7 AND broken = 0")
    .bind(access, refresh, renewed.expiresAt, now, held.personId, held.provider, held.refreshToken)
    .run();
  return done.meta.changes > 0;
}

/** A connection with no tokens to keep, such as the sample data's. */
export const connectPlain = (db: D1Database, personId: string, provider: string, account: string, now: number) =>
  db.prepare("INSERT INTO source_connections (person_id, provider, account, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, provider) DO NOTHING").bind(personId, provider, account, now).run();

/** The provider stopped taking the tokens. They are thrown away at once: they are worth nothing, and nothing should hold them. */
export const markBroken = (db: D1Database, personId: string, provider: string, now: number) =>
  db.prepare("UPDATE source_connections SET broken = 1, access_token = NULL, refresh_token = NULL, expires_at = 0, updated_at = ? WHERE person_id = ? AND provider = ?").bind(now, personId, provider).run();

/** The provider takes the tokens and still refuses one data source: what was agreed to no longer covers it. */
export const markLapsed = (db: D1Database, personId: string, provider: string, sourceId: string, now: number) =>
  db
    .prepare("UPDATE source_connections SET lapsed = trim(lapsed || ' ' || ?1), updated_at = ?2 WHERE person_id = ?3 AND provider = ?4 AND instr(' ' || lapsed || ' ', ' ' || ?1 || ' ') = 0")
    .bind(sourceId, now, personId, provider)
    .run();

export const forget = (db: D1Database, personId: string, provider: string) => db.prepare("DELETE FROM source_connections WHERE person_id = ? AND provider = ?").bind(personId, provider).run();
