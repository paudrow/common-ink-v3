import { expect, test } from "@playwright/test";
import { me, signInAsNewPerson } from "./helpers.ts";

test.use({ timezoneId: "America/Chicago" });

test("the app records the time zone of the browser it is used in, which /api/me then says", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect.poll(async () => (await me(page)).timeZone).toBe("America/Chicago");
});
