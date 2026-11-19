import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));
vi.mock("../../../../../src/components/storefront/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../src/components/storefront/storefront")>()),
  fetchCreatorHub: vi.fn(async () => ({
    creator: { handle: "e2e_live_creator", display_name: "E2E Live Creator", products: [] },
    origin: "https://expanpress.com",
  })),
}));

import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import ThankYouPage from "../page";

async function render() {
  return renderToStaticMarkup(await ThankYouPage({ params: Promise.resolve({ handle: "e2e_live_creator" }) }));
}

describe("thank-you page (/books/{handle}/thanks)", () => {
  it("says the download link is on its way by email", async () => {
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain("Thank you, your download link is on its way by email");
  });

  it("shows the support address from the settings registry", async () => {
    const html = await render();
    expect(GLOBAL.email.reply_to).toBe("support@expanpress.com");
    expect(html).toContain(`contact ${GLOBAL.email.reply_to}.`);
    expect(html).toContain(`Support: ${GLOBAL.email.reply_to}`);
  });

  it("links back to the creator's books", async () => {
    const html = await render();
    expect(html).toContain('href="/books/e2e_live_creator"');
    expect(html).toMatch(/Back to E2E Live Creator(&#x27;|')s books/);
  });

  it("sends the logo to the B2C landing, not the B2B root", async () => {
    const html = await render();
    expect(html).toContain(`href="${GLOBAL.storefront.b2c_landing_url}"`);
    expect(html).not.toMatch(/href="\/"/);
  });
});
