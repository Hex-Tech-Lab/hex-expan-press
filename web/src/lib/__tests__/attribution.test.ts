// Sprint 18 A: one attribution shape for every provider; Paddle carries it in
// the overlay customData (custom_data.reference_id), Polar in the link query.
import { afterEach, describe, expect, it, vi } from "vitest";
import { attributionRef, storedAttributionRef } from "../attribution";
import { paddleCustomData } from "../../components/billing/paddle-checkout-button";

const from = (m: Record<string, string>) => (p: "src" | "dub_id") => m[p] ?? null;

function stubSession(m: Record<string, string>) {
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => m[k] ?? null });
}

afterEach(() => vi.unstubAllGlobals());

describe("attributionRef", () => {
  it.each([
    [{}, "direct"],
    [{ src: "yt_desc" }, "yt_desc"],
    [{ src: "yt_desc", dub_id: "abc.1" }, "yt_desc:abc.1"],
    [{ dub_id: "abc" }, "direct:abc"],
    [{ src: "<script>", dub_id: "a b" }, "direct"],
    [{ src: "x".repeat(65) }, "direct"],
  ])("%j -> %s", (m, want) => {
    expect(attributionRef(from(m))).toBe(want);
  });
});

describe("storedAttributionRef", () => {
  it("reads the storefront capture keys", () => {
    stubSession({ ep_src: "ig_bio", ep_dub_id: "d1" });
    expect(storedAttributionRef()).toBe("ig_bio:d1");
  });
  it("falls back to direct when storage throws", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(storedAttributionRef()).toBe("direct");
  });
});

describe("Paddle overlay custom_data payload", () => {
  it("carries product_id, reference_id and email", () => {
    stubSession({ ep_src: "yt_desc", ep_dub_id: "z9" });
    expect(paddleCustomData("p-1", "a@b.co")).toEqual({ product_id: "p-1", reference_id: "yt_desc:z9", email: "a@b.co" });
  });
  it("drops unsafe captured values and omits a missing email", () => {
    stubSession({ ep_src: "javascript:alert(1)" });
    expect(paddleCustomData("p-1")).toEqual({ product_id: "p-1", reference_id: "direct" });
  });
});
