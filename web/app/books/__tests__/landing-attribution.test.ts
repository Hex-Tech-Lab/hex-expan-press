import { describe, expect, it, vi } from "vitest";

// The B2C landing must capture referral parameters (?src / ?dub_id) before its product links drop the query
// string. Without the capture, a buyer who arrives at /books?src=... and buys reaches checkout as "direct".

vi.mock("server-only", () => ({}));
vi.mock("../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));
vi.mock("../../../src/components/storefront/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/components/storefront/storefront")>()),
  fetchB2cLanding: vi.fn(async () => []),
}));

import B2cLandingPage from "../page";
import { AttributionCapture } from "../../../src/components/storefront/buy-link";

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];

function walk(node: Node, visit: (el: { type?: unknown; props: Record<string, unknown> }) => void): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  const el = node as { type?: unknown; props: Record<string, unknown> };
  visit(el);
  walk(el.props.children as Node, visit);
}

describe("B2C landing (/books) attribution", () => {
  it("mounts AttributionCapture so referral parameters are kept before the product links", async () => {
    const tree = await B2cLandingPage();
    let captures = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === AttributionCapture) captures += 1;
    });
    expect(captures).toBe(1);
  });
});
