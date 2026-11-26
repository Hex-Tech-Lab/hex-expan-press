"use client";

/**
 * Opens Paddle's checkout for one transaction on the pay host (`/checkout?_ptxn=txn_...`).
 * Paddle's default checkout URL sends the buyer here with a transaction id, so this
 * component does not choose a price or product; Paddle already did that when the
 * transaction was created. It uses the same fail-closed environment gate as the
 * product button: sandbox is refused on a production build.
 */

import { useEffect, useMemo, useState } from "react";
import { initializePaddle } from "@paddle/paddle-js";
import type { Paddle } from "@paddle/paddle-js";
import { paddleClientToken, resolvePaddleEnvironment } from "../../lib/paddle-env";

export function PaddleTransactionCheckout({ transactionId }: { transactionId: string }) {
  const { envCheck, token } = useMemo(() => {
    const check = resolvePaddleEnvironment();
    return { envCheck: check, token: check.ok ? paddleClientToken() : null };
  }, []);

  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!envCheck.ok) {
      setFailure(envCheck.reason);
      return;
    }
    if (token === null) {
      setFailure("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not configured");
      return;
    }
    let cancelled = false;
    void initializePaddle({ token, environment: envCheck.env })
      .then((instance) => {
        if (cancelled) return;
        if (instance) {
          setPaddle(instance);
          instance.Checkout.open({ transactionId });
        } else {
          setFailure("Paddle checkout failed to load");
        }
      })
      .catch(() => {
        if (!cancelled) setFailure("Paddle checkout failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [envCheck, token, transactionId]);

  if (failure !== null) {
    return <p role="alert">Checkout is unavailable: {failure}.</p>;
  }
  return <p aria-live="polite">{paddle ? "Opening secure checkout…" : "Loading secure checkout…"}</p>;
}
