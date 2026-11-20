# Provider Checkout Branding — Dashboard Checklist

**Version:** `2026-11-v1` (from `GLOBAL.branding` in `payments/src/settings_registry.ts`)  
**Reference Specification:** `docs/ops/PROVIDER_CHECKOUT_BRANDING.md`  
**Scope:** Dashboard-only branding fields across Paddle, Creem, Fungies, Polar, Dodo Payments, and Lemon Squeezy that cannot be set exclusively via client/checkout code.

---

## Canonical Registry Values (`GLOBAL.branding` `2026-11-v1`)

| Token | Exact Value |
| :--- | :--- |
| `version` | `2026-11-v1` |
| `theme_mode` | `light` |
| `font_family` | `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` |
| `logo_url` | `https://expanpress.com/assets/expanpress-logo.svg` (`web/public/assets/expanpress-logo.svg`) |
| `logo_square_url` | `https://expanpress.com/assets/expanpress-logo.webp` (`web/public/assets/expanpress-logo.webp`) |
| `colors.canvas` | `#F9F6F0` |
| `colors.charcoal` | `#181818` |
| `colors.peach` | `#FF9E80` |
| `colors.accent` | `#E8622C` |
| `colors.button_primary` | `#2A2A2A` |
| `colors.button_hover` | `#383838` |
| `colors.button_text` | `#FFFFFF` |
| `colors.border` | `#dcc7b4` |
| `button_border_radius_px` | `24` |

> **Already wired in code (no manual toggle needed):**
> - Paddle.js `initializePaddle({ checkout: { settings: { displayMode: "overlay", theme: "light", locale: "en" } } })` and `Paddle.Checkout.open({ settings })` (`web/src/lib/paddle-overlay.ts`, `web/src/lib/paddle-overlay-server.ts`).
> - Paddle Billing API style sync script (`scripts/ops/sync_paddle_checkout_styles.ts --apply` using `buildPaddleCheckoutStylesPayload(GLOBAL.branding)`).
> - Creem & Polar checkout redirect links append `?theme=light` (`web/app/api/billing/checkout/checkout-helpers.ts`, `src/adapters/payments/polar.adapter.ts`).

---

## 1. Paddle (Dashboard > Checkout > Checkout configuration > Styling)

Run `pnpm exec tsx scripts/ops/sync_paddle_checkout_styles.ts --apply` (with `PADDLE_API_KEY` holding `checkout_settings.write`), or set manually in the dashboard:

- [ ] **Logo upload:** `web/public/assets/expanpress-logo.svg` (or `expanpress-logo.webp`)
- [ ] **Default Mode:** `light`
- [ ] **Font Family:** `Inter` (`Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- [ ] **Light Mode Background (`modes.light.background`):** `#F9F6F0`
- [ ] **Light Mode Primary Text (`modes.light.text`):** `#181818`
- [ ] **Primary Button Background (`modes.light.button.background`):** `#2A2A2A`
- [ ] **Primary Button Text (`modes.light.button.text`):** `#FFFFFF`
- [ ] **Button Border Radius (`button.border_radius`):** `24px`
- [ ] **Overlay Primary Color (`primary_checkout_color`):** `#2A2A2A`
- [ ] **Input Border (`modes.light.input.border`):** `#dcc7b4`
- [ ] **Accent / Focus (`modes.light.accent`):** `#E8622C`

---

## 2. Creem (Dashboard > Settings > Branding)

URL query parameter `?theme=light` is automatically appended in `checkout-helpers.ts`. Configure the remaining store-level branding fields in the Creem dashboard:

- [ ] **Logo Upload:** `web/public/assets/expanpress-logo.svg`
- [ ] **Default Checkout Theme:** `Light` (`light`)
- [ ] **Accent Color:** `#2A2A2A` (`colors.button_primary`)
- [ ] **Accent Hover Color:** `#383838` (`colors.button_hover`)
- [ ] **Text Color:** `#FFFFFF` (`colors.button_text`)
- [ ] **Field Border (if editable):** `#dcc7b4` (`colors.border`)
- [ ] **Support Email (Receipts):** `support@expanpress.com` (`GLOBAL.email.support`)
- [ ] **Do NOT point `pay.expanpress.com` as a Creem custom domain** (ADR 0061: `pay.expanpress.com` is ExpanPress's own checkout host in front of MoR rails).

---

## 3. Fungies (Dashboard > Website / Store Builder & Overlay Settings)

Fungies inherits store-level and overlay-level branding from the dashboard:

- [ ] **Store Settings > Media — Logo:** upload `web/public/assets/expanpress-logo.svg`
- [ ] **Store Settings > Media — Favicon:** upload `web/public/assets/expanpress-logo.webp`
- [ ] **Store Theme:** `Light` (`light`)
- [ ] **Store Background:** `#F9F6F0` (`colors.canvas`)
- [ ] **Body Text:** `#181818` (`colors.charcoal`)
- [ ] **Font Family:** `Inter` (`Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- [ ] **Overlay settings > Customize Overlay — Modal Background:** `#F9F6F0` (or `#FFFFFF` if light-surface only)
- [ ] **Overlay settings > Customize Overlay — Primary Button Color:** `#2A2A2A` (`colors.button_primary`)
- [ ] **Overlay settings > Customize Overlay — Button Text Color:** `#FFFFFF` (`colors.button_text`)
- [ ] **Accent Color:** `#E8622C` (`colors.accent`)
- [ ] **Corner Style:** Rounded (`24px` pill/rounded preset)
- [ ] **Save and Publish changes**

---

## 4. Polar (Dashboard > Organization Settings)

URL query parameter `?theme=light` is automatically appended in `checkout-helpers.ts` and `PolarAdapter.createCheckout()`. Polar does not support arbitrary color/font overrides:

- [ ] **Organization Avatar / Logo:** upload `web/public/assets/expanpress-logo.webp`
- [ ] **Organization Public Name:** `ExpanPress` (`GLOBAL.storefront.brand_name`)
- [ ] **Support Email:** `support@expanpress.com` (`GLOBAL.email.support`)

---

## 5. Dodo Payments (Design & Themes Hub / Settings > Business > Brands)

Programmatic payload builder `buildDodoCustomizationPayload(GLOBAL.branding)` in `payments/src/checkout_branding.ts` supplies `theme`, `background`, `text`, `accent`, `button_color`, `button_text_color`, `border_color`, and `border_radius`. Configure assets in the dashboard:

- [ ] **1:1 Square Store Logo:** upload `web/public/assets/expanpress-logo.webp`
- [ ] **Theme Preset:** `Light` (`light`)
- [ ] **Canvas / Text / Accent / Button / Border:** `#F9F6F0` / `#181818` / `#E8622C` / `#2A2A2A` (`#FFFFFF` text) / `#dcc7b4`
- [ ] **Border Radius:** `24px`
- [ ] **Support Email:** `support@expanpress.com` (`GLOBAL.email.support`)

---

## 6. Lemon Squeezy (Dashboard > Store Settings > Design)

Programmatic payload builder `buildLemonSqueezyCheckoutOptions(GLOBAL.branding)` in `payments/src/checkout_branding.ts` supplies `dark: false`, `button_color: "#2A2A2A"`, `logo: true`, `media: true`, `embed: true`. Configure remaining design editor settings in the dashboard:

- [ ] **Store Logo:** upload `web/public/assets/expanpress-logo.svg`
- [ ] **Favicon:** upload `web/public/assets/expanpress-logo.webp`
- [ ] **Mode:** Light (`dark: false`)
- [ ] **Background Color:** `#F9F6F0` (`colors.canvas`)
- [ ] **Text Color:** `#181818` (`colors.charcoal`)
- [ ] **Primary / Button Color:** `#2A2A2A` (`colors.button_primary`)
- [ ] **Button Text Color:** `#FFFFFF` (`colors.button_text`)
- [ ] **Accent Color:** `#E8622C` (`colors.accent`)
- [ ] **Button Shape:** Pill / Rounded (`24px`)
