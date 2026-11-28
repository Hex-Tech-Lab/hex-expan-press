import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_PROVIDERS,
  applyPreviewProviderOverrides,
  readPreviewOverrides,
} from "../src/settings_registry";

describe("readPreviewOverrides", () => {
  it("reads nothing outside the preview environment, even when the variables are set", () => {
    const env = {
      VERCEL_ENV: "production",
      PREVIEW_ENABLED_PROVIDERS: "creem",
      PREVIEW_CREEM_TEST_DATABASE_REF: "wmagphohfsbjolssqctf",
    };
    expect(readPreviewOverrides(env)).toEqual({ enabledProviders: [], creemTestDatabaseRef: "" });
  });

  it("reads nothing when VERCEL_ENV is unset (local runs and CI)", () => {
    expect(readPreviewOverrides({ PREVIEW_ENABLED_PROVIDERS: "creem" })).toEqual({
      enabledProviders: [],
      creemTestDatabaseRef: "",
    });
  });

  it("parses the provider list and the test ref on preview, trimming and dropping empty entries", () => {
    const env = {
      VERCEL_ENV: "preview",
      PREVIEW_ENABLED_PROVIDERS: " creem , ,paddle ",
      PREVIEW_CREEM_TEST_DATABASE_REF: " wmagphohfsbjolssqctf ",
    };
    expect(readPreviewOverrides(env)).toEqual({
      enabledProviders: ["creem", "paddle"],
      creemTestDatabaseRef: "wmagphohfsbjolssqctf",
    });
  });
});

describe("applyPreviewProviderOverrides", () => {
  it("switches on only the named registered provider and never mutates the defaults", () => {
    const before = DEFAULT_PAYMENT_PROVIDERS.creem.enabled;
    const out = applyPreviewProviderOverrides(DEFAULT_PAYMENT_PROVIDERS, ["creem"]);
    expect(out.creem.enabled).toBe(true);
    expect(DEFAULT_PAYMENT_PROVIDERS.creem.enabled).toBe(before);
    expect(before).toBe(false); // the production default stays off
  });

  it("ignores an unregistered name and leaves every provider as it was", () => {
    const out = applyPreviewProviderOverrides(DEFAULT_PAYMENT_PROVIDERS, ["not_a_provider"]);
    expect(Object.prototype.hasOwnProperty.call(out, "not_a_provider")).toBe(false);
    expect(out.creem.enabled).toBe(DEFAULT_PAYMENT_PROVIDERS.creem.enabled);
  });

  it("with no names it returns the input unchanged", () => {
    const out = applyPreviewProviderOverrides(DEFAULT_PAYMENT_PROVIDERS, []);
    expect(out).toEqual(DEFAULT_PAYMENT_PROVIDERS);
  });
});
