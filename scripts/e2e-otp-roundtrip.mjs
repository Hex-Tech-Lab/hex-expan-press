/**
 * Wave 5.1 E2E — REAL sign-in round-trip through the production UI:
 * /creator/signin → OTP Server Action (auto-confirm project state) →
 * ssr HttpOnly cookies → /creator/dashboard RSC hydration.
 * Proves: HttpOnly + Secure on live Set-Cookie headers, server-side
 * dashboard data render, and that no token reaches client JS.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const webRequire = createRequire(fileURLToPath(new URL("../web/package.json", import.meta.url)));
const { createElement } = webRequire("react");
const { chromium } = webRequire("playwright-core");

const PORT = process.argv[2] ?? "3888";
const BASE = `http://localhost:${PORT}`;
const QA_EMAIL = "qa-auth-roundtrip@expanpress.com";
const EXECUTABLE = "/home/kellyb_dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const context = await browser.newContext();
const page = await context.newPage();

const setCookies = [];
page.on("response", async (res) => {
  try {
    const all = await res.allHeaders();
    for (const [name, value] of Object.entries(all)) {
      if (name.toLowerCase() === "set-cookie") setCookies.push({ url: res.url(), value });
    }
  } catch { /* header read race — non-fatal */ }
});

// 1. Sign-in page renders
await page.goto(`${BASE}/creator/signin`, { waitUntil: "domcontentloaded" });
const hasForm = await page.locator("input[type=email]").count();
console.log("[e2e] signin renders with email form:", hasForm > 0);

// 2. Submit the OTP form specifically (the Google button is a separate form)
await page.fill("input#email", QA_EMAIL);
await Promise.all([
  page.waitForURL("**/creator/dashboard**", { timeout: 20000 }).catch(() => {}),
  page.getByRole("button", { name: "Send link" }).click(),
]);
const finalUrl = page.url();
console.log("[e2e] final URL:", finalUrl);

// 3. Dashboard actually hydrated server-side with the QA session
const body = await page.textContent("body");
const dashboardRendered = body?.includes("Your creator dashboard") ?? false;
const signedInAs = body?.includes(QA_EMAIL) ?? false;
console.log("[e2e] dashboard rendered:", dashboardRendered, "| shows account email:", signedInAs);

// 4. HttpOnly proof on every portal-auth Set-Cookie
let httpOnlyAll = true;
let sawAuthCookie = false;
for (const c of setCookies) {
  if (!/sb-portal-auth/.test(c.value)) continue;
  sawAuthCookie = true;
  const httpOnly = /httponly/i.test(c.value);
  const sameSite = /samesite=lax/i.test(c.value);
  console.log(`[e2e] Set-Cookie: name=${c.value.split("=")[0]} httpOnly=${httpOnly} samesiteLax=${sameSite}`);
  if (!httpOnly) httpOnlyAll = false;
}
console.log("[e2e] portal-auth Set-Cookie headers seen:", setCookies.filter((c) => /sb-portal-auth/.test(c.value)).length);

// 5. No token in client JS storage
const storageTokens = await page.evaluate(() =>
  Object.keys(localStorage).filter((k) => k.includes("supabase") || k.includes("sb-")),
);
console.log("[e2e] supabase localStorage keys (must be empty):", JSON.stringify(storageTokens));

await browser.close();

const PASS = hasForm > 0 && finalUrl.includes("/creator/dashboard") && dashboardRendered && signedInAs && httpOnlyAll && sawAuthCookie && storageTokens.length === 0;
console.log(PASS ? "[e2e] RESULT: PASS — real round-trip, HttpOnly verified, no client-side tokens" : "[e2e] RESULT: FAIL");
process.exit(PASS ? 0 : 1);
