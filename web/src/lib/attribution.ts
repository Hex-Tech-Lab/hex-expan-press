// Canonical attribution reference (Sprint 17 P3 / Sprint 18 A): the storefront
// captures ?src / ?dub_id; providers receive reference_id=<src>[:<dub_id>]
// (Polar: checkout-link query → metadata.reference_id; Paddle: overlay
// customData → custom_data.reference_id). Unsafe values are dropped, never
// forwarded. One shape for every provider so webhooks decode one field.
const ATTRIBUTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** sessionStorage keys the storefront capture writes (buy-link.tsx). */
export const ATTRIBUTION_KEYS = { src: "ep_src", dub_id: "ep_dub_id" } as const;

export function attributionRef(get: (param: "src" | "dub_id") => string | null): string {
  const clean = (v: string | null) => (v && ATTRIBUTION_RE.test(v) ? v : "");
  const src = clean(get("src")) || "direct";
  const dubId = clean(get("dub_id"));
  return dubId ? `${src}:${dubId}` : src;
}

/** Client-side: the reference from the captured session values; "direct" when unavailable. */
export function storedAttributionRef(): string {
  try {
    return attributionRef((p) => sessionStorage.getItem(ATTRIBUTION_KEYS[p]));
  } catch {
    return "direct"; // storage blocked: attribution must never block checkout
  }
}
