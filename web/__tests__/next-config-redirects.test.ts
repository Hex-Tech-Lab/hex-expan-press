import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";
import { GLOBAL } from "../../payments/src/settings_registry";

type Redirect = { source: string; destination: string; statusCode?: number; missing?: Array<{ type: string; value?: string }> };

const WEB = new URL("../", import.meta.url).pathname;

describe("legacy redirects never answer on the pay host (F-05, ADR 0061)", () => {
  it("next.config.ts and proxy.ts both derive PAY_HOST from the registry pay origin, so the redirect exclusion cannot drift from the host gate", () => {
    // Both files read the same registry value (storefront.pay_origin, a fixed ADR 0061 trust value); no literal host is declared.
    expect(readFileSync(join(WEB, "next.config.ts"), "utf8")).toMatch(/const PAY_HOST = new URL\(GLOBAL\.storefront\.pay_origin\)\.host;/);
    expect(readFileSync(join(WEB, "proxy.ts"), "utf8")).toMatch(/const PAY_HOST = new URL\(PAY_ORIGIN\)\.host;/);
    expect(new URL(GLOBAL.storefront.pay_origin).host).toBe("pay.expanpress.com");
  });

  it("scopes every /c and /d redirect with a missing pay-host condition", async () => {
    const redirects = (await nextConfig.redirects!()) as Redirect[];
    const legacy = redirects.filter((r) => r.source.startsWith("/c/") || r.source.startsWith("/d/"));
    expect(legacy.map((r) => r.source)).toEqual(["/c/:handle", "/c/:handle/:product", "/d/:token"]);
    for (const r of legacy) {
      expect(r.missing, `${r.source} must exclude the pay host`).toEqual([{ type: "host", value: "pay.expanpress.com" }]);
    }
  });

  it("keeps the redirects on every other host (no positive host condition)", async () => {
    const redirects = (await nextConfig.redirects!()) as Array<Redirect & { has?: unknown }>;
    for (const r of redirects) {
      expect(r.has, `${r.source} must not be limited to one host`).toBeUndefined();
    }
  });
});
