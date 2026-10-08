// Sprint 18 A: the legacy Paddle decoder reads custom_data.reference_id (the
// field the checkout sets and the live adapter reads), with attribution_id as
// a pre-wiring fallback.
import { describe, expect, it } from "vitest";
import { cleanAttributionId, hmacSha256Hex } from "../src/provider.ts";
import { paddleProvider } from "../src/providers/paddle.ts";

const SECRET = "test-secret";

function parse(custom: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify({
    event_type: "transaction.completed",
    data: { id: "txn_1", currency_code: "USD", changed_at: 1, details: { totals: { total: 3900 } }, custom_data: { product_id: "p-1", email: "a@b.co", ...custom } },
  }));
  const ts = "1700000000";
  const h1 = hmacSha256Hex(SECRET, Buffer.from(`${ts}:${raw.toString("utf8")}`));
  const r = paddleProvider.parseWebhook({ "paddle-signature": `ts=${ts};h1=${h1}` }, raw, SECRET);
  if (!r.ok || !("sale" in r)) throw new Error(`expected a sale, got ${JSON.stringify(r)}`);
  return r.sale;
}

describe("paddle decoder attribution", () => {
  it("reads custom_data.reference_id", () => {
    const r = parse({ reference_id: "yt_desc:z9" });
    expect(r.attribution_id).toBe("yt_desc:z9");
  });
  it("prefers reference_id over the legacy attribution_id", () => {
    const r = parse({ reference_id: "new", attribution_id: "old" });
    expect(r.attribution_id).toBe("new");
  });
  it("falls back past an invalid reference_id to a valid attribution_id", () => {
    expect(parse({ reference_id: 42, attribution_id: "old" }).attribution_id).toBe("old");
  });
  it("falls back to custom_data.attribution_id", () => {
    const r = parse({ attribution_id: "old" });
    expect(r.attribution_id).toBe("old");
  });
  it("omits attribution when neither is set", () => {
    const r = parse({});
    expect("attribution_id" in r).toBe(false);
  });
});

describe("cleanAttributionId (buyer-controlled label)", () => {
  it.each([
    ["yt_desc", "yt_desc"],
    ["yt_desc:z9", "yt_desc:z9"],
    ["a:b:c", undefined],
    ["x".repeat(65), undefined],
    ["<img onerror=1>", undefined],
    ["", undefined],
    [42, undefined],
  ])("%j -> %j", (raw, want) => {
    expect(cleanAttributionId(raw)).toBe(want);
  });
  it("drops a forged label without rejecting the paid sale", () => {
    const r = parse({ reference_id: "'; drop table orders; --" });
    expect("attribution_id" in r).toBe(false);
  });
});
