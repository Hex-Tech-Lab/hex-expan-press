"use client";

import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowIcon } from "../brand/brand";
import { ATTRIBUTION_KEYS } from "../../lib/attribution";
import { buyerEmailState, storedAttributionParams } from "../../lib/buyer-email";
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

const FIELD =
  "w-full rounded-2xl border border-[#dcc7b4] bg-white px-4 py-3 text-base text-gray-900 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]";

/**
 * Single-hop buyer email entry on pay.expanpress.com/checkout/[productId].
 * Raw SSR HTML keeps the submit button enabled (with HTML5 `required` + `buyer_email_confirm`) so native POST works
 * without JavaScript; once hydrated, the button disables until the email is valid and confirmed.
 * A probable typo is suggested with a one-click accept and is never applied silently. The consent box is checked by default.
 */
export function BuyerEmailStep({
  action = "/api/billing/checkout",
  productId,
  domains,
  maxEmailLength,
  consentText,
  initialAttribution = EMPTY_ATTRIBUTION,
}: BuyerEmailStepProps) {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
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

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Enter in a field can submit even when the button is disabled; the guard keeps an incomplete form from navigating.
    if (!state.canBuy) e.preventDefault();
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
          <input
            id="buyer-email"
            name="buyer_email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={showInvalid}
            aria-describedby="buyer-email-help"
            className={FIELD}
          />
          <p id="buyer-email-help" className="text-xs text-gray-600" role={showInvalid ? "alert" : undefined}>
            {showInvalid ? "Enter a complete email address, such as name@example.com." : "The download link is sent to this address."}
          </p>
          {state.suggestion && (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-gray-800">
              <span>Did you mean {state.suggestion}?</span>
              <button
                type="button"
                onClick={() => setEmail(state.suggestion ?? "")}
                className="rounded-full border border-[#dcc7b4] bg-white px-3 py-1 text-sm font-semibold text-gray-900 hover:bg-[#fff2e4] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]"
              >
                Use {state.suggestion}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="buyer-email-confirm" className="text-sm font-semibold text-gray-800">
            Confirm email
          </label>
          <input
            id="buyer-email-confirm"
            name="buyer_email_confirm"
            type="email"
            required
            autoComplete="off"
            inputMode="email"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={showMismatch}
            aria-describedby="buyer-email-confirm-help"
            className={FIELD}
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
            defaultChecked
            className="mt-1 h-4 w-4 shrink-0 accent-[#2A2A2A]"
          />
          <span>{consentText}</span>
        </label>

        <button
          type="submit"
          disabled={hydrated && !state.canBuy}
          data-checkout-slot="primary"
          data-checkout-mode="live"
          className="self-start inline-flex items-center gap-3 rounded-full bg-[#2A2A2A] hover:bg-[#383838] disabled:bg-[#9a9a9a] disabled:cursor-not-allowed text-white px-6 py-3.5 text-sm font-semibold transition-colors"
        >
          Buy now &mdash; secure checkout
          <ArrowIcon />
        </button>
      </form>
    </>
  );
}
