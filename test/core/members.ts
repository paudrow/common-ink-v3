import { env } from "cloudflare:test";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import type { Actor } from "../../src/core/operations.ts";
import type { Role } from "../../src/core/protocol.ts";

/** A new person, acting in the workspace they got on first sign-in, where they are admin. */
export async function newMember(name = "Ada Lovelace"): Promise<Actor> {
  const email = `${crypto.randomUUID()}@example.com`;
  const { personId } = await signIn(env.DB, { email, name });
  const [workspace] = (await whoAmI(env.DB, personId)).workspaces;
  return { kind: "member", personId, workspaceId: workspace!.id };
}

/** A new person with `role` in `admin`'s workspace. */
export async function addMember(admin: Actor, role: Role, name = "Grace Hopper"): Promise<Actor> {
  const { personId } = await newMember(name);
  await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, ?)").bind(admin.workspaceId, personId, role).run();
  return { kind: "member", personId, workspaceId: admin.workspaceId };
}
