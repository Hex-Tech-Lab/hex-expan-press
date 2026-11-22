import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, loadStorefrontSection } from "../src/settings_registry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storefront.hide_empty_creator_hubs (settings registry)", () => {
  it("defaults to true so a creator hub with no visible product returns 404", () => {
    expect(DEFAULT_GLOBAL.storefront.hide_empty_creator_hubs).toBe(true);
    expect(loadStorefrontSection(undefined).hide_empty_creator_hubs).toBe(true);
  });

  it("accepts an explicit boolean", () => {
    expect(loadStorefrontSection({ hide_empty_creator_hubs: false }).hide_empty_creator_hubs).toBe(false);
    expect(loadStorefrontSection({ hide_empty_creator_hubs: true }).hide_empty_creator_hubs).toBe(true);
  });

  it("falls back to true with a warning on a non-boolean value", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadStorefrontSection({ hide_empty_creator_hubs: "false" }).hide_empty_creator_hubs).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hide_empty_creator_hubs"));
  });
});
