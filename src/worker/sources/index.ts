import type { DataSource, Sources } from "../../core/sources.ts";
import { devSignIn } from "../auth.ts";
import { vault } from "../vault.ts";
import { google } from "./google.ts";
import { sample } from "./sample.ts";

/** Where some data sources come from: an account a person connects, which they are all agreed to through. */
export interface Provider {
  owns(sourceId: string): boolean;
  of(personId: string): Promise<DataSource[]>;
  connect(personId: string, sourceId: string, back: string, edit?: boolean): Promise<{ redirect: string | null }>;
  disconnect(personId: string): Promise<void>;
}

/**
 * The data sources this Common Ink offers, for a request to `url`. Google's need a Google client and
 * TOKEN_KEY: with no key to seal a token with, none is kept, so there is nothing to offer. The
 * sample data is offered only where dev sign-in is on, by the same check that guards dev sign-in.
 */
export function sourcesFor(env: Env, url: URL, outbound: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now): Sources {
  const sealed = vault(env.TOKEN_KEY);
  const providers: Provider[] = [
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && sealed ? [google({ db: env.DB, config: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, vault: sealed, outbound, now })] : []),
    ...(devSignIn(env, url) ? [sample(env.DB, now)] : []),
  ];
  const owner = (sourceId: string) => providers.find((p) => p.owns(sourceId));
  return {
    of: async (personId) => (await Promise.all(providers.map((p) => p.of(personId)))).flat(),
    connect: async (personId, sourceId, back, edit) => (await owner(sourceId)?.connect(personId, sourceId, back, edit)) ?? { redirect: null },
    disconnect: async (personId, sourceId) => owner(sourceId)?.disconnect(personId),
  };
}
