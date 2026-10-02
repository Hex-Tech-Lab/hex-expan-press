/**
 * Creator funnel E2E: sign-in → dashboard → manuscript review → C1/C2
 * consents → C3 e-sign hand-off → buyer page stays gated.
 *
 * Backend = e2e/mock-supabase.ts (server-side calls; see playwright.config.ts).
 * Browser-side external hops (the Firma signing page) use page.route().
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { E2E, MOCK_URL, APP_URL } from "./constants";

/** @supabase/ssr cookie format: "base64-" + base64url(JSON session). */
async function signInAsThrowawayCreator(context: BrowserContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: "e2e-access-token",
    refresh_token: "e2e-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: E2E.userId, email: E2E.email, aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: {} },
  };
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  await context.addCookies([{ name: "sb-portal-auth", value, url: APP_URL, httpOnly: true, sameSite: "Lax" }]);
}

async function rpcCalls(): Promise<{ fn: string; args: Record<string, unknown> }[]> {
  return (await fetch(`${MOCK_URL}/__calls`)).json();
}

test.beforeEach(async () => {
  await fetch(`${MOCK_URL}/__reset`, { method: "POST" });
});

test("creator funnel: sign in → review → consents → e-sign → gated buyer page", async ({ page, context }) => {
  // 1. Sign-in page: request a magic link (mocked OTP), then authenticate.
  await page.goto("/creator/signin");
  await page.fill("#email", E2E.email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/\/creator\/signin\?sent=1/);
  await signInAsThrowawayCreator(context);

  // 2. Dashboard.
  await page.goto("/creator/dashboard");
  await expect(page.getByRole("heading", { name: "Your creator dashboard" })).toBeVisible();

  // 3. Manuscript review: answer both items.
  await page.getByText("Open review stepper →").click();
  await expect(page).toHaveURL(/\/creator\/review/);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("radiogroup").getByLabel("Yes").check();
    await page.getByRole("button", { name: "Save & next" }).click();
    await expect(page.getByRole("button", { name: "Save & next" })).toBeEnabled();
  }
  await expect.poll(async () => (await rpcCalls()).filter((c) => c.fn === "submit_review_answer").length).toBe(2);

  // 4. Consents: sign C1 and C2 with a typed legal name.
  await page.goto("/creator/consents");
  for (const kind of ["C1_data_accuracy", "C2_release_approval"]) {
    await page.locator(`#typedName-${kind}`).fill("Eve Tester");
    await page.locator(`form:has(#typedName-${kind}) button[type=submit]`).click();
    await expect(page.locator(`#typedName-${kind}`)).toHaveCount(0); // card flips to "Signed ✓"
  }
  const consentCalls = (await rpcCalls()).filter((c) => c.fn === "submit_consent");
  expect(consentCalls.map((c) => c.args.p_kind)).toEqual(["C1_data_accuracy", "C2_release_approval"]);
  expect(consentCalls[1].args.p_document_sha256).toBe("ab".repeat(32)); // C2 binds to the release hash

  // 5. E-sign: the dashboard action creates an envelope (mock Firma API) and
  //    redirects the browser to Firma's signing page — intercepted here.
  await page.route("https://app.firma.dev/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Firma signing (mock)</h1>" }),
  );
  await page.goto("/creator/dashboard");
  await page.getByText("Review & sign agreement →").click();
  await expect(page).toHaveURL(`https://app.firma.dev/signing/${E2E.firmaRecipientId}`);
  expect((await rpcCalls()).some((c) => c.fn === "firma.create-and-send")).toBe(true);

  // 6. Buyer page: C3 is not signed → checkout stays gated, no Paddle.
  const paddleRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("paddle.com")) paddleRequests.push(r.url());
  });
  await page.goto("/c/retirearly500k/500k-playbook/");
  const buy = page.locator('[data-checkout-slot="primary"]');
  await expect(buy).toHaveAttribute("data-checkout-mode", "gated");
  await expect(buy).toBeVisible();
  expect(await page.content()).not.toContain("cdn.paddle.com");
  expect(paddleRequests).toEqual([]);
});
