"use client";

/**
 * Paddle overlay checkout button (ADR-0050). Initializes Paddle.js on mount
 * ONLY after the environment/token gate resolves (never initialize with a
 * guessed environment), then opens the overlay with the customData fields
 * the webhook adapter uses: custom_data.product_id (required) and, when the
 * page already knows it, custom_data.email. Without an email the buyer types
 * it in the overlay and the adapter resolves it from the Paddle customer.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { initializePaddle } from "@paddle/paddle-js";
import type { Paddle } from "@paddle/paddle-js";
import { paddleClientToken, resolvePaddleEnvironment } from "../../lib/paddle-env";

interface PaddleCheckoutButtonProps {
  priceId: string;
  productId: string;
  email?: string;
  children?: ReactNode;
  className?: string;
}

export function PaddleCheckoutButton({ priceId, productId, email, children = "Buy now", className }: PaddleCheckoutButtonProps) {
  // NEXT_PUBLIC_* values are build-time inlined: resolve once, never guess.
  const { envCheck, token } = useMemo(
    () => {
      const check = resolvePaddleEnvironment();
      return { envCheck: check, token: check.ok ? paddleClientToken() : null };
    },
    [],
  );

  const unavailableReason = !envCheck.ok
    ? envCheck.reason
    : token === null
      ? "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not configured"
      : null;

  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [loadFailedReason, setLoadFailedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!envCheck.ok || token === null) {
      console.error(unavailableReason ?? "Paddle checkout unavailable");
      return;
    }
    let cancelled = false;
    void initializePaddle({ token, environment: envCheck.env })
      .then((instance) => {
        if (cancelled) return;
        if (instance) setPaddle(instance);
        else {
          const reason = "Paddle checkout failed to load";
          console.error(reason);
          setLoadFailedReason(reason);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const reason = "Paddle checkout failed to load";
        console.error(reason, err);
        setLoadFailedReason(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [envCheck, token, unavailableReason]);

  const openCheckout = () => {
    if (!paddle) return;
    paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customData: { product_id: productId, ...(email ? { email } : {}) },
      ...(email ? { customer: { email } } : {}),
    });
  };

  const unavailable = unavailableReason ?? loadFailedReason;

  const disabled = unavailable !== null || paddle === null;

  return (
    <button
      type="button"
      onClick={openCheckout}
      disabled={disabled}
      className={`min-h-11 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]${className ? ` ${className}` : ""}`}
    >
      {unavailable !== null ? "Checkout unavailable" : children}
    </button>
  );
}