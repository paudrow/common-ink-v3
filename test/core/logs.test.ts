import { afterEach, describe, expect, it, vi } from "vitest";
import { logFault, redact } from "../../src/core/logs.ts";

afterEach(() => vi.restoreAllMocks());

describe("what goes into the Worker's logs", () => {
  it("keeps out tokens, sessions, cookies, emails and link addresses", () => {
    const session = "eyJwZXJzb25JZCI6ImFiYyIsImV4cCI6MX0.c2lnbmF0dXJlLWJ5dGVz";
    expect(redact(`Authorization: Bearer cink_abcDEF123_-xyz from /mcp`)).toBe("Authorization: Bearer … from /mcp");
    expect(redact(`token cink_abcDEF123_-xyz leaked`)).toBe("token cink_… leaked");
    expect(redact(`Cookie: __Host-ink_session=${session}; __Host-ink_google=${session}`)).toBe("Cookie: __Host-ink_session=…; __Host-ink_google=…");
    expect(redact(`state ${session} id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig`)).toBe("state eyJ… id_token eyJ…");
    expect(redact("access ya29.a0AfB_byC-xyz refresh 1//0gAbCdEfGhIjKlMnOpQrStUv")).toBe("access ya29.… refresh 1//…");
    expect(redact("/api/shared/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg/notes/abcdefghijkl broke")).toBe("/api/shared/…/notes/abcdefghijkl broke");
    expect(redact("opened /s/AbCdEfGhIjKlMnOpQrStUvWx")).toBe("opened /s/…");
    // 32 random bytes in base64url, as an upload's part address is made: the route and the part's number stay readable.
    const part = "q3_Zr-0b7XkLw9TnV2yHcUeJfA5mPdS1oGiRxNtB8Yh";
    expect(part).toHaveLength(43);
    expect(redact(`/api/upload-parts/${part}/3`)).toBe("/api/upload-parts/…/3");
    expect(redact(`PUT https://ink.test/api/upload-parts/${part}/{part} broke`)).toBe("PUT https://ink.test/api/upload-parts/…/{part} broke");
    expect(redact("no person for grace.hopper+notes@example.co.uk")).toBe("no person for …@…");
    expect(redact("/auth/dev?email=ada%40example.com&next=/")).toBe("/auth/dev?email=…@…&next=/");
    expect(redact("/auth/google/callback?code=4/0AeanS0aBcDeFgHiJkLmNoPqRsTuV&state=x")).toBe("/auth/google/callback?code=4/0…&state=x");
    expect(redact("at run (node_modules/zod@4.6.5/index.js:1:1)")).toBe("at run (node_modules/zod@4.6.5/index.js:1:1)");
  });

  it("keeps out OAuth's codes, tokens and what an app sends: the verifier, the request a member answers, and what it registered", () => {
    const token = "cink_at_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
    expect(redact(`code cink_ac_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE, access ${token}, refresh cink_rt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE`)).toBe("code cink_…, access cink_…, refresh cink_…");
    expect(redact(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer …");
    expect(redact("POST /oauth/token grant_type=authorization_code&code=cink_ac_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789&client_id=abcDEF123_-&redirect_uri=https%3A%2F%2Fchat.example%2Fcb&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "POST /oauth/token grant_type=authorization_code&code=cink_…&client_id=…&redirect_uri=https%3A%2F%2Fchat.example%2Fcb&code_verifier=…",
    );
    expect(redact("refresh_token=cink_rt_AbCdEf123&client_id=x access_token=abc")).toBe("refresh_token=…&client_id=… access_token=…");
    expect(redact("/connect?request=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4&x=1")).toBe("/connect?request=…&x=1");
    expect(redact("/oauth/authorize?response_type=code&client_id=abc123&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=xyz")).toBe("/oauth/authorize?response_type=code&client_id=…&code_challenge=…&state=xyz");
    expect(redact('{"refresh_token":"cink_rt_abc","code_verifier":"dBjftJeZ4CVP","grant_type":"refresh_token"}')).toBe('{"…":"…","…":"…","…":"…"}');
    expect(redact('{"client_id":"abc123","client_name":"Claude","redirect_uris":["https://chat.example/cb"]}')).toBe('{"…":"…","…":"…","…":["…"]}');
    expect(redact("/auth/google?next=%2Fconnect%3Frequest%3DZm9vYmFyYmF6cXV4_-&x=1")).toBe("/auth/google?next=%2Fconnect%3Frequest%3D…&x=1");
    expect(redact("next=/connect%3frequest%3dZm9vYmFy")).toBe("next=/connect%3frequest%3d…");
    expect(redact("a repeated parameter on /oauth/token broke")).toBe("a repeated parameter on /oauth/token broke");
  });

  it("keeps out what an error quotes of its input, where note text would be, and keeps the words around it", () => {
    expect(redact(`SyntaxError: Unexpected token 'D', "Dear diary, my secret" is not valid JSON`)).toBe(`SyntaxError: Unexpected token '…', "…" is not valid JSON`);
    expect(redact("D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'")).toBe("D1_TYPE_ERROR: Type '…' not supported for value '…'");
    expect(redact(`Unexpected token in JSON "Dear diary\nline two" at 3`)).toBe(`Unexpected token in JSON "…" at 3`);
    expect(redact("Bad title «Dear diary» and “my secret”")).toBe("Bad title «…» and “…”");
    expect(redact("Couldn't remove note abcdefghijkl from Trash: it's locked")).toBe("Couldn't remove note abcdefghijkl from Trash: it's locked");
  });

  it("logs a fault as one redacted line with its stack, never the error object itself", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new SyntaxError(`Unexpected token 'D', "Dear diary" is not valid JSON`);
    logFault("/api/shared/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg", err);
    expect(logged).toHaveBeenCalledTimes(1);
    const [line, ...rest] = logged.mock.calls[0]!;
    expect(rest).toEqual([]);
    expect(line).toMatch(/^\/api\/shared\/… broke: SyntaxError: Unexpected token '…', "…" is not valid JSON\n\s+at /);
    expect(line).not.toContain("Dear diary");
  });
});
