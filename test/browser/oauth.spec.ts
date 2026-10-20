import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { newEmail, signInAs, test } from "./helpers.ts";

/*
 * A hosted chat app connecting by OAuth, as a fake client drives it: it registers and trades its code by
 * fetch, and sends the member's browser to /oauth/authorize. The app's own address is on this machine and
 * answered here, so the browser's arrival there, with the code or the error, is what the test reads. On
 * this machine a browser with no session is the dev user, so each test signs a new person in first.
 */

const REDIRECT = "http://127.0.0.1:9/cb";
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}

async function register(request: APIRequestContext, name: string) {
  const res = await request.post("/oauth/register", { data: { client_name: name, redirect_uris: [REDIRECT] } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/**
 * Signs a new person in and sends their browser on to /oauth/authorize, as an app does, and from there to
 * the consent page. Returns the address the browser arrives at in the app once they answer with `answer`.
 */
async function answerInBrowser(page: Page, clientId: string, challenge: string, answer: "Allow" | "Don't allow", appName: string) {
  await page.route((url) => url.href.startsWith(REDIRECT), (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "Back in the app" }));
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-123" });
  await signInAs(page, newEmail(), "Ada Lovelace", `/oauth/authorize?${query}`);
  await expect(page).toHaveURL(/\/connect\?request=/);
  await expect(page.getByRole("heading", { name: "An app at 127.0.0.1:9 wants to connect" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(`It calls itself “${appName}”, a name it chose and Common Ink has not checked.`);
  await expect(page.getByRole("main")).toContainText("sends you back to 127.0.0.1:9");
  await page.getByRole("button", { name: answer, exact: true }).click();
  await page.waitForURL((url) => url.href.startsWith(REDIRECT));
  return new URL(page.url());
}

const mcpStatus = async (request: APIRequestContext, token: string) =>
  (await request.post("/mcp", { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workspaces", arguments: {} } } })).status();

test("an app connects by OAuth: the member allows it, the app trades the code, and Agents lists it until it is disconnected", async ({ page, baseURL }) => {
  const appName = `Try app ${crypto.randomUUID().slice(0, 6)}`;
  const clientId = await register(page.request, appName);
  const { verifier, challenge } = await pkce();

  const back = await answerInBrowser(page, clientId, challenge, "Allow", appName);
  expect([back.searchParams.get("state"), back.searchParams.get("iss")]).toEqual(["s-123", baseURL]);
  const code = back.searchParams.get("code")!;
  expect(code).toMatch(/^cink_ac_/);

  const traded = await page.request.post("/oauth/token", { form: { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier } });
  expect(traded.status()).toBe(200);
  const tokens = (await traded.json()) as { access_token: string; refresh_token: string; expires_in: number };
  expect(tokens.expires_in).toBe(3600);
  expect(await mcpStatus(page.request, tokens.access_token)).toBe(200);

  await page.goto("/agents");
  const row = page.getByRole("list", { name: "Connected agents" }).getByRole("listitem", { name: appName });
  await expect(row).toContainText("OAuth");
  await expect(row).toContainText(`connected by OAuth from ${appName}, a name the app gave itself and nobody checked`);
  await expect(row.getByRole("button", { name: "Set up again" })).toHaveCount(0);
  await row.getByRole("button", { name: "Disconnect" }).click();
  const confirm = row.getByRole("group", { name: `Disconnect ${appName}` });
  await expect(confirm).toContainText(`${appName}'s tokens stop working at once.`);
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("list", { name: "Agents no longer connected" }).getByRole("listitem", { name: appName })).toContainText("disconnected");

  expect(await mcpStatus(page.request, tokens.access_token)).toBe(401);
  const refreshed = await page.request.post("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId } });
  expect(refreshed.status()).toBe(400);
});

test("a member who doesn't allow an app sends it back with access_denied, and nothing is connected", async ({ page }) => {
  const appName = `Refused app ${crypto.randomUUID().slice(0, 6)}`;
  const clientId = await register(page.request, appName);
  const back = await answerInBrowser(page, clientId, (await pkce()).challenge, "Don't allow", appName);
  expect([back.searchParams.get("error"), back.searchParams.get("state"), back.searchParams.get("code")]).toEqual(["access_denied", "s-123", null]);

  await page.goto("/agents");
  await expect(page.getByRole("region", { name: "Agents" })).toContainText("No agent is connected.");
  await expect(page.getByRole("listitem", { name: appName })).toHaveCount(0);
});
