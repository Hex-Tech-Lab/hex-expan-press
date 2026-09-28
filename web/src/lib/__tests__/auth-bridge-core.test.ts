// Policy tests for the AuthBridge decision core (Wave 4 review hardening).
import { describe, it, expect } from "vitest";
import { decideBridgeAction } from "../auth-bridge-core";

describe("decideBridgeAction", () => {
  it("redirects to sign-in when no recoverable session exists", () => {
    const action = decideBridgeAction({ userPresent: false, hadCookie: false, hashHasToken: false });
    expect(action.redirectToSignin).toBe(true);
    expect(action.writeCookie).toBe(false);
    expect(action.refresh).toBe(false);
  });

  it("writes the cookie and refreshes on first establishment", () => {
    const action = decideBridgeAction({ userPresent: true, hadCookie: false, hashHasToken: false });
    expect(action.redirectToSignin).toBe(false);
    expect(action.writeCookie).toBe(true);
    expect(action.refresh).toBe(true);
    expect(action.stripHash).toBe(false);
  });

  it("strips the URL hash on OAuth/OTP returns", () => {
    const action = decideBridgeAction({ userPresent: true, hadCookie: false, hashHasToken: true });
    expect(action.stripHash).toBe(true);
    expect(action.writeCookie).toBe(true);
    expect(action.refresh).toBe(true);
  });

  it("does not refresh when the cookie was already present", () => {
    const action = decideBridgeAction({ userPresent: true, hadCookie: true, hashHasToken: false });
    expect(action.writeCookie).toBe(true);
    expect(action.refresh).toBe(false);
  });
});
