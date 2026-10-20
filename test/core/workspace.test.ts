import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn, whoAmI } from "../../src/core/accounts.ts";

describe("signing in", () => {
  it("creates a workspace on first sign-in, where the person is admin and its owner", async () => {
    const { personId } = await signIn(env.DB, { email: "ada@example.com", name: "Ada Lovelace" });

    const me = await whoAmI(env.DB, personId);

    expect(me.person).toEqual({ id: personId, email: "ada@example.com", name: "Ada Lovelace" });
    expect(me.workspaces).toEqual([{ id: expect.any(String), name: "Ada's workspace", role: "admin", owned: true }]);
  });

  it("returns to the same workspace on later sign-ins", async () => {
    const first = await signIn(env.DB, { email: "grace@example.com", name: "Grace Hopper" });
    const before = await whoAmI(env.DB, first.personId);

    const second = await signIn(env.DB, { email: "Grace@Example.com", name: "Grace Hopper" });
    const after = await whoAmI(env.DB, second.personId);

    expect(second.personId).toBe(first.personId);
    expect(after.workspaces).toEqual(before.workspaces);
    expect(after.workspaces).toHaveLength(1);
  });

  it("creates one workspace when first sign-ins race", async () => {
    const [a, b] = await Promise.all([
      signIn(env.DB, { email: "mary@example.com", name: "Mary Jackson" }),
      signIn(env.DB, { email: "mary@example.com", name: "Mary Jackson" }),
    ]);

    expect(b.personId).toBe(a.personId);
    expect((await whoAmI(env.DB, a.personId)).workspaces).toHaveLength(1);
  });
});
