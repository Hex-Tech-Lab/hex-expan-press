import { describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import * as legacyRules from "../index";
import type { Rule } from "../../domain/Rule";
import {
  HardcodedTierGrantRule,
  UntrustedTierFallbackRule,
  ServiceRoleAnonFallbackRule,
  RuntimeTierTrustRule,
} from "../security-lessons-20260924";

const project = new Project({ useInMemoryFileSystem: true });

function check(rule: Rule, filePath: string, content: string) {
  const sf = project.createSourceFile(filePath, content, { overwrite: true });
  return rule.check({ filePath, ast: sf, allFiles: [filePath] });
}

// Positive snippets are the REAL pre-fix code, quoted from the historical
// commits / live files named in docs/qa-intel/RULESET_LESSONS_LEDGER.md
// (2026-09-24 entry).

describe("HardcodedTierGrantRule (R1)", () => {
  test("positive: fires on the real legacy Paddle webhook grant (255c14ca, web/app/api/billing/webhook/route.ts)", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      case 'subscription.created': {
        const userId = event.data.custom_data?.userId;
        if (userId) {
          await supabase
            .from('users')
            .update({ tier: 'pro', updated_at: new Date().toISOString() })
            .eq('id', userId);
        }
        break;
      }
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("hardcoded paid-tier grant");
  });

  test("positive: fires on the real Stripe webhook handler ternary (PR #325 tangent, web/lib/stripe/webhook-handlers.ts)", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/lib/stripe/webhook-handlers.ts",
      `
      const updateData: Record<string, any> = {
        tier: status === 'success' ? 'pro' : 'free',
        stripe_subscription_id: subscription.id,
      };
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("negative control: legit cancel downgrade ('free' literal) does NOT fire", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      case 'subscription.canceled': {
        const userId = event.data.custom_data?.userId;
        if (userId) {
          await persistenceAdapter.updateUserTier({ userId, tier: 'free' });
        }
        break;
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: paid literal in a pricing table (web/lib/stripe.ts, not a webhook) does NOT fire", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/lib/stripe.ts",
      `
      export const PRICING_TABLE = {
        pro: {
          tier: 'pro',
          price: 900,
        },
      };
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: static PRICING_TABLE inside a webhook file is a declarative price mapping, NOT a grant (2026-09-25 review: flipped from positive)", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      export const PRICING_TABLE = {
        pro: {
          tier: 'pro',
          price: 900,
        },
      };
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: nested static table with multiple entries in a webhook file does NOT fire", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const PRICE_TIER_MAP: Record<string, { tier: string }> = {
        pri_pro: { tier: 'pro' },
        pri_max: { tier: 'max' },
      };
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("still fires when the table object is passed to a runtime write (call argument, not a declaration)", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      await supabase
        .from('users')
        .update({ tier: 'pro', updated_at: new Date().toISOString() });
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("still fires when a declared object carries a DYNAMIC tier value (ternary — the PR #325 tangent shape)", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/lib/stripe/webhook-handlers.ts",
      `
      const updateData: Record<string, any> = {
        tier: status === 'success' ? 'pro' : 'free',
        stripe_subscription_id: subscription.id,
      };
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("positive: fires on a direct assignment x.tier = 'pro' in a webhook path", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/lib/stripe/webhook-handlers.ts",
      `
      export function grantOnSuccess(user: { tier: string }) {
        user.tier = 'pro';
      }
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("hardcoded paid-tier grant");
  });

  test("positive: fires on a computed-key assignment obj['tier'] = 'founder' in a webhook path", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      function grant(record: Record<string, string>) {
        record['tier'] = 'founder';
      }
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("negative control: downgrade assignment x.tier = 'free' in a webhook path does NOT fire", () => {
    const findings = check(
      HardcodedTierGrantRule,
      "web/app/api/billing/webhook/route.ts",
      `
      record.tier = 'free';
      `,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("UntrustedTierFallbackRule (R2)", () => {
  test("positive: fires on the real pre-d7a57c82 resolveEventTier fallback", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      function resolveEventTier(event: PaddleEventShape): Promise<UserTier | null> {
        if (event.data.status === 'canceled') return Promise.resolve('free');
        const priceId = event.data.items?.[0]?.price?.id;
        const fromPrice = resolveUserTierForPriceId(priceId);
        if (fromPrice) return fromPrice;
        return mapPlanStringToUserTier(event.data.custom_data?.planTier)
          ?? mapPlanStringToUserTier(event.data.items?.[0]?.price?.custom_data?.plan_tier);
      }
      `,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("negative control: the fixed fail-closed shape (d7a57c82) does NOT fire", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      function resolveEventTier(event: PaddleEventShape): Promise<UserTier | null> {
        if (event.data.status === 'canceled') return Promise.resolve('free');
        const priceId = event.data.items?.[0]?.price?.id;
        return resolveUserTierForPriceId(priceId);
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: custom_data used for userId only (real current code) does NOT fire", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const userId = event.data.custom_data?.userId;
      if (!userId) {
        return NextResponse.json({ error: 'Unrecognised price ID, tier not changed' }, { status: 400 });
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: updateUserTier call passing userId from custom_data (tier already resolved) does NOT fire", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      await updateUserTier({ userId: event.data.custom_data?.userId, tier: resolvedTier });
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: presence guard !event.data.custom_data?.userId || !resolvedTier does NOT fire", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      if (!event.data.custom_data?.userId || !resolvedTier) {
        return NextResponse.json({ error: 'bad request' }, { status: 400 });
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("positive: fires on plan_tier snake_case read (price.custom_data?.plan_tier fallback)", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const tier = mapPlanStringToUserTier(event.data.items?.[0]?.price?.custom_data?.plan_tier) ?? 'free';
      `,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("positive: fires on COMPUTED element access custom_data?.[\"planTier\"] (2026-09-25 review gap)", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const tier = mapPlanStringToUserTier(event.data.custom_data?.["planTier"]);
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("custom_data");
  });

  test("positive: fires on non-optional computed access custom_data[\"plan_tier\"]", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const tier = mapPlanStringToUserTier(event.data.custom_data["plan_tier"]);
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("positive: fires on computed access in a ?? fallback chain", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const tier = resolveUserTierForPriceId(priceId) ?? mapPlanStringToUserTier(event.data.custom_data?.["planTier"]);
      `,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("negative control: the pattern as a STRING LITERAL argument does NOT fire (2026-09-25 review gap: string contents triggered it)", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const debugHint = mapTierLabel("custom_data?.planTier read from payload");
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: the pattern inside a plain string variable does NOT fire", () => {
    const findings = check(
      UntrustedTierFallbackRule,
      "web/app/api/billing/webhook/route.ts",
      `
      const hint = 'custom_data.planTier';
      const tier = mapPlanStringToUserTier(hint);
      `,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("ServiceRoleAnonFallbackRule (R5)", () => {
  test("positive: fires on the real backfill line (8c159c92, scripts/backfill-stance-relations.ts)", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "scripts/backfill-stance-relations.ts",
      `
      const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("service-role key silently falls back");
  });

  test("negative control: service-role key with a literal placeholder (web/playwright.config.ts) does NOT fire", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "web/playwright.config.ts",
      `
      use: {
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-role-key',
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: service-role key with empty-string fallback (web/lib/auth/config.ts) does NOT fire", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "web/lib/auth/config.ts",
      `
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("positive: fires across a line break (multiline fallback chain)", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "scripts/backfill-stance-relations.ts",
      `
      const SUPABASE_KEY =
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      `,
    );
    expect(findings.length).toBe(1);
  });

  test("negative control: the raw pattern inside a comment does NOT fire", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "scripts/backfill-stance-relations.ts",
      `
      // Never do: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: the raw pattern inside a string literal does NOT fire", () => {
    const findings = check(
      ServiceRoleAnonFallbackRule,
      "scripts/backfill-stance-relations.ts",
      `
      const warning = "process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY";
      `,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("RuntimeTierTrustRule (R10)", () => {
  test("positive: fires on the real usage/summary cast (web/app/api/usage/summary/route.ts:48)", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/app/api/usage/summary/route.ts",
      `
      export async function GET() {
        const tier = (profile?.tier as UserTier) || 'free';
        const analysisQuota = ANALYSIS_MONTHLY_QUOTA[tier];
        return NextResponse.json({ tier, analysisQuota });
      }
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("cast to UserTier");
  });

  test("positive: fires on `tier !== 'free'` as is-paid check", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/lib/quota.ts",
      `
      if (tier !== 'free') {
        allowUnlimited();
      }
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("non-'free'");
  });

  test("positive: a non-normalizer call operand (getTier(profile) !== 'free') DOES fire", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/lib/quota.ts",
      `
      if (getTier(profile) !== 'free') {
        allowUnlimited();
      }
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("non-'free'");
  });

  test("positive: a non-normalizer call cast (getTier(profile) as UserTier) DOES fire", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/app/api/usage/summary/route.ts",
      `
      const tier = getTier(profile) as UserTier;
      `,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("cast to UserTier");
  });

  test("negative control: normalized tier comparison (the recommended fix shape) does NOT fire", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/lib/quota.ts",
      `
      if (normalizeUserTier(user.tier) !== 'free') {
        allowUnlimited();
      }
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: normalized DB value without a cast does NOT fire", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/app/api/usage/summary/route.ts",
      `
      const tier = normalizeUserTier(profile?.tier) || 'free';
      `,
    );
    expect(findings).toHaveLength(0);
  });

  test("negative control: comparisons not against 'free' do NOT fire", () => {
    const findings = check(
      RuntimeTierTrustRule,
      "web/lib/billing.ts",
      `
      if (tier !== previousTier) { notify(); }
      if (event.tier !== 'expected') { log(); }
      `,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("security-lessons-20260924 rules — production registration", () => {
  test("all four rules are present in the real Object.values(legacyRules) registration set", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(HardcodedTierGrantRule);
    expect(registered).toContain(UntrustedTierFallbackRule);
    expect(registered).toContain(ServiceRoleAnonFallbackRule);
    expect(registered).toContain(RuntimeTierTrustRule);
  });
});
