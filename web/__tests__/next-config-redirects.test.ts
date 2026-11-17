import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

type Redirect = { source: string; destination: string; statusCode?: number; missing?: Array<{ type: string; value?: string }> };

describe("legacy redirects never answer on the pay host (F-05, ADR 0061)", () => {
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
