"use client";

/**
 * Paddle overlay checkout button (ADR-0050). Initializes Paddle.js on mount
 * ONLY after the environment/token gate resolves (never initialize with a
 * guessed environment), then opens the overlay with the customData fields
 * the webhook adapter REQUIRES: custom_data.product_id + custom_data.email
 * (the adapter 400s a sale without them, so the button refuses to open
 * checkout when it cannot supply both).
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

  useEffect(() => {
    if (!envCheck.ok || token === null) {
      console.error(unavailableReason ?? "Paddle checkout unavailable");
      return;
    }
    let cancelled = false;
    void initializePaddle({ token, environment: envCheck.env }).then((instance) => {
      if (!cancelled && instance) setPaddle(instance);
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

  const disabled = unavailableReason !== null || paddle === null;

  return (
    <button
      type="button"
      onClick={openCheckout}
      disabled={disabled}
      className={`min-h-11 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]${className ? ` ${className}` : ""}`}
    >
      {unavailableReason !== null ? "Checkout unavailable" : children}
    </button>
  );
}