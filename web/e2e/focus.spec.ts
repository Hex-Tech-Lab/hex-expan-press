/** Keyboard focus is visible: tabbing to a link/button paints an outline. */
import { test, expect } from "@playwright/test";

for (const path of ["/", "/c/retirearly500k/500k-playbook/", "/creator/signin"]) {
  test(`focus ring visible on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, boxShadow: s.boxShadow };
    });
    expect(outline).not.toBeNull();
    expect(outline!.style !== "none" && outline!.width >= 2 || outline!.boxShadow !== "none").toBe(true);
  });
}
