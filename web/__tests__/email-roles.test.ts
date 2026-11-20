import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { checkEmailRolesAcrossFiles } from "../../scripts/sync_email_roles";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Email roles registry and listed locations (EMAIL_ADDRESS_MAP)", () => {
  it("defines one registry key per role (support, billing, privacy, legal, sender)", () => {
    expect(GLOBAL.email.support).toBe("support@expanpress.com");
    expect(GLOBAL.email.billing).toBe("billing@expanpress.com");
    expect(GLOBAL.email.privacy).toBe("privacy@expanpress.com");
    expect(GLOBAL.email.legal).toBe("legal@expanpress.com");
    expect(GLOBAL.email.sender).toBe("ExpanPress <delivery@expanpress.com>");
  });

  it("every static legal page and Supabase auth template matches its GLOBAL.email role key", () => {
    const res = checkEmailRolesAcrossFiles(REPO_ROOT);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("listed dynamic TSX/TS locations read GLOBAL.email role keys without hard-coded support@ literals", () => {
    const targets = [
      "web/src/components/storefront/storefront.tsx",
      "web/src/components/landing/landing-page.tsx",
      "web/app/page.tsx",
      "web/app/creator/dashboard/page.tsx",
      "web/app/creator/dashboard/dashboard-client.tsx",
      "web/app/creator/consents/page.tsx",
      "web/app/creator/consents/actions.ts",
      "web/app/creator/review/page.tsx",
      "web/app/checkout/[productId]/page.tsx",
      "web/app/books/[handle]/thanks/page.tsx",
      "payments/src/email.ts",
      "payments/src/delivery.ts",
    ];
    for (const rel of targets) {
      const content = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(content, rel).not.toContain("support@expanpress.com");
      expect(content, rel).not.toContain("support@esign.expanpress.com");
    }
  });
});
