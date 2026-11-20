"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "@iconify/react";
import { BrandButton, BrandField, BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import { loadLucideIcons } from "../../../src/lib/iconify-lucide";
import { AppleIcon, GoogleIcon } from "./icons";
import { signInWithGoogleAction, signInWithOtpAction, setMarketingOptInAction } from "./actions";

export type SignInMode = "form" | "sent" | "error";

function GoogleSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <BrandButton type="submit" disabled={pending} className="mb-3 min-h-11 w-full justify-center text-base">
      <GoogleIcon />
      {pending ? "Connecting to Google…" : "Continue with Google"}
    </BrandButton>
  );
}

function OtpSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <BrandButton type="submit" disabled={pending} className="min-h-11 shrink-0 self-auto text-base">
      {pending ? "Sending…" : "Send link"}
    </BrandButton>
  );
}

/**
 * Client surface for the creator sign-in page (Wave 5, unified with BrandFrame/BrandButton/BrandField).
 * All auth submits go through Server Actions — no token ever touches client JS.
 */
export default function SignInClient({
  mode,
  message,
  optinDefault,
  supportEmail,
}: {
  mode: SignInMode;
  message?: string;
  optinDefault: boolean;
  supportEmail?: string;
}) {
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    void loadLucideIcons().then(() => {
      if (mounted) setIconsReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/" label="ExpanPress home" />
      </header>

      <main className="mx-auto w-full max-w-[580px] flex flex-col gap-6">
        <div>
          <p className="mb-2 text-[11px] sm:text-xs font-mono font-medium uppercase tracking-[0.16em] text-gray-600">
            Account
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold leading-[1.15] tracking-tight text-gray-900">
            Sign in
          </h1>
          <p className="mt-2 text-base text-gray-700">Access your books and account details.</p>
        </div>

        {mode === "sent" ? (
          <div className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8">
            <p className="text-base font-semibold text-[#296E50]" role="status">
              Check your inbox — we sent you a sign-in link. It expires shortly, so use it soon.
            </p>
          </div>
        ) : (
          <div className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8">
            <form action={signInWithGoogleAction}>
              <GoogleSubmitButton />
            </form>

            <BrandButton
              variant="secondary"
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Continue with Apple — coming soon"
              className="min-h-11 w-full justify-center py-3 text-base"
            >
              <AppleIcon />
              Continue with Apple
            </BrandButton>
            <p className="mt-2 text-xs text-gray-600">
              Sign in with Apple is coming soon — use Google or an email link for now.
            </p>

            <div
              className="my-5 flex items-center gap-3 text-xs text-gray-600 before:flex-1 before:border-t before:border-[#dcc7b4] after:flex-1 after:border-t after:border-[#dcc7b4]"
              aria-hidden
            >
              or
            </div>

            <form action={signInWithOtpAction} className="contents">
              <label htmlFor="email" className="mb-2 block text-sm font-semibold text-gray-900">
                Email me a sign-in link
              </label>
              <div className="flex flex-wrap gap-2.5">
                <BrandField
                  type="email"
                  id="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  required
                  className="min-h-11 min-w-0 flex-[1_1_240px]"
                />
                <OtpSubmitButton />
              </div>
            </form>

            {mode === "error" && message ? (
              <p className="mt-3.5 text-sm font-semibold text-[#b3401e]" role="alert">
                {message}
              </p>
            ) : null}

            <form action={setMarketingOptInAction}>
              <div className="mb-2 mt-5 flex items-start gap-3">
                <input
                  type="checkbox"
                  id="optin"
                  name="optin"
                  defaultChecked={optinDefault}
                  className="mt-0.5 h-6 w-6 flex-[0_0_auto] accent-[#E8622C]"
                />
                <label htmlFor="optin" className="text-sm font-normal text-gray-700">
                  Remember my preference for updates (stored in a cookie on this device; no marketing emails are sent yet)
                </label>
              </div>
              <BrandButton variant="secondary" type="submit" className="px-4 py-2 text-xs">
                {iconsReady && <Icon icon="lucide:check" width={16} height={16} aria-hidden />}
                Save preference
              </BrandButton>
            </form>
          </div>
        )}
      </main>

      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">
          Privacy Policy
        </a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">
          Terms of Service
        </a>
        {supportEmail ? <span>{supportEmail}</span> : null}
      </BrandFooter>
    </BrandFrame>
  );
}
