import { GLOBAL } from "../../../payments/src/settings_registry";
import { palette } from "../design/tokens";

export interface BrandedB2cHtmlOptions {
  title: string;
  kicker: string;
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
  referenceId?: string;
  includeSupportLink?: boolean;
}

/** Escapes HTML special characters so untrusted or dynamic strings cannot inject markup. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True when the HTTP request explicitly accepts HTML documents (browser navigation). */
export function acceptsHtml(headers: Headers): boolean {
  return (headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/**
 * Self-contained branded HTML page for B2C edge/route responses (pay. root,
 * 403 Forbidden checkout geo-gate, and 404 Not Found / 410 Gone / 500 Internal Server Error
 * download landings). Uses the storefront {expanpress} wordmark, design tokens,
 * and B2C-confined footer links only.
 */
export function renderBrandedB2cHtml(options: BrandedB2cHtmlOptions): string {
  const brand = escapeHtml(GLOBAL.storefront.brand_name);
  const wordmarkName = escapeHtml(GLOBAL.storefront.brand_name.toLowerCase());
  const catalogUrl = escapeHtml(GLOBAL.storefront.b2c_landing_url);
  const ctaLabel = escapeHtml(options.ctaLabel ?? GLOBAL.storefront.browse_books_label);
  const ctaHref = escapeHtml(options.ctaHref ?? GLOBAL.storefront.b2c_landing_url);
  const supportEmail = escapeHtml(GLOBAL.email.support);
  const title = escapeHtml(options.title);
  const kicker = escapeHtml(options.kicker);
  const heading = escapeHtml(options.heading);
  const body = escapeHtml(options.body);
  const legalLinks = GLOBAL.storefront.buyer_legal_links
    .map((link) => `<a href="${escapeHtml(link.path)}">${escapeHtml(link.label)}</a>`)
    .join("\n        ");
  const refBlock = options.referenceId
    ? `<p class="ref">Reference: <code>${escapeHtml(options.referenceId)}</code></p>`
    : "";
  const supportBlock = options.includeSupportLink
    ? `<p class="support-note">Need help? Write to ${supportEmail} and include your order details.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${title} · ${brand}</title>
  <style>
    :root{color-scheme:light;--color-canvas:${palette.canvas};--color-charcoal:${palette.charcoal};--color-peach:${palette.peach}}
    *{box-sizing:border-box}
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-feature-settings:"cv02","cv03","cv04","cv11";-webkit-font-smoothing:antialiased;background:var(--color-canvas);color:var(--color-charcoal)}
    .frame{min-height:100vh;padding:16px;display:flex;flex-direction:column}
    .inner{max-width:1240px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:24px;flex:1}
    @media(min-width:640px){.frame{padding:32px}}
    @media(min-width:768px){.frame{padding:48px}.inner{gap:32px}}
    header{display:flex;align-items:center;justify-content:space-between}
    .wordmark{font-size:1.25rem;line-height:1.75rem;font-weight:700;letter-spacing:-0.025em;color:#111827;text-decoration:none}
    @media(min-width:640px){.wordmark{font-size:1.5rem;line-height:2rem}}
    .wordmark .brace{color:#4b5563;font-weight:300}
    .wordmark .name{color:#111827}
    main{width:100%;max-width:36rem;margin:auto;background:rgba(255,255,255,0.78);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border:1.5px solid #fff2e4;border-radius:32px;padding:24px;box-shadow:inset 0 2px 2px rgba(255,255,255,0.95),inset 0 -16px 24px -12px rgba(196,148,118,0.18),0 24px 60px rgba(0,0,0,0.04),0 1px 3px rgba(0,0,0,0.02);display:flex;flex-direction:column;gap:20px}
    @media(min-width:640px){main{padding:32px}}
    .kicker{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:#4b5563}
    @media(min-width:640px){.kicker{font-size:12px}}
    h1{margin:0;font-size:1.875rem;line-height:1.12;font-weight:700;letter-spacing:-0.025em;color:#111827}
    @media(min-width:640px){h1{font-size:2.25rem}}
    .desc,.support-note,.ref{margin:0;font-size:1rem;line-height:1.625;color:#374151}
    .support-note,.ref{font-size:0.875rem;color:#4b5563}
    .cta{align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;gap:12px;border-radius:9999px;background:#2A2A2A;color:#fff;text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:14px 24px;transition:background-color 150ms ease}
    .cta:hover{background:#383838}
    .cta svg{width:14px;height:14px;flex-shrink:0}
    footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:16px;color:#4b5563;padding:0 8px 16px}
    .footer-links{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
    .footer-links a{color:inherit;text-decoration:none;transition:color 150ms ease}
    .footer-links a:hover{color:#374151}
    a:focus-visible{outline:3px solid #b3401e;outline-offset:3px}
    .cta:focus-visible{outline:3px solid #E8622C;outline-offset:2px}
  </style>
</head>
<body>
  <div class="frame">
    <div class="inner">
      <header>
        <a href="${catalogUrl}" aria-label="${brand} home" class="wordmark"><span class="brace">{</span><span class="name">${wordmarkName}</span><span class="brace">}</span></a>
      </header>
      <main>
        <p class="kicker">${kicker}</p>
        <h1>${heading}</h1>
        <p class="desc">${body}</p>
        ${supportBlock}
        ${refBlock}
        <a class="cta" href="${ctaHref}">
          <span>${ctaLabel}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </a>
      </main>
      <footer>
        <div><span>&copy; 2026 ${brand}</span></div>
        <div class="footer-links">
        ${legalLinks}
        <span>${supportEmail}</span>
        </div>
      </footer>
    </div>
  </div>
</body>
</html>`;
}
