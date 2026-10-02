/**
 * WCAG 2.1/2.2 AA scan (axe-core) of the buyer page and every creator
 * surface, against the same hermetic mock backend as the funnel test.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { E2E, MOCK_URL } from "./constants";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`),
  }));
  if (summary.length) console.log(`[a11y] ${label}\n${JSON.stringify(summary, null, 2)}`);
  return summary;
}

// Phone width too: tap-target (target-size) and reflow issues show up there.
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
test.describe(`${viewport.width}px`, () => {
test.use({ viewport });

test.beforeEach(async () => {
  await fetch(`${MOCK_URL}/__reset`, { method: "POST" });
});

test("public pages have no WCAG AA violations", async ({ page }) => {
  const results: Record<string, unknown[]> = {};
  for (const path of ["/", "/c/retirearly500k/", "/c/retirearly500k/500k-playbook/", "/creator/signin"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    results[path] = await scan(page, path);
  }
  expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, []])));
});

test("creator portal has no WCAG AA violations", async ({ page }) => {
  await page.goto(`/auth/callback?token_hash=${E2E.magicLinkTokenHash}&type=magiclink`);
  await expect(page).toHaveURL(/\/creator\/dashboard/);
  const results: Record<string, unknown[]> = {};
  for (const path of ["/creator/dashboard", "/creator/review", "/creator/consents"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200); // entrance animations settle (opacity affects contrast)
    results[path] = await scan(page, path);
  }
  expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, []])));
});
});
}
