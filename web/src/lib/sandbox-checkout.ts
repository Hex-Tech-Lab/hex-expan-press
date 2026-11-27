import { GLOBAL, isNonProductionRuntime } from "../../../payments/src/settings_registry";

/**
 * Sandbox checkout rule, the single source for the buyer surfaces and the checkout route. The product page, the checkout
 * page, the storefront cards and the route all ask this function, so a sandbox product shows its buy form exactly when the
 * route will accept it.
 *
 * Non-production runtimes only (preview, development, or a local dev or test process), and only when
 * payments.sandbox_checkout_enabled is true (set per preview with SANDBOX_CHECKOUT_ENABLED, see settings_registry).
 */
export function sandboxAllowed(): boolean {
  if (!isNonProductionRuntime()) return false;
  return GLOBAL.payments?.sandbox_checkout_enabled === true;
}
