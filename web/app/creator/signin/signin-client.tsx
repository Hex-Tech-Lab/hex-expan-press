"use client";

import { Icon } from "@iconify/react";
import { AppleIcon, GoogleIcon } from "./icons";
import { signInWithGoogleAction, signInWithOtpAction, setMarketingOptInAction } from "./actions";

export type SignInMode = "form" | "sent" | "error";

/**
 * Client surface for the creator sign-in page (Wave 5). Mirrors the legacy
 * static signin HTML (Google button, Apple "coming soon" dialog, email-OTP
 * form, marketing opt-in). All auth submits go through Server Actions —
 * no token ever touches client JS.
 */
export default function SignInClient({
  mode,
  message,
  optinDefault,
}: {
  mode: SignInMode;
  message?: string;
  optinDefault: boolean;
}) {
  return (
    <div className="mx-auto max-w-[640px] px-5 pb-10 pt-14 font-sans text-[#2B2520]">
      <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#B3401E]">Account</p>
      <h1 className="font-serif text-[34px] font-bold leading-[1.15] tracking-[-0.015em] max-md:text-[27px]">
        Sign in
      </h1>
      <p className="mb-7 mt-2.5 text-[16.5px] text-[#6E5F53]">Access your guides and account details.</p>

      {mode === "sent" ? (
        <div className="rounded-[14px] border border-[#EADFD1] bg-[#FFFDF9] p-[26px]">
          <p className="text-[16.5px] font-semibold text-[#296E50]" role="status">
            Check your inbox — we sent you a sign-in link. It expires shortly, so use it soon.
          </p>
        </div>
      ) : (
        <div className="rounded-[14px] border border-[#EADFD1] bg-[#FFFDF9] px-[26px] pb-[22px] pt-[26px] max-md:px-[18px] max-md:py-[16px]">
          <form action={signInWithGoogleAction}>
            <button
              type="submit"
              className="mb-3 flex min-h-11 w-full items-center justify-center gap-2.5 rounded-[10px] border border-[#2B2520] bg-[#2B2520] px-5 py-2.5 text-lg font-semibold text-[#FAF5EE] hover:bg-[#3d352d] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] focus-visible:outline-offset-2"
            >
              <GoogleIcon />
              Continue with Google
            </button>
          </form>

          <button
            type="button"
            aria-haspopup="dialog"
            aria-label="Continue with Apple — coming soon"
            className="mb-0 flex min-h-11 w-full items-center justify-center gap-2.5 rounded-[10px] border border-[#2B2520] bg-[#FFFDF9] px-5 py-2.5 text-lg font-semibold text-[#2B2520] hover:bg-[#F3ECDF] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] focus-visible:outline-offset-2"
          >
            <AppleIcon />
            Continue with Apple
          </button>
          <p className="mt-2 text-[13px] text-[#6E5F53]">Sign in with Apple is coming soon — use Google or an email link for now.</p>

          <div className="my-[18px] flex items-center gap-3 text-[13px] text-[#6E5F53] before:flex-1 before:border-t before:border-[#EADFD1] after:flex-1 after:border-t after:border-[#EADFD1]" aria-hidden>
            or
          </div>

          <form action={signInWithOtpAction} className="contents">
            <label htmlFor="email" className="mb-2 block text-base font-semibold">
              Email me a sign-in link
            </label>
            <div className="flex flex-wrap gap-2.5">
              <input
                type="email"
                id="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                required
                className="min-h-11 min-w-0 flex-[1_1_240px] rounded-[10px] border border-[#EADFD1] bg-white px-3.5 py-2.5 text-lg text-[#2B2520] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] focus-visible:outline-offset-2"
              />
              <button
                type="submit"
                className="flex-[0_0_auto] rounded-[10px] border border-[#2B2520] bg-[#2B2520] px-[22px] py-2.5 text-lg font-semibold text-[#FAF5EE] hover:bg-[#3d352d] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] focus-visible:outline-offset-2"
              >
                Send link
              </button>
            </div>
          </form>

          {mode === "error" && message ? (
            <p className="mt-3.5 text-[16.5px] font-semibold text-[#B3401E]" role="alert">
              {message}
            </p>
          ) : null}

          <form action={setMarketingOptInAction}>
            <div className="mb-1.5 mt-[18px] flex items-start gap-3">
              <input
                type="checkbox"
                id="optin"
                name="optin"
                defaultChecked={optinDefault}
                className="mt-1 h-[26px] w-[26px] flex-[0_0_auto] accent-[#E8622C]"
              />
              <label htmlFor="optin" className="text-base font-normal">
                Send me occasional emails about new guides and tools (you can unsubscribe anytime)
              </label>
            </div>
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#6E5F53] hover:bg-[#F3ECDF] hover:text-[#2B2520] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:check" width={16} height={16} aria-hidden />
              Save preference
            </button>
          </form>
        </div>
      )}

      <footer className="mt-7 flex flex-wrap items-center gap-x-[22px] gap-y-2 border-t border-[#EADFD1] pt-[22px] text-[13px] text-[#6E5F53]">
        <a href="/privacy.html" className="text-[#296E50] hover:underline">
          Privacy Policy
        </a>
        <span className="text-[#CBB3A7]">&middot;</span>
        <a href="/terms.html" className="text-[#296E50] hover:underline">
          Terms of Service
        </a>
      </footer>
    </div>
  );
}
