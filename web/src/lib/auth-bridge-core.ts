/**
 * AuthBridge decision core (Wave 4 review hardening) — pure, testable logic
 * for the client-side session→cookie handshake. The React component applies
 * the returned action; this module owns the policy.
 *
 * Policy:
 *   - No recoverable session (user absent after bounded getUser retries) →
 *     redirect to sign-in.
 *   - Session present → (re)assert the sb_session cookie.
 *   - OAuth/OTP hash return → strip sensitive tokens from the URL.
 *   - Cookie was missing → refresh the route so the RSC hydrates with it.
 */

export interface BridgeState {
  userPresent: boolean;
  hadCookie: boolean;
  hashHasToken: boolean;
}

export interface BridgeAction {
  redirectToSignin: boolean;
  writeCookie: boolean;
  stripHash: boolean;
  refresh: boolean;
}

export function decideBridgeAction(state: BridgeState): BridgeAction {
  if (!state.userPresent) {
    return { redirectToSignin: true, writeCookie: false, stripHash: false, refresh: false };
  }
  return {
    redirectToSignin: false,
    writeCookie: true,
    stripHash: state.hashHasToken,
    refresh: !state.hadCookie,
  };
}
