/**
 * Wave 5.1 E2E — real auth round-trip driven locally (no external QA).
 * Uses the Supabase ADMIN API (service key) ONLY to mint a magic-link for a
 * QA user — the sign-in itself flows through the REAL Next.js surface:
 * action_link → Supabase verify → /auth/callback (PKCE exchange) → HttpOnly
 * cookies → dashboard RSC with hydrated data.
 *
 * Run: node scripts/e2e-auth.mjs <port>   (expects `next start` on that port)
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const webRequire = createRequire(fileURLToPath(new URL("../web/package.json", import.meta.url)));
const { chromium } = webRequire("playwright-core");
import { readFileSync } from "node:fs";

const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SECRET_KEY;
const QA_EMAIL = "qa-auth-roundtrip@expanpress.com";
const PORT = process.argv[2] ?? "3888";
const BASE = `http://localhost:${PORT}`;

const adminHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" };

async function ensureUser() {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(QA_EMAIL)}`, { headers: adminHeaders });
  const found = (await list.json())?.users?.[0];
  if (found) return found;
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email: QA_EMAIL, email_confirm: true }),
  });
  const body = await created.json();
  if (!created.ok) throw new Error(`createUser failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function mintMagicLink() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      type: "magiclink",
      email: QA_EMAIL,
      options: { redirectTo: `${BASE}/auth/callback` },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`generate_link failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.action_link;
}

const user = await ensureUser();
console.log("[e2e] user ready:", user.id);
const actionLink = await mintMagicLink();
console.log("[e2e] magic link minted");

const browser = await chromium.launch({
  executablePath: "/home/kellyb_dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const page = await context.newPage();

const setCookieHeaders = [];
page.on("response", async (res) => {
  try {
    const all = await res.allHeaders();
    for (const [name, value] of Object.entries(all)) {
      if (name.toLowerCase() === "set-cookie") setCookieHeaders.push({ url: res.url(), value });
    }
  } catch (err) {
    console.warn("[e2e] response header read failed", err?.message ?? err);
  }
});

await page.goto(actionLink, { waitUntil: "domcontentloaded" });
await page.waitForURL("**/creator/dashboard**", { timeout: 20000 }).catch(() => {});
const finalUrl = page.url();
console.log("[e2e] final URL:", finalUrl);

const cookies = await context.cookies(`${BASE}`);
const authCookies = cookies.filter((c) => c.name.startsWith("sb-portal-auth"));
console.log("[e2e] portal auth cookies:", authCookies.map((c) => c.name).join(", ") || "NONE");

const httpOnlyProof = setCookieHeaders.filter((h) => /sb-portal-auth/.test(h.value));
let httpOnlyAll = httpOnlyProof.length > 0;
for (const h of httpOnlyProof) {
  const isHttpOnly = /httponly/i.test(h.value);
  const isSecure = /secure/i.test(h.value);
  console.log(`[e2e] Set-Cookie on ${new URL(h.url).pathname}: httpOnly=${isHttpOnly} secure=${isSecure} name=${h.value.split("=")[0]}`);
  if (!isHttpOnly) httpOnlyAll = false;
}

const dashboardRenders = finalUrl.includes("/creator/dashboard");
let bodyHasDashboard = false;
if (dashboardRenders) {
  bodyHasDashboard = (await page.textContent("body"))?.includes("Your creator dashboard") ?? false;
}

console.log("[e2e] dashboard reached:", dashboardRenders, "| renders heading:", bodyHasDashboard);
console.log("[e2e] HttpOnly on every sb-portal-auth Set-Cookie:", httpOnlyAll, `(${httpOnlyProof.length} headers)`);

await browser.close();

const PASS = dashboardRenders && bodyHasDashboard && httpOnlyAll && httpOnlyProof.length > 0;
console.log(PASS ? "[e2e] RESULT: PASS — full round-trip with HttpOnly cookies verified" : "[e2e] RESULT: FAIL — see lines above");
process.exit(PASS ? 0 : 1);
