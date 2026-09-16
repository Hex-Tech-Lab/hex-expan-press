import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "config.duane.json");
const siteRoot = join(here, "site");

const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
  checkout_url?: string;
  checkout_mode?: string;
};

const now = new Date().toISOString();
const isRealUrl = (u: string | undefined): u is string =>
  typeof u === "string" && /^https?:\/\//.test(u);

const primaryGated =
  `<a class="buy pending" id="buy" href="#buy-link-pending" ` +
  `data-checkout-slot="primary" data-config-source="payments/config.duane.json" ` +
  `data-checkout-mode="gated" data-baked-at="${now}">` +
  `Checkout coming online &mdash; provider review in progress</a>`;

const primaryLive = (url: string) =>
  `<a class="buy" id="buy" href="${url}" rel="noopener" ` +
  `data-checkout-slot="primary" data-config-source="payments/config.duane.json" ` +
  `data-checkout-mode="live" data-baked-at="${now}">` +
  `Buy now &mdash; get the PDF instantly</a>`;

const sandboxLive = (url: string) =>
  `<a href="${url}" rel="noopener" data-checkout-slot="sandbox" ` +
  `data-config-source="payments/config.duane.json" data-checkout-mode="sandbox" ` +
  `data-baked-at="${now}">Open sandbox test checkout &rarr;</a>`;

const sandboxOff =
  `<a href="#sandbox-checkout-pending" data-checkout-slot="sandbox" ` +
  `data-config-source="payments/config.duane.json" data-checkout-mode="gated" ` +
  `data-baked-at="${now}">Sandbox test checkout &mdash; not configured</a>`;

const swap = (html: string, slot: string, replacement: string): string => {
  const re = new RegExp(`<a\\b[^>]*data-checkout-slot="${slot}"[^>]*>[\\s\\S]*?</a>`);
  if (!re.test(html)) return html;
  return html.replace(re, replacement);
};

const perCreatorMode = isRealUrl(cfg.checkout_url) ? cfg.checkout_mode ?? "gated" : "gated";

const masterPath = join(siteRoot, "index.html");
const master = readFileSync(masterPath, "utf8");
writeFileSync(masterPath, swap(master, "primary", primaryGated));
console.log(`baked ${join("site", "index.html")} primary=gated (master page: always gated)`);

const cRoot = join(siteRoot, "c");
for (const dir of readdirSync(cRoot)) {
  const p = join(cRoot, dir, "index.html");
  const html = readFileSync(p, "utf8");
  let out = swap(html, "primary", perCreatorMode === "live" ? primaryLive(cfg.checkout_url as string) : primaryGated);
  out = swap(out, "sandbox", perCreatorMode === "sandbox" && isRealUrl(cfg.checkout_url) ? sandboxLive(cfg.checkout_url) : sandboxOff);
  writeFileSync(p, out);
  console.log(`baked ${join("site", "c", dir, "index.html")} mode=${perCreatorMode}`);
}
