/**
 * Creator funnel E2E: sign-in → dashboard → manuscript review → C1/C2
 * consents → C3 e-sign hand-off → buyer page stays gated.
 *
 * Backend = e2e/mock-supabase.ts (server-side calls; see playwright.config.ts).
 * Browser-side external hops (the Firma signing page) use page.route().
 */
import { test, expect } from "@playwright/test";
import { E2E, MOCK_URL } from "./constants";

async function rpcCalls(): Promise<{ fn: string; args: Record<string, unknown> }[]> {
  return (await fetch(`${MOCK_URL}/__calls`)).json();
}

test.beforeEach(async () => {
  await fetch(`${MOCK_URL}/__reset`, { method: "POST" });
});

test("creator funnel: sign in → review → consents → e-sign → gated buyer page", async ({ page }) => {
  // 1. Sign-in: request a magic link (mock OTP), then follow the emailed link
  //    through /auth/callback (verifyOtp → @supabase/ssr session cookie).
  await page.goto("/creator/signin");
  await page.fill("#email", E2E.email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/\/creator\/signin\?sent=1/);
  await page.goto(`/auth/callback?token_hash=${E2E.magicLinkTokenHash}&type=magiclink`);

  // 2. Dashboard (the callback redirects here once the session cookie is set).
  await expect(page).toHaveURL(/\/creator\/dashboard/);
  await expect(page.getByRole("heading", { name: "Your creator dashboard" })).toBeVisible();

  // 3. Manuscript review: answer both items.
  await page.getByText("Open review stepper →").click();
  await expect(page).toHaveURL(/\/creator\/review/);
  for (const code of ["Q1", "Q2"]) {
    // The stepper advances ~500ms after a save — wait for THIS question first.
    const options = page.getByRole("radiogroup", { name: `Options for ${code}` });
    await expect(options).toBeVisible();
    await options.getByLabel("Yes").check();
    await page.getByRole("button", { name: "Save & next" }).click();
  }
  await expect(page.getByRole("heading", { name: "Every answer is saved and logged" })).toBeVisible();
  // Two answers for two DIFFERENT items — catches a stepper that never advances.
  await expect
    .poll(async () => (await rpcCalls()).filter((c) => c.fn === "submit_review_answer").map((c) => c.args.item_id).sort())
    .toEqual(["11111111-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000002"]);

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

  // 6. Buyer page. Buyer pages are static artifacts: the consent gate runs at
  //    BUILD time (payments/bake_checkout.ts bakes "gated" unless C1/C2/C3 are
  //    signed — unit-tested in payments/test/bake_checkout_run.test.ts), so no
  //    runtime route reads consents. This asserts the shipped artifact is gated
  //    and loads no Paddle code.
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
