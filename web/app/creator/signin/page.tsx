import { readMarketingOptIn } from "../../../src/lib/marketing-optin";
import SignInClient from "./signin-client";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in · ExpanPress",
};

export interface SignInPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Creator sign-in (Wave 5): App Router page replacing the legacy static HTML. */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const optinCookie = await readMarketingOptIn();

  if (firstValue(params.sent) === "1") {
    return <SignInClient mode="sent" optinDefault={optinCookie ?? false} />;
  }
  if (firstValue(params.error) === "invalid_email") {
    return <SignInClient mode="error" message="Please enter a valid email address." optinDefault={optinCookie ?? false} />;
  }
  if (firstValue(params.error) === "otp") {
    return <SignInClient mode="error" message="Could not send the email. Please try again." optinDefault={optinCookie ?? false} />;
  }
  if (firstValue(params.error) === "rate_limited") {
    return (
      <SignInClient
        mode="error"
        message="Too many sign-in emails were requested. Please wait a minute and try again."
        optinDefault={optinCookie ?? false}
      />
    );
  }
  if (firstValue(params.error) === "oauth") {
    return (
      <SignInClient
        mode="error"
        message="Google sign-in could not start. Please try again, or use the email link below."
        optinDefault={optinCookie ?? false}
      />
    );
  }
  if (firstValue(params.error) === "auth") {
    return (
      <SignInClient
        mode="error"
        message="Sign-in link expired or was already used. Please request a new one."
        optinDefault={optinCookie ?? false}
      />
    );
  }
  return <SignInClient mode="form" optinDefault={optinCookie ?? false} />;
}
