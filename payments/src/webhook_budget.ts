/**
 * One overall deadline per webhook request (payments.webhook_total_budget_ms, counted from the request start).
 * The sale write is never raced against it. The buyer-email lookup, the download link and the receipt send take only
 * the time left, so the answer goes out before Paddle's own answer limit. Wall-clock by design: this bounds the real request.
 */
import { GLOBAL } from "./settings_registry.ts";

/** Absolute epoch-ms deadline for a request that starts at `now`. Fails loudly when the registry key is missing (fail closed). */
export function webhookDeadlineAt(now: number = Date.now()): number {
  const budget = GLOBAL.payments.webhook_total_budget_ms;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("billing-webhook: missing payments.webhook_total_budget_ms in settings registry");
  }
  return now + budget;
}

/** Milliseconds left before `deadlineAt`, never negative. */
export const budgetLeftMs = (deadlineAt: number, now: number = Date.now()): number => Math.max(0, deadlineAt - now);

/**
 * Races `work` against the request deadline. Past it, the result rejects with `onExpired()`. `work` is NOT aborted: it may still
 * complete, and a provider retry then takes the duplicate path, which resends the stored message under the same idempotency key.
 */
export function settleByDeadline<T>(work: Promise<T>, deadlineAt: number, onExpired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onExpired()), budgetLeftMs(deadlineAt));
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * The request's abort signal, firing at the deadline. Every Supabase query on the webhook path takes it, so a hung query is cut
 * at the budget and cannot hold the response or the sale lock. Undefined when the caller set no deadline.
 */
export function requestSignal(deadlineAt: number | undefined): AbortSignal | undefined {
  return deadlineAt === undefined ? undefined : AbortSignal.timeout(budgetLeftMs(deadlineAt));
}

/** Applies the request signal to a Supabase query builder (postgrest `abortSignal`) when there is one. */
export function bounded<B extends { abortSignal(signal: AbortSignal): B }>(query: B, signal: AbortSignal | undefined): B {
  return signal === undefined ? query : query.abortSignal(signal);
}
