import { describe, expect, it, vi } from "vitest";
import { GLOBAL, loadBrandingSection } from "../src/settings_registry.ts";
import {
  applyCheckoutUrlTheme,
  buildDodoCustomizationPayload,
  buildLemonSqueezyCheckoutOptions,
  buildPaddleCheckoutStylesPayload,
  paddleInitializeCheckoutSettings,
} from "../src/checkout_branding.ts";
import { syncPaddleCheckoutStyles } from "../../scripts/ops/sync_paddle_checkout_styles.ts";

describe("GLOBAL.branding versioned spec", () => {
  it("exposes versioned branding colours, logo URLs, font, and theme", () => {
    expect(GLOBAL.branding.version).toBe("2026-11-v1");
    expect(GLOBAL.branding.theme_mode).toBe("light");
    expect(GLOBAL.branding.font_family).toContain("Inter");
    expect(GLOBAL.branding.logo_url).toBe("https://expanpress.com/assets/expanpress-logo.svg");
    expect(GLOBAL.branding.logo_square_url).toBe("https://expanpress.com/assets/expanpress-logo.webp");
    expect(GLOBAL.branding.colors).toEqual({
      canvas: "#F9F6F0",
      charcoal: "#181818",
      peach: "#FF9E80",
      accent: "#E8622C",
      button_primary: "#2A2A2A",
      button_hover: "#383838",
      button_text: "#FFFFFF",
      border: "#dcc7b4",
    });
    expect(GLOBAL.branding.button_border_radius_px).toBe(24);
  });

  it("validates branding overrides and falls back on malformed values", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalid = loadBrandingSection({
      theme_mode: "neon",
      logo_url: "http://insecure.example/logo.svg",
      colors: { canvas: "not-hex", button_primary: "#123456" },
      button_border_radius_px: 500,
    });
    expect(invalid.theme_mode).toBe("light");
    expect(invalid.logo_url).toBe(GLOBAL.branding.logo_url);
    expect(invalid.colors.canvas).toBe("#F9F6F0");
    expect(invalid.colors.button_primary).toBe("#123456");
    expect(invalid.button_border_radius_px).toBe(24);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("provider checkout branding builders", () => {
  it("builds Paddle.js initialize checkout settings from GLOBAL.branding", () => {
    expect(paddleInitializeCheckoutSettings(GLOBAL.branding, GLOBAL.payments.paddle.overlay)).toEqual({
      displayMode: "overlay",
      theme: "light",
      locale: "en",
    });
  });

  it("builds Paddle Billing API checkout-styles & overlay payloads from GLOBAL.branding", () => {
    const payload = buildPaddleCheckoutStylesPayload(GLOBAL.branding);
    expect(payload.version).toBe("2026-11-v1");
    expect(payload.checkoutStyles.modes.light).toEqual({
      background: "#F9F6F0",
      text: "#181818",
      accent: "#E8622C",
      font: GLOBAL.branding.font_family,
      button: {
        background: "#2A2A2A",
        text: "#FFFFFF",
        border_radius: "24px",
      },
      input: {
        border: "#dcc7b4",
      },
    });
    expect(payload.overlayStyles).toEqual({ primary_checkout_color: "#2A2A2A" });
  });

  it("appends theme query param without overwriting an explicit override", () => {
    const creem = new URL("https://creem.io/payment/prod_1");
    applyCheckoutUrlTheme(creem, "theme", GLOBAL.branding);
    expect(creem.searchParams.get("theme")).toBe("light");

    const preset = new URL("https://creem.io/payment/prod_1?theme=dark");
    applyCheckoutUrlTheme(preset, "theme", GLOBAL.branding);
    expect(preset.searchParams.get("theme")).toBe("dark");
  });

  it("builds Dodo and Lemon Squeezy programmatic payloads from GLOBAL.branding", () => {
    expect(buildDodoCustomizationPayload(GLOBAL.branding)).toEqual({
      theme: "light",
      customization: {
        theme_config: {
          background: "#F9F6F0",
          text: "#181818",
          accent: "#E8622C",
          button_color: "#2A2A2A",
          button_text_color: "#FFFFFF",
          border_color: "#dcc7b4",
          border_radius: "24px",
        },
      },
    });
    expect(buildLemonSqueezyCheckoutOptions(GLOBAL.branding)).toEqual({
      dark: false,
      button_color: "#2A2A2A",
      logo: true,
      media: true,
      embed: true,
    });
  });

  it("syncPaddleCheckoutStyles returns dry-run payload by default and PATCHes Paddle endpoints when apply=true", async () => {
    const dry = await syncPaddleCheckoutStyles({ apply: false });
    expect(dry.applied).toBe(false);
    expect(dry.apiBase).toBe("https://api.paddle.com");

    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const applied = await syncPaddleCheckoutStyles({
      apply: true,
      sandbox: true,
      apiKey: "test_paddle_key",
      fetchImpl: fetchMock,
    });
    expect(applied.applied).toBe(true);
    expect(applied.apiBase).toBe("https://sandbox-api.paddle.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://sandbox-api.paddle.com/checkout-styles");
    expect(fetchMock.mock.calls[1][0]).toBe("https://sandbox-api.paddle.com/settings/checkout-styles-overlay");
  });
});
