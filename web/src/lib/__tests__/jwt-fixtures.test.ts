// Independent check of the shared JWT fixture. The alg-confusion tests only prove something if the fixture
// really signs with the HMAC key: otherwise they could pass for the wrong reason. These checks recompute the
// signature with node:crypto directly, not through makeTestJwt, and use decodeAndVerifyJwt only as a positive control.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { decodeAndVerifyJwt } from "../jwt-verify";
import { ASYMMETRIC_ALG_FIXTURES, MOCK_HMAC_KEY, makeTestJwt } from "./jwt-fixtures";

const SUB = "57596c19-c550-4bde-b17a-e87b86d005c5";
const claims = () => ({ sub: SUB, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });

/** HMAC-SHA256 over `header.payload`, computed here and not by the fixture under test. */
const independentSignature = (header: string, body: string, key: string): string =>
  createHmac("sha256", key).update(`${header}.${body}`).digest("base64url");

beforeEach(() => {
  vi.stubEnv("SUPABASE_JWT_SECRET", MOCK_HMAC_KEY);
});
afterEach(() => vi.unstubAllEnvs());

describe("shared JWT fixture: independent HMAC check", () => {
  it("an HS256 fixture carries the HMAC of header.payload under the fixture key", () => {
    const [h, b, s] = makeTestJwt(claims()).split(".");
    expect(s).toBe(independentSignature(h, b, MOCK_HMAC_KEY));
  });

  it("positive control: a correctly signed HS256 token is accepted by the verifier", () => {
    expect(decodeAndVerifyJwt(makeTestJwt(claims()))).not.toBeNull();
  });

  it("negative control: a token signed with a different key is rejected", () => {
    expect(decodeAndVerifyJwt(makeTestJwt(claims(), { secret: "a-different-testing-only-key-value" }))).toBeNull();
  });

  it.each(ASYMMETRIC_ALG_FIXTURES)(
    "%s fixture: header claims %s, but the signature is a real HMAC under the fixture key, so only the alg gate can reject it",
    (alg) => {
      const token = makeTestJwt(claims(), { alg });
      const [h, b, s] = token.split(".");
      expect(JSON.parse(Buffer.from(h, "base64url").toString("utf8")).alg).toBe(alg);
      expect(s).toBe(independentSignature(h, b, MOCK_HMAC_KEY));
      expect(decodeAndVerifyJwt(token)).toBeNull();
    },
  );
});
