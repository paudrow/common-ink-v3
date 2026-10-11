import { env } from "cloudflare:test";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { Role } from "../../src/core/protocol.ts";

/** A new person, acting in the workspace they got on first sign-in, where they are admin. */
export async function newMember(name = "Ada Lovelace"): Promise<Actor> {
  const email = `${crypto.randomUUID()}@example.com`;
  const { personId } = await signIn(env.DB, { email, name });
  const [workspace] = (await whoAmI(env.DB, personId)).workspaces;
  return { kind: "member", personId, workspaceId: workspace!.id };
}

/** A new person with `role` in `admin`'s workspace, who got there the way anyone does: invited, then signing in. */
export async function addMember(admin: Actor, role: Role, name = "Grace Hopper"): Promise<Actor> {
  const email = `${crypto.randomUUID()}@example.com`;
  await perform(env.DB, admin, { type: "member.invite", email, as: role });
  const { personId } = await signIn(env.DB, { email, name });
  return { kind: "member", personId, workspaceId: admin.workspaceId };
}
