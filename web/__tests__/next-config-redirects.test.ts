import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

type Redirect = { source: string; destination: string; statusCode?: number; missing?: Array<{ type: string; value?: string }> };

const WEB = new URL("../", import.meta.url).pathname;

/** The literal `const PAY_HOST = "..."` declared in a source file. proxy.ts owns the host gate; next.config.ts owns the redirects. */
function declaredPayHost(file: string): string | undefined {
  return readFileSync(join(WEB, file), "utf8").match(/const PAY_HOST = "([^"]+)";/)?.[1];
}

describe("legacy redirects never answer on the pay host (F-05, ADR 0061)", () => {
  it("next.config.ts and proxy.ts declare the same pay host, so the redirect exclusion cannot drift from the host gate", () => {
    const configHost = declaredPayHost("next.config.ts");
    const proxyHost = declaredPayHost("proxy.ts");
    expect(configHost, "next.config.ts must declare PAY_HOST").toBeDefined();
    expect(proxyHost, "proxy.ts must declare PAY_HOST").toBeDefined();
    expect(configHost).toBe(proxyHost);
    expect(configHost).toBe("pay.expanpress.com");
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
