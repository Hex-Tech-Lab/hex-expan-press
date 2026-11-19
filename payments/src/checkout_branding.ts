import { GLOBAL, type BrandCheckoutSettings, type PaddleOverlaySettings } from "./settings_registry.ts";

/** Paddle.js `initializePaddle({ checkout: { settings } })` branding options (official SDK `CheckoutSettings`). */
export function paddleInitializeCheckoutSettings(
  branding: BrandCheckoutSettings = GLOBAL.branding,
  overlay: Pick<PaddleOverlaySettings, "locale"> = GLOBAL.payments.paddle.overlay,
): { displayMode: "overlay"; theme: "light" | "dark"; locale: string } {
  return {
    displayMode: "overlay",
    theme: branding.theme_mode,
    locale: overlay.locale,
  };
}

/**
 * Paddle Billing REST API style payloads (`PATCH /checkout-styles` and `PATCH /settings/checkout-styles-overlay`)
 * built strictly from the versioned `GLOBAL.branding` spec (`docs/ops/PROVIDER_CHECKOUT_BRANDING.md`).
 */
export function buildPaddleCheckoutStylesPayload(branding: BrandCheckoutSettings = GLOBAL.branding) {
  return {
    version: branding.version,
    checkoutStyles: {
      modes: {
        [branding.theme_mode]: {
          background: branding.colors.canvas,
          text: branding.colors.charcoal,
          accent: branding.colors.accent,
          font: branding.font_family,
          button: {
            background: branding.colors.button_primary,
            text: branding.colors.button_text,
            border_radius: `${branding.button_border_radius_px}px`,
          },
          input: {
            border: branding.colors.border,
          },
        },
      },
    },
    overlayStyles: {
      primary_checkout_color: branding.colors.button_primary,
    },
  };
}

/** Appends the provider's documented theme query parameter (e.g. `?theme=light`) when supported and not already set. */
export function applyCheckoutUrlTheme(
  url: URL,
  themeParam: string | null | undefined,
  branding: Pick<BrandCheckoutSettings, "theme_mode"> = GLOBAL.branding,
): void {
  if (typeof themeParam === "string" && themeParam.trim() !== "" && !url.searchParams.has(themeParam)) {
    url.searchParams.set(themeParam, branding.theme_mode);
  }
}

/** Dodo Payments checkout session `theme` + `customization.theme_config` payload from `GLOBAL.branding`. */
export function buildDodoCustomizationPayload(branding: BrandCheckoutSettings = GLOBAL.branding) {
  return {
    theme: branding.theme_mode,
    customization: {
      theme_config: {
        background: branding.colors.canvas,
        text: branding.colors.charcoal,
        accent: branding.colors.accent,
        button_color: branding.colors.button_primary,
        button_text_color: branding.colors.button_text,
        border_color: branding.colors.border,
        border_radius: `${branding.button_border_radius_px}px`,
      },
    },
  };
}

/** Lemon Squeezy `checkout_options` payload from `GLOBAL.branding`. */
export function buildLemonSqueezyCheckoutOptions(branding: BrandCheckoutSettings = GLOBAL.branding) {
  return {
    dark: branding.theme_mode === "dark",
    button_color: branding.colors.button_primary,
    logo: true,
    media: true,
    embed: true,
  };
}
