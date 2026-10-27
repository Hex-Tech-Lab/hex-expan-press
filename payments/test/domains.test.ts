import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/domains";
import { DEFAULT_GLOBAL, GLOBAL } from "../src/settings_registry";

describe("public origins come from the settings registry", () => {
  it("the registry carries the same origins as the shared module", () => {
    expect(DEFAULT_GLOBAL.domains).toEqual({ site: DOMAINS.site, pay: DOMAINS.pay });
    expect(GLOBAL.domains).toEqual({ site: DOMAINS.site, pay: DOMAINS.pay });
  });

  it("checkout runs on the pay subdomain, never the site apex (ADR 0061)", () => {
    expect(new URL(GLOBAL.domains.pay).hostname.startsWith("pay.")).toBe(true);
    expect(GLOBAL.domains.pay).not.toBe(GLOBAL.domains.site);
  });
});
