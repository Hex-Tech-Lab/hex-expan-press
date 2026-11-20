"use client";

import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowIcon, BrandButton, BrandField } from "../brand/brand";
import { ATTRIBUTION_KEYS } from "../../lib/attribution";
import { buyerEmailState, storedAttributionParams } from "../../lib/buyer-email";
import { openPaddleOverlay, type PaddleOverlayClient, type PaddleOverlayPayload } from "../../lib/paddle-overlay";
import { AttributionCapture } from "./buy-link";

interface BuyerEmailStepProps {
  /** The checkout API route URL on pay.expanpress.com. The form submits here via POST. */
  action?: string;
  /** Product UUID submitted in the hidden `product` field. */
  productId: string;
  /** Typo-check domains (settings registry: email_address.typo_domains). */
  domains: string[];
  /** Email length ceiling (settings registry: email_address.max_length). */
  maxEmailLength: number;
  /** The consent line, built from the registry's delivery promise (see buyerConsentText). */
  consentText: string;
  /** Server-read attribution parameters from searchParams so SSR / no-JS POST preserves attribution. */
  initialAttribution?: Record<string, string>;
  /** Non-null on pay.expanpress.com when the product's Paddle overlay configuration is ready; null falls back to form POST redirect. */
  paddleClient?: PaddleOverlayClient | null;
}

const EMPTY_ATTRIBUTION: Record<string, string> = {};

/** sessionStorage writes happen in AttributionCapture on mount; nothing else changes it in-page. */
function subscribeNever(): () => void {
  return () => {};
}

/**
 * The attribution stored for this visit, as a JSON string (a stable snapshot), falling back to
 * window.location.search so direct arrivals or blocked-storage browsers retain ?src / ?dub_id.
 */
function readAttributionSnapshot(): string {
  const qs = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  return JSON.stringify(
    storedAttributionParams((key, param) => {
      try {
        const stored = sessionStorage.getItem(key);
        if (stored) return stored;
      } catch {
        /* storage blocked: fall back to URL search */
      }
      return qs?.get(param) ?? null;
    }, ATTRIBUTION_KEYS),
  );
}

type CheckoutJsonResponse =
  | { ok: true; kind: "paddle_overlay"; payload: PaddleOverlayPayload }
  | { ok: true; kind: "redirect"; redirectUrl: string }
  | { ok: false; error?: string };

/**
 * Single-hop buyer email entry on pay.expanpress.com/checkout/[productId].
 * Raw SSR HTML keeps the submit button enabled (with HTML5 `required` + `buyer_email_confirm`) so native POST works
 * without JavaScript; once hydrated, the button disables until the email is valid and confirmed.
 * When `paddleClient` is configured, submitting requests the overlay payload and opens Paddle.js on pay.expanpress.com
 * (falling back to `window.location.assign` when the server routes another provider's redirect URL).
 * A probable typo is suggested with a one-click accept and is never applied silently. The consent box is checked by default.
 */
export function BuyerEmailStep({
  action = "/api/billing/checkout",
  productId,
  domains,
  maxEmailLength,
  consentText,
  initialAttribution = EMPTY_ATTRIBUTION,
  paddleClient = null,
}: BuyerEmailStepProps) {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [consent, setConsent] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const serverAttribution = useMemo(() => JSON.stringify(initialAttribution), [initialAttribution]);
  const attributionSnapshot = useSyncExternalStore(subscribeNever, readAttributionSnapshot, () => serverAttribution);
  const attribution = useMemo(() => {
    const clientAttr = JSON.parse(attributionSnapshot) as Record<string, string>;
    return { ...initialAttribution, ...clientAttr };
  }, [initialAttribution, attributionSnapshot]);

  const state = buyerEmailState(email, confirm, { domains, maxLength: maxEmailLength });
  const showInvalid = email.trim() !== "" && !state.valid;
  const showMismatch = confirm.trim() !== "" && !state.matches;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    // Enter in a field can submit even when the button is disabled; the guard keeps an incomplete form from navigating.
    if (!state.canBuy) {
      event.preventDefault();
      return;
    }
    if (!paddleClient) return;
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(action, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          product: productId,
          buyer_email: email.trim(),
          buyer_email_confirm: confirm.trim(),
          buyer_consent: consent,
          ...attribution,
        }),
      });
      const data = (await res.json().catch(() => null)) as CheckoutJsonResponse | null;
      if (!res.ok || !data || !data.ok) {
        setErrorMessage((data && !data.ok && data.error) || "Checkout could not be started. Please try again.");
        return;
      }
      if (data.kind === "paddle_overlay") {
        await openPaddleOverlay(paddleClient, data.payload);
        return;
      }
      if (data.kind === "redirect" && typeof data.redirectUrl === "string") {
        window.location.assign(data.redirectUrl);
        return;
      }
      setErrorMessage("Checkout could not be started. Please try again.");
    } catch (err) {
      console.error("[buyer-email-step] checkout failed:", err instanceof Error ? err.message : String(err));
      setErrorMessage("Checkout could not be opened. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <AttributionCapture />
      <form method="post" action={action} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate={hydrated}>
        <input type="hidden" name="product" value={productId} />
        {Object.entries(attribution).map(([param, value]) => (
          <input key={param} type="hidden" name={param} value={value} />
        ))}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="buyer-email" className="text-sm font-semibold text-gray-800">
            Email for your download link
          </label>
          <BrandField
            id="buyer-email"
            name="buyer_email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={showInvalid}
            aria-describedby="buyer-email-help"
          />
          <p id="buyer-email-help" className="text-xs text-gray-600" role={showInvalid ? "alert" : undefined}>
            {showInvalid ? "Enter a complete email address, such as name@example.com." : "The download link is sent to this address."}
          </p>
          {state.suggestion && (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-gray-800">
              <span>Did you mean {state.suggestion}?</span>
              <BrandButton variant="secondary" type="button" onClick={() => setEmail(state.suggestion ?? "")}>
                Use {state.suggestion}
              </BrandButton>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="buyer-email-confirm" className="text-sm font-semibold text-gray-800">
            Confirm email
          </label>
          <BrandField
            id="buyer-email-confirm"
            name="buyer_email_confirm"
            type="email"
            required
            autoComplete="off"
            inputMode="email"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={showMismatch}
            aria-describedby="buyer-email-confirm-help"
          />
          <p id="buyer-email-confirm-help" className="text-xs text-gray-600" role={showMismatch ? "alert" : undefined}>
            {showMismatch ? "The two email addresses do not match yet." : "Type the same address again. Checkout starts when both match."}
          </p>
        </div>

        <label className="flex items-start gap-3 text-sm text-gray-700 leading-relaxed">
          <input
            type="checkbox"
            name="buyer_consent"
            value="true"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-[#2A2A2A]"
          />
          <span>{consentText}</span>
        </label>

        {errorMessage && (
          <p role="alert" className="text-sm text-red-700">
            {errorMessage}
          </p>
        )}

        <BrandButton
          type="submit"
          disabled={(hydrated && !state.canBuy) || submitting}
          data-checkout-slot="primary"
          data-checkout-mode="live"
        >
          Buy now &mdash; secure checkout
          <ArrowIcon />
        </BrandButton>
      </form>
    </>
  );
}
